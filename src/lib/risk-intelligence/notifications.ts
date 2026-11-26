/**
 * Outbound governance notifications for Shared Agent Risk Intelligence.
 *
 * Uses the single existing transactional email provider and records durable,
 * metadata-only delivery evidence. Notification failure never changes the
 * underlying audit or execution record. No identity, subject key or other
 * business's report is ever placed in a message.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { appBaseUrl, sendTransactionalEmail } from "@/lib/email/resend";
import { riskGovernanceNotificationEmail } from "@/lib/email/templates";

export const RISK_NOTIFICATION_TEMPLATE_VERSION = "risk-governance-2026.12";
export const RISK_NOTIFICATION_MAX_ATTEMPTS = 3;

export type RiskNotificationEvent =
  | "signal_disputed"
  | "signal_challenged"
  | "signal_withdrawn"
  | "signal_review_required"
  | "agreement_executed"
  | "legal_hold_review_due"
  | "notice_delivered";

const COPY: Record<
  RiskNotificationEvent,
  { heading: string; intro: string; referenceLabel: string; path: string; actionLabel: string }
> = {
  signal_disputed: {
    heading: "A shared signal is under dispute",
    intro: "A signal connected to your business requires review. Sign in to MaaCash to see the case in your workspace.",
    referenceLabel: "Signal reference",
    path: "/admin/anomalies",
    actionLabel: "Open the review queue",
  },
  signal_challenged: {
    heading: "A shared signal has been challenged",
    intro: "A challenge has been raised about a signal connected to your business. No further disclosure is made while it is frozen.",
    referenceLabel: "Signal reference",
    path: "/admin/anomalies",
    actionLabel: "Open the review queue",
  },
  signal_withdrawn: {
    heading: "A signal has been withdrawn",
    intro: "A signal connected to your business has been withdrawn. Your own records are unchanged.",
    referenceLabel: "Signal reference",
    path: "/admin/anomalies",
    actionLabel: "Open the review queue",
  },
  signal_review_required: {
    heading: "A shared signal requires review",
    intro: "A governance decision has been recorded on a signal connected to your business. Sign in to review the outcome.",
    referenceLabel: "Signal reference",
    path: "/admin/anomalies",
    actionLabel: "Open the review queue",
  },
  agreement_executed: {
    heading: "Your MaaCash agreement has been executed",
    intro: "An executed agreement is available in your MaaCash workspace. Sign in to read or download the exact version you accepted.",
    referenceLabel: "Agreement reference",
    path: "/admin/agreements",
    actionLabel: "Open your agreements",
  },
  legal_hold_review_due: {
    heading: "A legal hold needs privacy review",
    intro: "A scoped legal hold has reached its review point. Sign in to the restricted privacy review area.",
    referenceLabel: "Hold reference",
    path: "/admin/privacy-review",
    actionLabel: "Open privacy review",
  },
  notice_delivered: {
    heading: "Your employee privacy notice",
    intro: "A privacy notice about MaaCash Shared Agent Risk Intelligence has been issued to you. Read it and record your acknowledgement during onboarding.",
    referenceLabel: "Notice version",
    path: "/worker/privacy-notice",
    actionLabel: "Read the notice",
  },
};

export function recipientHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export interface RiskNotificationInput {
  eventType: RiskNotificationEvent;
  scopeType: "signal" | "subject" | "agreement" | "notice" | "rights";
  scopeId: string;
  tenantId?: string | null;
  recipientUserId: string;
  reference: string;
  actorId: string;
}

export interface RiskNotificationOutcome {
  status: "sent" | "skipped" | "failed" | "duplicate" | "no_recipient";
  deliveryId?: string;
}

async function auditNotification(
  input: RiskNotificationInput,
  outcome: string,
  deliveryId?: string
): Promise<void> {
  await createAuditLog({
    userId: input.actorId,
    tenantId: input.tenantId ?? null,
    action: `risk_notification.${input.eventType}`,
    entityType: "governanceDocumentDelivery",
    entityId: deliveryId ?? input.scopeId,
    details: {
      eventType: input.eventType,
      outcome,
      templateVersion: RISK_NOTIFICATION_TEMPLATE_VERSION,
      financialMutation: false,
    },
  });
}

/** Send one idempotent governance notification and persist its evidence. */
export async function sendRiskNotification(
  input: RiskNotificationInput
): Promise<RiskNotificationOutcome> {
  const recipient = await db.user.findUnique({
    where: { id: input.recipientUserId },
    select: { id: true, email: true },
  });
  if (!recipient) {
    await auditNotification(input, "no_recipient");
    return { status: "no_recipient" };
  }
  const hash = recipientHash(recipient.email);
  const copy = COPY[input.eventType];

  let deliveryId: string;
  try {
    const row = await db.governanceDocumentDelivery.create({
      data: {
        eventType: input.eventType,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        tenantId: input.tenantId ?? null,
        recipientUserId: recipient.id,
        recipientHash: hash,
        templateVersion: RISK_NOTIFICATION_TEMPLATE_VERSION,
        status: "queued",
      },
      select: { id: true },
    });
    deliveryId = row.id;
  } catch {
    // Unique key collision: this event was already delivered or queued for
    // this recipient. Never create a second message.
    await auditNotification(input, "duplicate");
    return { status: "duplicate" };
  }

  const template = riskGovernanceNotificationEmail({
    ...copy,
    reference: input.reference.slice(0, 80),
    actionUrl: `${appBaseUrl()}${copy.path}`,
  });
  const result = await sendTransactionalEmail({
    to: recipient.email,
    subject: template.subject,
    html: template.html,
    text: template.text,
    tag: input.eventType,
  });

  const status = result.skipped ? "skipped" : result.ok ? "sent" : "failed";
  const history = JSON.stringify([
    {
      at: new Date().toISOString(),
      attempt: 1,
      status,
      providerStatus: result.status ?? null,
      skipped: result.skipped === true,
    },
  ]);
  await db.governanceDocumentDelivery.update({
    where: { id: deliveryId },
    data: {
      status,
      sentAt: result.ok && !result.skipped ? new Date() : null,
      providerMessageId: result.providerMessageId ?? null,
      lastError: result.ok
        ? null
        : result.retryable
          ? "retryable"
          : `provider_status_${result.status ?? "unavailable"}`,
      retryHistory: history,
    },
  });
  await auditNotification(input, status, deliveryId);
  return { status, deliveryId };
}

/**
 * Retry only failed deliveries explicitly marked retryable. The unique key
 * keeps a retry as an UPDATE, never a second execution or agreement row.
 */
export async function retryFailedRiskNotifications(
  limit = 25
): Promise<{ retried: number; sent: number }> {
  const rows = await db.governanceDocumentDelivery.findMany({
    where: { status: "failed", lastError: "retryable", attempts: { lt: RISK_NOTIFICATION_MAX_ATTEMPTS } },
    take: Math.min(Math.max(1, limit), 100),
  });
  let sent = 0;
  for (const row of rows) {
    if (!row.recipientUserId) continue;
    const recipient = await db.user.findUnique({
      where: { id: row.recipientUserId },
      select: { email: true },
    });
    if (!recipient) continue;
    const copy = COPY[row.eventType as RiskNotificationEvent];
    if (!copy) continue;
    const template = riskGovernanceNotificationEmail({
      ...copy,
      reference: row.scopeId.slice(0, 80),
      actionUrl: `${appBaseUrl()}${copy.path}`,
    });
    const result = await sendTransactionalEmail({
      to: recipient.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
      tag: row.eventType,
    });
    const history = (() => {
      try {
        const parsed = JSON.parse(row.retryHistory ?? "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    history.push({
      at: new Date().toISOString(),
      attempt: row.attempts + 1,
      status: result.ok ? "sent" : "failed",
      providerStatus: result.status ?? null,
      skipped: result.skipped === true,
    });
    await db.governanceDocumentDelivery.update({
      where: { id: row.id },
      data: {
        attempts: row.attempts + 1,
        status: result.ok ? "sent" : "failed",
        sentAt: result.ok && !result.skipped ? new Date() : null,
        providerMessageId: result.providerMessageId ?? row.providerMessageId,
        lastError: result.ok
          ? null
          : result.retryable
            ? "retryable"
            : `provider_status_${result.status ?? "unavailable"}`,
        retryHistory: JSON.stringify(history),
      },
    });
    if (result.ok) sent += 1;
  }
  return { retried: rows.length, sent };
}
