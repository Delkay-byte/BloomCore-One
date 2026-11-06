"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { createPlatformAuditLog, getPlatformAuditLogs } from "@/lib/platform-audit";
import { getZeliProviderStatus as resolveZeliProviderStatus } from "@/lib/zeli/provider";
import {
  ZELI_ANALYTICS_FEATURE,
  evaluateZeliAccess,
  type ZeliEntitlementRecord,
} from "@/lib/zeli/entitlements";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

/**
 * Platform Super Admin control centre for Zeli.
 *
 * This module is only reachable with a valid platform session. Tenant users
 * (including tenant administrators) have no route into it: the platform cookie
 * and the tenant cookie are separate authorities.
 *
 * The control centre can change entitlement lifecycle only. It cannot enable an
 * external AI provider, cannot read a tenant's customer records, and cannot
 * modify financial data.
 */

export interface PlatformZeliAction {
  success: boolean
  error?: string;
  data?: unknown;
}

async function requirePlatformRead() {
  const session = await getPlatformAdminOrNull();
  if (!session) throw new Error("Not authenticated");
  if (session.forcePasswordReset) throw new Error("Password change required");
  return session;
}

async function requirePlatformWrite() {
  const session = await requirePlatformRead();
  const rate = await consumeRateLimit(
    "platform.zeli.entitlement",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) throw new Error("Too many changes. Try again later.");
  return session;
}

function effective(row: {
  id: string;
  tenantId: string;
  featureKey: string;
  status: string;
  source: string;
  startsAt: Date;
  expiresAt: Date | null;
  suspendedAt: Date | null;
  revokedAt: Date | null;
}): ZeliEntitlementRecord {
  return row;
}

async function audit(
  session: { adminId: string; email: string },
  action: string,
  params: {
    tenantId: string;
    tenantCode?: string | null;
    reason?: string | null;
    details?: Record<string, unknown>;
  }
) {
  await createPlatformAuditLog({
    actorId: session.adminId,
    actorEmail: session.email,
    action,
    tenantId: params.tenantId,
    tenantCode: params.tenantCode ?? null,
    entityType: "zeli_entitlement",
    entityId: params.tenantId,
    reason: params.reason ?? null,
    details: params.details ?? null,
  });
}

export interface ZeliPlatformOverview {
  totals: {
    businesses: number;
    activeSubscribers: number;
    suspended: number;
    revoked: number;
    expired: number;
    neverGranted: number;
  };
  adoption: Array<{ month: string; granted: number; revoked: number }>;
  usage: {
    conversations: number;
    messages: number;
    requestsToday: number;
    requests30Days: number;
    usersAtDailyLimit: number;
  };
  refreshHealth: {
    successfulRanges: number;
    failedRanges: number;
    failures24h: number;
    averageDurationMs: number | null;
    latestRefreshAt: string | null;
  };
  provider: Awaited<ReturnType<typeof resolveZeliProviderStatus>>;
  recentEntitlementActivity: Array<{
    id: string;
    action: string;
    tenantCode: string | null;
    reason: string | null;
    createdAt: string;
  }>;
  checkedAt: string;
}

/** Aggregated platform information — no tenant financial records. */
export async function getZeliPlatformOverview(): Promise<ZeliPlatformOverview> {
  await requirePlatformRead();
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);

  const [businesses, entitlements, conversations, messages, usage, refreshes, failed24h, recentActivity] =
    await Promise.all([
      db.businessTenant.count(),
      db.zeliEntitlement.findMany({
        where: { featureKey: ZELI_ANALYTICS_FEATURE },
        select: {
          id: true,
          tenantId: true,
          featureKey: true,
          status: true,
          source: true,
          startsAt: true,
          expiresAt: true,
          suspendedAt: true,
          revokedAt: true,
        },
      }),
      db.zeliConversation.count({ where: { deletedAt: null } }),
      db.zeliMessage.count(),
      db.zeliUsage.aggregate({ _sum: { requests: true } }),
      db.zeliAnalyticsRefresh.findMany({
        select: { status: true, durationMs: true, refreshedAt: true },
      }),
      db.zeliAnalyticsRefresh.count({
        where: { status: "failed", refreshedAt: { gte: dayAgo } },
      }),
      db.zeliEntitlementEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          action: true,
          createdAt: true,
          reason: true,
          tenant: { select: { code: true } },
        },
      }),
    ]);

  const decisions = entitlements.map((row) => evaluateZeliAccess({ role: "admin", entitlement: effective(row), now }));
  const activeSubscribers = decisions.filter((decision) => decision.allowed).length;
  const suspended = decisions.filter((decision) => decision.reason === "suspended").length;
  const revoked = decisions.filter((decision) => decision.reason === "revoked").length;
  const expired = decisions.filter((decision) => decision.reason === "expired").length;
  const neverGranted = Math.max(0, businesses - entitlements.length);

  const events = await db.zeliEntitlementEvent.findMany({
    where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth() - 5, 1) } },
    select: { action: true, createdAt: true },
  });
  const adoptionMap = new Map<string, { granted: number; revoked: number }>();
  for (const event of events) {
    const month = event.createdAt.toISOString().slice(0, 7);
    const entry = adoptionMap.get(month) ?? { granted: 0, revoked: 0 };
    if (event.action === "granted" || event.action === "activated") entry.granted += 1;
    if (event.action === "revoked") entry.revoked += 1;
    adoptionMap.set(month, entry);
  }
  const adoption = Array.from(adoptionMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, value]) => ({ month, ...value }));

  const [requestsToday, requests30Days, usersAtLimit] = await Promise.all([
    db.zeliUsage.aggregate({
      where: { day: dayKey },
      _sum: { requests: true },
    }),
    db.zeliUsage.aggregate({
      where: { day: { gte: thirtyDaysAgo.toISOString().slice(0, 10) } },
      _sum: { requests: true },
    }),
    db.zeliUsage.count({ where: { day: dayKey, requests: { gte: 40 } } }),
  ]);

  const durations = refreshes.filter((row) => row.durationMs > 0).map((row) => row.durationMs);
  const latest = refreshes.reduce<Date | null>(
    (value, row) => (!value || row.refreshedAt > value ? row.refreshedAt : value),
    null
  );

  return {
    totals: {
      businesses,
      activeSubscribers,
      suspended,
      revoked,
      expired,
      neverGranted,
    },
    adoption,
    usage: {
      conversations,
      messages,
      requestsToday: requestsToday._sum.requests ?? 0,
      requests30Days: requests30Days._sum.requests ?? 0,
      usersAtDailyLimit: usersAtLimit,
    },
    refreshHealth: {
      successfulRanges: refreshes.filter((row) => row.status === "ok").length,
      failedRanges: refreshes.filter((row) => row.status === "failed").length,
      failures24h: failed24h,
      averageDurationMs:
        durations.length > 0
          ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
          : null,
      latestRefreshAt: latest?.toISOString() ?? null,
    },
    provider: await resolveZeliProviderStatus(),
    recentEntitlementActivity: recentActivity.map((row) => ({
      id: row.id,
      action: row.action,
      tenantCode: row.tenant?.code ?? null,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    checkedAt: now.toISOString(),
  };
}

export interface PlatformZeliTenantRow {
  tenantId: string;
  code: string;
  name: string;
  tenantStatus: string;
  entitlement: {
    status: string;
    effectiveStatus: string;
    allowed: boolean;
    source: string;
    startsAt: string;
    expiresAt: string | null;
    reason: string | null;
  } | null;
}

/** Find businesses and inspect their entitlement. No financial detail. */
export async function listZeliTenants(search?: string): Promise<PlatformZeliTenantRow[]> {
  await requirePlatformRead();
  const query = (search ?? "").trim().slice(0, 80);
  const tenants = await db.businessTenant.findMany({
    where: query
      ? {
          OR: [
            { name: { contains: query } },
            { code: { contains: query } },
            { legalName: { contains: query } },
          ],
        }
      : undefined,
    orderBy: { name: "asc" },
    take: 25,
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      zeliEntitlements: {
        where: { featureKey: ZELI_ANALYTICS_FEATURE },
        take: 1,
      },
    },
  });
  const now = new Date();
  return tenants.map((tenant) => {
    const row = tenant.zeliEntitlements[0] ?? null;
    const decision = row
      ? evaluateZeliAccess({ role: "admin", entitlement: effective(row), now })
      : null;
    return {
      tenantId: tenant.id,
      code: tenant.code,
      name: tenant.name,
      tenantStatus: tenant.status,
      entitlement: row
        ? {
            status: row.status,
            effectiveStatus: decision?.allowed
              ? "active"
              : decision?.reason === "expired"
                ? "expired"
                : decision?.reason ?? row.status,
            allowed: Boolean(decision?.allowed),
            source: row.source,
            startsAt: row.startsAt.toISOString(),
            expiresAt: row.expiresAt?.toISOString() ?? null,
            reason: row.reason,
          }
        : null,
    };
  });
}

export interface PlatformZeliDetail {
  tenant: { id: string; code: string; name: string; status: string };
  entitlement: ZeliEntitlementRecord | null;
  access: ReturnType<typeof evaluateZeliAccess> | null;
  history: Array<{
    id: string;
    action: string;
    previousStatus: string | null;
    status: string;
    reason: string;
    actorType: string;
    expiresAt: string | null;
    createdAt: string;
  }>;
  usage: { conversations: number; requests30Days: number };
}

export async function getZeliTenantDetail(tenantId: string): Promise<PlatformZeliDetail | null> {
  await requirePlatformRead();
  const tenant = await db.businessTenant.findUnique({
    where: { id: tenantId },
    select: { id: true, code: true, name: true, status: true },
  });
  if (!tenant) return null;
  const entitlement = await db.zeliEntitlement.findUnique({
    where: {
      tenantId_featureKey: { tenantId, featureKey: ZELI_ANALYTICS_FEATURE },
    },
  });
  const history = await db.zeliEntitlementEvent.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  const usage = await db.zeliUsage.aggregate({
    where: {
      tenantId,
      day: { gte: thirtyDaysAgo.toISOString().slice(0, 10) },
    },
    _sum: { requests: true },
  });
  const conversations = await db.zeliConversation.count({
    where: { tenantId, deletedAt: null },
  });
  return {
    tenant,
    entitlement: entitlement
      ? {
          id: entitlement.id,
          tenantId: entitlement.tenantId,
          featureKey: entitlement.featureKey,
          status: entitlement.status,
          source: entitlement.source,
          startsAt: entitlement.startsAt,
          expiresAt: entitlement.expiresAt,
          suspendedAt: entitlement.suspendedAt,
          revokedAt: entitlement.revokedAt,
        }
      : null,
    access: entitlement
      ? evaluateZeliAccess({ role: "admin", entitlement: effective(entitlement) })
      : null,
    history: history.map((row) => ({
      id: row.id,
      action: row.action,
      previousStatus: row.previousStatus,
      status: row.status,
      reason: row.reason,
      actorType: row.actorType,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    usage: {
      conversations,
      requests30Days: usage._sum.requests ?? 0,
    },
  };
}

export type EntitlementAction = "grant" | "suspend" | "revoke" | "reactivate" | "expire";

/**
 * Apply an audited entitlement change. The reason is mandatory and stored in
 * both the tenant-scoped history and the platform audit log.
 */
export async function updateZeliEntitlement(input: {
  tenantId: string;
  action: EntitlementAction;
  reason: string;
  expiresAt?: string | null;
}): Promise<PlatformZeliAction> {
  const session = await requirePlatformWrite();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  if (!["grant", "suspend", "revoke", "reactivate", "expire"].includes(input.action)) {
    return { success: false, error: "Unknown entitlement action." };
  }

  const tenant = await db.businessTenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, code: true, name: true, status: true },
  });
  if (!tenant) return { success: false, error: "Business not found." };

  let expiresAt: Date | null = null;
  if (input.expiresAt) {
    const parsed = new Date(`${input.expiresAt}T23:59:59.999Z`);
    if (Number.isNaN(parsed.getTime())) {
      return { success: false, error: "Enter a valid expiry date." };
    }
    if (parsed.getTime() <= Date.now()) {
      return { success: false, error: "The expiry date must be in the future." };
    }
    expiresAt = parsed;
  }

  const existing = await db.zeliEntitlement.findUnique({
    where: {
      tenantId_featureKey: {
        tenantId: tenant.id,
        featureKey: ZELI_ANALYTICS_FEATURE,
      },
    },
  });

  const statusByAction: Record<EntitlementAction, string> = {
    grant: "active",
    reactivate: "active",
    suspend: "suspended",
    revoke: "revoked",
    expire: "active",
  };
  const nextStatus = statusByAction[input.action];
  const previousStatus = existing?.status ?? null;

  try {
    const result = await db.$transaction(async (tx) => {
      const row = existing
        ? await tx.zeliEntitlement.update({
            where: { id: existing.id },
            data: {
              status: nextStatus,
              reason,
              ...(input.action === "grant" || input.action === "reactivate"
                ? {
                    startsAt: existing.startsAt,
                    suspendedAt: null,
                    revokedAt: null,
                    revokedById: null,
                    grantedById: session.adminId,
                    grantedByType: "platform",
                  }
                : {}),
              ...(input.action === "suspend" ? { suspendedAt: new Date() } : {}),
              ...(input.action === "revoke"
                ? { revokedAt: new Date(), revokedById: session.adminId }
                : {}),
              ...(input.action === "expire" ? { expiresAt: new Date() } : {}),
              ...(expiresAt && input.action !== "expire" ? { expiresAt } : {}),
            },
          })
        : await tx.zeliEntitlement.create({
            data: {
              tenantId: tenant.id,
              featureKey: ZELI_ANALYTICS_FEATURE,
              status: "active",
              source: "manual",
              reason,
              startsAt: new Date(),
              expiresAt,
              grantedById: session.adminId,
              grantedByType: "platform",
            },
          });

      await tx.zeliEntitlementEvent.create({
        data: {
          entitlementId: row.id,
          tenantId: tenant.id,
          featureKey: ZELI_ANALYTICS_FEATURE,
          action:
            input.action === "grant"
              ? "granted"
              : input.action === "reactivate"
                ? "activated"
                : input.action === "expire"
                  ? "expired"
                  : input.action === "suspend"
                    ? "suspended"
                    : input.action === "revoke"
                      ? "revoked"
                      : input.action,
          previousStatus,
          status: row.status,
          reason,
          actorId: session.adminId,
          actorType: "platform",
          expiresAt: row.expiresAt,
        },
      });
      return row;
    });

    await audit(session, `zeli.entitlement_${input.action}`, {
      tenantId: tenant.id,
      tenantCode: tenant.code,
      reason,
      details: {
        previousStatus,
        status: result.status,
        expiresAt: result.expiresAt?.toISOString() ?? null,
        featureKey: ZELI_ANALYTICS_FEATURE,
      },
    });

    return { success: true, data: { status: result.status } };
  } catch {
    return { success: false, error: "The entitlement change could not be saved." };
  }
}

/** Platform audit page filtered to Zeli actions (read-only). */
export async function getZeliPlatformAudit(page = 1) {
  await requirePlatformRead();
  return getPlatformAuditLogs({ page, limit: 30 });
}

/**
 * Provider status for the platform page. Read-only by design: there is no
 * action here that can enable DeepSeek or store a credential.
 */
export async function getZeliProviderStatus() {
  await requirePlatformRead();
  return resolveZeliProviderStatus();
}
