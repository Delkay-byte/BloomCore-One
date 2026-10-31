import { db } from "./db";

interface AuditParams {
  userId: string;
  /** Owning tenant — stamp every tenant-scoped audit row so tenant-scoped
   *  audit lists (where tenantId is the filter) can see it. */
  tenantId?: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Security-relevant audit actions:
 *
 * Authentication:
 *   auth.login                 — successful login
 *   auth.login_failed          — failed login attempt
 *   auth.logout                — explicit logout
 *   auth.session_timeout       — inactivity timeout
 *   auth.session_background    — background timeout
 *   auth.session_absolute      — absolute session expiry
 *   auth.reauth_success        — step-up authentication success
 *   auth.reauth_failed         — step-up authentication failure
 *   auth.password_changed      — user changed own password
 *   auth.first_login_password_changed — forced first-login password change
 *
 * User management:
 *   user.worker_created        — admin created a worker
 *   user.worker_updated        — admin updated a worker
 *   user.worker_activated      — admin activated a worker
 *   user.worker_deactivated    — admin deactivated a worker
 *   user.password_reset        — admin reset a user's password
 *   user.module_assignment_changed — admin changed module capabilities
 *
 * Workspace:
 *   auth.workspace_selected    — dual-role user chose workspace
 *   auth.workspace_switched    — dual-role user switched workspace
 *
 * Financial:
 *   daily_account.created      — worker created daily account
 *   daily_account.submitted    — worker submitted daily account
 *   daily_account.reviewed     — admin reviewed daily account
 *   susu.contribution_recorded — contribution recorded
 *   susu.withdrawal_processed  — withdrawal processed
 *   susu.remittance_recorded   — remittance recorded
 *   susu.customer_created      — customer created
 *   susu.customer_updated      — customer updated
 *   susu.collector_created     — collector created
 *   susu.customer_assigned_to_collector
 *   susu.customer_removed_from_collector
 *
 * Locations:
 *   location.created / updated / activated / deactivated
 */
export type SecurityAuditAction = string;

/** Well-known security actions for type-safe usage. */
export const AUDIT_ACTIONS = {
  LOGIN: "auth.login",
  LOGIN_FAILED: "auth.login_failed",
  LOGOUT: "auth.logout",
  SESSION_TIMEOUT: "auth.session_timeout",
  SESSION_BACKGROUND: "auth.session_background",
  SESSION_ABSOLUTE: "auth.session_absolute",
  REAUTH_SUCCESS: "auth.reauth_success",
  REAUTH_FAILED: "auth.reauth_failed",
  PASSWORD_CHANGED: "auth.password_changed",
  FIRST_LOGIN_PASSWORD_CHANGED: "auth.first_login_password_changed",
  WORKER_CREATED: "user.worker_created",
  WORKER_UPDATED: "user.worker_updated",
  WORKER_ACTIVATED: "user.worker_activated",
  WORKER_DEACTIVATED: "user.worker_deactivated",
  PASSWORD_RESET: "user.password_reset",
  MODULE_ASSIGNMENT_CHANGED: "user.module_assignment_changed",
  WORKSPACE_SELECTED: "auth.workspace_selected",
  WORKSPACE_SWITCHED: "auth.workspace_switched",
} as const;

/**
 * Resolve the owning tenant for an audit row. The acting user (or customer)
 * determines the tenant — the same fail-closed identity the actions themselves
 * used. An explicit tenantId param always wins.
 */
async function resolveAuditTenantId(
  userId: string
): Promise<string | null | undefined> {
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    if (user) return user.tenantId;
    const customer = await db.customer.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    return customer?.tenantId ?? null;
  } catch {
    return null;
  }
}

export async function createAuditLog({
  userId,
  tenantId: explicitTenantId,
  action,
  entityType,
  entityId,
  details,
  ipAddress,
}: AuditParams) {
  try {
    const tenantId = explicitTenantId ?? (await resolveAuditTenantId(userId));
    await db.auditLog.create({
      data: {
        userId,
        tenantId: tenantId ?? undefined,
        action,
        entityType,
        entityId,
        details: details ? JSON.stringify(details) : undefined,
        ipAddress,
      },
    });
  } catch (error) {
    // Audit log failure must never break the application.
    // In production, this should be routed to external monitoring.
    console.error("[SECURITY] Audit log failed:", action, error);
  }
}
