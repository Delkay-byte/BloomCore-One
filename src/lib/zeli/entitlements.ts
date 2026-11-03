import { db } from "@/lib/db";
import { getTenantContext, requireTenantAdmin, type TenantContext } from "@/lib/tenant";
import { assertZeliAvailable } from "./availability";

/**
 * Zeli Business Intelligence entitlement.
 *
 * The application already represents a business's product capability on the
 * tenant record (momoEnabled / susuEnabled) and uses the tenant record as the
 * authority for module access. Zeli Analytics follows the same shape, but its
 * lifecycle (trial, expiry, suspension, revocation, audit) needs a record of
 * its own, so it lives in `ZeliEntitlement` with the feature key
 * `zeli_analytics`.
 *
 * There is deliberately no second subscription or billing model. The platform
 * control centre writes this table under the platform audit trail. If add-on
 * billing is introduced later it must write the same table, not a parallel one.
 */

export const ZELI_ANALYTICS_FEATURE = "zeli_analytics";

/** Roles that may ever use the tenant analytics workspace. */
export const ZELI_ANALYTICS_ROLES = ["admin"] as const;

export type ZeliEntitlementStatus = "active" | "suspended" | "revoked";

export interface ZeliEntitlementRecord {
  id: string;
  tenantId: string;
  featureKey: string;
  status: string;
  source: string;
  startsAt: Date;
  expiresAt: Date | null;
  suspendedAt: Date | null;
  revokedAt: Date | null;
}

export type ZeliDenialReason =
  | "no_entitlement"
  | "not_started"
  | "expired"
  | "suspended"
  | "revoked"
  | "role_not_permitted"
  | "tenant_unavailable"
  | "unknown_status";

export interface ZeliAccessDecision {
  allowed: boolean;
  reason: ZeliDenialReason | null;
  status: ZeliEntitlementStatus | "none";
  expiresAt: string | null;
  source: string | null;
  entitlementId: string | null;
}

const DENIED = (reason: ZeliDenialReason, status: ZeliAccessDecision["status"] = "none"): ZeliAccessDecision => ({
  allowed: false,
  reason,
  status,
  expiresAt: null,
  source: null,
  entitlementId: null,
});

/**
 * Pure access decision. Kept free of database access so the matrix can be
 * tested exhaustively and reused by the platform dashboard.
 */
export function evaluateZeliAccess(params: {
  role: string;
  entitlement: ZeliEntitlementRecord | null;
  now?: Date;
}): ZeliAccessDecision {
  const now = params.now ?? new Date();
  if (!ZELI_ANALYTICS_ROLES.includes(params.role as (typeof ZELI_ANALYTICS_ROLES)[number])) {
    return DENIED("role_not_permitted");
  }
  const entitlement = params.entitlement;
  if (!entitlement) return DENIED("no_entitlement");

  const base = {
    expiresAt: entitlement.expiresAt?.toISOString() ?? null,
    source: entitlement.source,
    entitlementId: entitlement.id,
  };

  if (entitlement.startsAt.getTime() > now.getTime()) {
    return { ...DENIED("not_started"), ...base, status: "active" };
  }
  if (entitlement.status === "revoked") {
    return { allowed: false, reason: "revoked", ...base, status: "revoked" };
  }
  if (entitlement.status === "suspended") {
    return { allowed: false, reason: "suspended", ...base, status: "suspended" };
  }
  if (entitlement.status !== "active") {
    return { allowed: false, reason: "unknown_status", ...base, status: "none" };
  }
  if (entitlement.expiresAt && entitlement.expiresAt.getTime() <= now.getTime()) {
    return { allowed: false, reason: "expired", ...base, status: "active" };
  }
  return { allowed: true, reason: null, ...base, status: "active" };
}

/** Read the tenant's entitlement. Tenant id must come from the server session. */
export async function getZeliEntitlement(
  tenantId: string
): Promise<ZeliEntitlementRecord | null> {
  if (!tenantId) return null;
  const row = await db.zeliEntitlement.findUnique({
    where: {
      tenantId_featureKey: {
        tenantId,
        featureKey: ZELI_ANALYTICS_FEATURE,
      },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    featureKey: row.featureKey,
    status: row.status,
    source: row.source,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    suspendedAt: row.suspendedAt,
    revokedAt: row.revokedAt,
  };
}

/** Resolve access for an already-authorized tenant context. */
export async function getZeliAnalyticsAccess(
  ctx: TenantContext
): Promise<ZeliAccessDecision> {
  if (ctx.role !== "admin") return DENIED("role_not_permitted");
  const entitlement = await getZeliEntitlement(ctx.tenantId);
  return evaluateZeliAccess({ role: ctx.role, entitlement });
}

/**
 * Non-redirecting access check for API routes and server actions. Returns null
 * unless the caller is a tenant administrator with a live entitlement.
 */
export async function getApiZeliAnalyticsContext(): Promise<TenantContext | null> {
  try {
    await assertZeliAvailable();
  } catch {
    return null;
  }
  const ctx = await getTenantContext("admin");
  if (!ctx || ctx.role !== "admin") return null;
  const access = await getZeliAnalyticsAccess(ctx);
  if (!access.allowed) return null;
  return ctx;
}

/**
 * Page/action guard. A tenant administrator without an entitlement is sent to
 * the upgrade screen; any other role is sent to the standard unauthorized
 * screen. No analytics query runs before this resolves.
 */
export async function requireZeliAnalyticsContext(): Promise<TenantContext> {
  await assertZeliAvailable();
  const ctx = await requireTenantAdmin();
  const access = await getZeliAnalyticsAccess(ctx);
  if (!access.allowed) {
    const { redirect } = await import("next/navigation");
    redirect(`/admin/zeli-analytics/upgrade?reason=${access.reason ?? "no_entitlement"}`);
  }
  return ctx;
}

/** Human-readable denial copy. Never reveals another tenant's entitlement. */
export function zeliDenialMessage(reason: ZeliDenialReason | null): string {
  switch (reason) {
    case "no_entitlement":
      return "Zeli Business Intelligence is not enabled for this business.";
    case "not_started":
      return "This Zeli Business Intelligence subscription has not started yet.";
    case "expired":
      return "This Zeli Business Intelligence subscription has expired.";
    case "suspended":
      return "This Zeli Business Intelligence subscription is suspended.";
    case "revoked":
      return "This Zeli Business Intelligence entitlement has been revoked.";
    case "role_not_permitted":
      return "Only a business owner or administrator can open Zeli Business Intelligence.";
    case "tenant_unavailable":
      return "This business is not available.";
    default:
      return "Zeli Business Intelligence is not available.";
  }
}
