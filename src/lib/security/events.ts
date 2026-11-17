import { db } from "@/lib/db";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import type { SecurityEvent } from "./log";
import { logSecurityEvent } from "./log";

/**
 * Residual risk C — security event retention and alerting.
 *
 * Security events are persisted to their own table with a 365-day retention
 * window. Financial and business audit history lives in `AuditLog` and
 * `PlatformAuditLog` and is NEVER touched here: the retention sweep deletes
 * `SecurityEventRecord` rows only.
 *
 * Critical events additionally raise a durable in-app alert (shown in the
 * workspace) and, when email delivery is configured, notify the responsible
 * administrators through the existing Resend integration.
 *
 * Every write is best effort: a logging failure must never fail or block the
 * security decision it describes.
 */

export const SECURITY_EVENT_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Events that always alert the responsible administrators. */
const CRITICAL_EVENTS = new Set([
  "auth.password_changed",
  "auth.email_changed",
  "recovery.code_issued",
  "recovery.code_redeemed",
  "mfa.disabled",
  "mfa.recovery_code_used",
  "mfa.recovery_codes_regenerated",
  "platform.mfa_recovery_applied",
  "platform.mfa_recovery_approved",
  "platform.mfa_recovery_requested",
  "platform.admin_access_recovery",
  "tenant.admin_access_reset",
  "finance.dual_control_exception",
  "finance.approval_requested",
  "finance.approval_rejected",
  "security.retention_pruned",
]);

/** Events worth keeping as warnings (failed or blocked security decisions). */
function isWarning(event: SecurityEvent): boolean {
  return event.outcome !== "success";
}

export type SecuritySeverity = "info" | "warning" | "critical";

/**
 * Security-event persistence is disabled under Vitest by default so the unit
 * suite keeps its single-connection SQLite behaviour; a test that exercises
 * retention or alerts opts in with SECURITY_EVENT_PERSIST=force.
 */
function persistenceEnabled(): boolean {
  if (process.env.VITEST && process.env.SECURITY_EVENT_PERSIST !== "force") {
    return false;
  }
  return true;
}

export function severityForEvent(event: SecurityEvent): SecuritySeverity {
  if (CRITICAL_EVENTS.has(event.event)) return "critical";
  return isWarning(event) ? "warning" : "info";
}

/**
 * Persist one security event. Never throws and never includes a token, secret,
 * password, MFA code or raw identifier.
 */
export async function persistSecurityEvent(event: SecurityEvent): Promise<void> {
  if (!persistenceEnabled()) return;
  try {
    await db.securityEventRecord.create({
      data: {
        event: event.event.slice(0, 120),
        outcome: event.outcome,
        severity: severityForEvent(event),
        actorType: event.actorType ?? "anonymous",
        actorId: event.actorId ? event.actorId.slice(0, 120) : null,
        tenantId: event.tenantId ? event.tenantId.slice(0, 120) : null,
        ipHash: null,
        route: event.route ? event.route.slice(0, 120) : null,
        reason: event.reason ? event.reason.slice(0, 120) : null,
        detail: event.detail ? event.detail.slice(0, 120) : null,
      },
    });
  } catch (error) {
    // A security log write must never fail a login, a payment or a reversal.
    console.error(
      "[security-events] persist failed",
      error instanceof Error ? error.name : "UnknownError"
    );
  }
}

export type AlertAudience = "platform" | "tenant_admin" | "subject";

/**
 * Record a security event in both places that matter: the structured stdout
 * line (immediate operational visibility) and the retained security-event
 * table. Critical events also raise a durable alert.
 *
 * Call this from request paths, never from inside a database transaction: the
 * event write uses its own connection.
 */
export function recordSecurityEvent(event: SecurityEvent): void {
  logSecurityEvent(event);
  if (!persistenceEnabled()) return;
  void persistSecurityEvent(event);
  const severity = severityForEvent(event);
  if (severity !== "critical") return;

  const audience: AlertAudience =
    event.actorType === "platform_admin"
      ? "platform"
      : event.tenantId
        ? "tenant_admin"
        : "subject";
  const subjectType =
    audience === "platform"
      ? "platform"
      : event.actorType === "customer"
        ? "customer"
        : event.actorType === "user"
          ? "user"
          : null;

  void raiseSecurityAlert({
    event: event.event,
    severity: "critical",
    title: event.event.replace(/[._]/g, " "),
    body:
      `Security event: ${event.event} (${event.outcome}).` +
      (event.route ? ` Route: ${event.route}.` : "") +
      (event.reason ? ` Reason: ${event.reason}.` : "") +
      " Review the security log and confirm the change was expected.",
    audience,
    tenantId: event.tenantId ?? null,
    subjectType,
    subjectId: event.actorId ?? null,
    dedupeKey:
      `critical:${event.event}:${event.actorId ?? "anon"}:${event.route ?? ""}:${event.reason ?? ""}:${new Date()
        .toISOString()
        .slice(0, 16)}`,
  });
}

export interface SecurityAlertInput {
  event: string;
  severity: Extract<SecuritySeverity, "warning" | "critical">;
  title: string;
  body: string;
  audience: AlertAudience;
  tenantId?: string | null;
  subjectType?: "user" | "customer" | "platform" | null;
  subjectId?: string | null;
  /** Stable key so a repeated event cannot spam the queue. */
  dedupeKey?: string | null;
  /** Send email for critical alerts (default true). */
  email?: boolean;
}

interface AlertRecipient {
  email: string;
  name: string;
}

async function recipientsFor(input: SecurityAlertInput): Promise<AlertRecipient[]> {
  if (input.audience === "platform") {
    const admins = await db.platformSuperAdmin.findMany({
      where: { status: "active" },
      select: { email: true, fullName: true },
    });
    return admins.map((row) => ({ email: row.email, name: row.fullName }));
  }

  if (input.audience === "tenant_admin") {
    if (!input.tenantId) return [];
    const admins = await db.user.findMany({
      where: { tenantId: input.tenantId, role: "admin", status: "active" },
      select: { email: true, fullName: true },
    });
    return admins.map((row) => ({ email: row.email, name: row.fullName }));
  }

  if (input.subjectType === "platform" && input.subjectId) {
    const row = await db.platformSuperAdmin.findUnique({
      where: { id: input.subjectId },
      select: { email: true, fullName: true },
    });
    return row ? [{ email: row.email, name: row.fullName }] : [];
  }
  if (input.subjectType === "user" && input.subjectId) {
    const row = await db.user.findUnique({
      where: { id: input.subjectId },
      select: { email: true, fullName: true },
    });
    return row ? [{ email: row.email, name: row.fullName }] : [];
  }
  if (input.subjectType === "customer" && input.subjectId) {
    const row = await db.customer.findUnique({
      where: { id: input.subjectId },
      select: { email: true, fullName: true },
    });
    return row?.email ? [{ email: row.email, name: row.fullName }] : [];
  }
  return [];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Create a durable in-app security alert and email the responsible people.
 * Returns the alert id (or null when it was deduplicated or could not be
 * stored). Never throws.
 */
export async function raiseSecurityAlert(
  input: SecurityAlertInput
): Promise<string | null> {
  let alertId: string | null = null;
  try {
    const existing = input.dedupeKey
      ? await db.securityAlert.findUnique({
          where: { dedupeKey: input.dedupeKey },
          select: { id: true },
        })
      : null;
    if (existing) return existing.id;

    const created = await db.securityAlert.create({
      data: {
        tenantId: input.tenantId ?? null,
        audience: input.audience,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        severity: input.severity,
        event: input.event.slice(0, 120),
        title: input.title.slice(0, 160),
        body: input.body.slice(0, 800),
        dedupeKey: input.dedupeKey ?? null,
      },
      select: { id: true },
    });
    alertId = created.id;
  } catch (error) {
    console.error(
      "[security-alert] store failed",
      error instanceof Error ? error.name : "UnknownError"
    );
    return null;
  }

  const shouldEmail = input.email !== false && input.severity === "critical";
  if (!shouldEmail) {
    await db.securityAlert
      .update({ where: { id: alertId }, data: { emailStatus: "skipped" } })
      .catch(() => {});
    return alertId;
  }

  try {
    const recipients = await recipientsFor(input);
    if (recipients.length === 0) {
      await db.securityAlert
        .update({ where: { id: alertId }, data: { emailStatus: "skipped" } })
        .catch(() => {});
      return alertId;
    }
    const subject = `[MaaCash security] ${input.title}`.slice(0, 160);
    const text = `${input.body}\n\nThis alert is recorded in the MaaCash security log. Sign in to review it.`;
    const html = `<p>${escapeHtml(input.body)}</p><p>This alert is recorded in the MaaCash security log. Sign in to review it.</p>`;
    let anySent = false;
    let anyFailed = false;
    for (const recipient of recipients) {
      const result = await sendTransactionalEmail({
        to: recipient.email,
        subject,
        text,
        html,
        tag: "security-alert",
      });
      if (result.ok) anySent = true;
      else if (!result.skipped) anyFailed = true;
    }
    await db.securityAlert.update({
      where: { id: alertId },
      data: { emailStatus: anySent ? "sent" : anyFailed ? "failed" : "skipped" },
    });
  } catch (error) {
    console.error(
      "[security-alert] email failed",
      error instanceof Error ? error.name : "UnknownError"
    );
    await db.securityAlert
      .update({ where: { id: alertId }, data: { emailStatus: "failed" } })
      .catch(() => {});
  }
  return alertId;
}

/**
 * Apply the approved 365-day security-event retention policy.
 *
 * Only `SecurityEventRecord` and `SecurityAlert` rows are removed. Financial
 * audit history (`AuditLog`, `PlatformAuditLog`) is untouched by design.
 */
export async function pruneSecurityEvents(
  now: Date = new Date()
): Promise<{ events: number; alerts: number }> {
  const cutoff = new Date(now.getTime() - SECURITY_EVENT_RETENTION_DAYS * DAY_MS);
  const events = await db.securityEventRecord.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  const alerts = await db.securityAlert.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  // The retention operation itself is auditable, in the platform audit trail.
  await createPlatformAuditLog({
    action: "security.retention_pruned",
    entityType: "SecurityEventRecord",
    reason: `retention_${SECURITY_EVENT_RETENTION_DAYS}_days`,
    details: {
      cutoff: cutoff.toISOString(),
      securityEvents: events.count,
      securityAlerts: alerts.count,
      financialAuditRetained: true,
    },
  });

  return { events: events.count, alerts: alerts.count };
}
