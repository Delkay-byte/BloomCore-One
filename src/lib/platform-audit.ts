import { db } from "./db";

/**
 * Platform-level audit trail.
 *
 * Deliberately separate from the tenant AuditLog table so the two security
 * boundaries never mix: a tenant administrator must never be able to read
 * platform operator history, and platform history must survive tenant
 * archival. tenantId here is a plain string, not a foreign key, for exactly
 * that reason.
 *
 * Never store secrets: no passwords, hashes, tokens, reset links or cookies.
 */

export const PLATFORM_AUDIT_ACTIONS = {
  PLATFORM_LOGIN: "platform.login",
  PLATFORM_LOGIN_FAILED: "platform.login_failed",
  PLATFORM_LOGOUT: "platform.logout",
  PLATFORM_PASSWORD_CHANGED: "platform.password_changed",
  // OIDC SSO (feature-flagged; see docs/SSO-INTEGRATION.md)
  PLATFORM_SSO_START: "platform.sso_start",
  PLATFORM_SSO_SUCCESS: "platform.sso_success",
  PLATFORM_SSO_DENIED: "platform.sso_denied",
  PLATFORM_SSO_LINK_CREATED: "platform.sso_link_created",
  PLATFORM_SSO_LINK_FAILED: "platform.sso_link_failed",
  PLATFORM_SSO_SESSION_REVOKED: "platform.sso_session_revoked",
  TENANT_CREATED: "tenant.created",
  TENANT_ACTIVATED: "tenant.activated",
  TENANT_SUSPENDED: "tenant.suspended",
  TENANT_REACTIVATED: "tenant.reactivated",
  TENANT_ARCHIVED: "tenant.archived",
  TENANT_PROFILE_UPDATED: "tenant.profile_updated",
  TENANT_MODULES_CHANGED: "tenant.modules_changed",
  TENANT_ADMIN_PROVISIONED: "tenant.admin_provisioned",
  TENANT_ADMIN_RECOVERY_INITIATED: "tenant.admin_recovery_initiated",
  TENANT_ONBOARDING_UPDATED: "tenant.onboarding_updated",
} as const;

export type PlatformAuditAction =
  (typeof PLATFORM_AUDIT_ACTIONS)[keyof typeof PLATFORM_AUDIT_ACTIONS];

export interface PlatformAuditParams {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  tenantId?: string | null;
  tenantCode?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  reason?: string | null;
  ipAddress?: string | null;
}

/**
 * Write a platform audit event.
 *
 * Audit failure must never break the operation it describes (a suspended
 * tenant still needs to be suspended even if the log write fails), so errors
 * are caught and reported to stderr rather than thrown.
 */
export async function createPlatformAuditLog({
  actorId,
  actorEmail,
  action,
  tenantId,
  tenantCode,
  entityType,
  entityId,
  details,
  reason,
  ipAddress,
}: PlatformAuditParams): Promise<void> {
  try {
    await db.platformAuditLog.create({
      data: {
        actorId: actorId ?? null,
        actorEmail: actorEmail ?? null,
        action,
        tenantId: tenantId ?? null,
        tenantCode: tenantCode ?? null,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        details: details ? JSON.stringify(details) : null,
        reason: reason ?? null,
        ipAddress: ipAddress ?? null,
      },
    });
  } catch (error) {
    console.error("[PLATFORM] Audit log failed:", action, error);
  }
}

/** Read platform audit history, newest first, with server-side pagination. */
export async function getPlatformAuditLogs(options: {
  page?: number;
  limit?: number;
  tenantId?: string;
  action?: string;
}) {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  const where: Record<string, unknown> = {};
  if (options.tenantId) where.tenantId = options.tenantId;
  if (options.action) where.action = options.action;

  const [logs, total] = await Promise.all([
    db.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.platformAuditLog.count({ where }),
  ]);

  return { logs, total, page, limit, pages: Math.ceil(total / limit) };
}
