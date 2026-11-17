/**
 * Zeli usage entitlement and monthly quota.
 *
 * Every commercial package includes Zeli. The plan's `usageAllowance` is the
 * number of assistant requests included per calendar month (UTC). Allowances
 * are enforced server-side and tenant-wide, so concurrent turns cannot exceed
 * the plan: the conditional increment is atomic in PostgreSQL and SQLite.
 *
 * Tenants without any subscription record (pilot/manual entitlement) receive
 * the fallback allowance. A tenant whose subscription is pending payment or
 * suspended is refused, so an unpaid or lapsed account cannot consume AI.
 */

import { db } from "@/lib/db";

export const ZELI_FALLBACK_MONTHLY_ALLOWANCE = 250;

export function usagePeriodKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function periodBounds(now: Date = new Date()): { start: Date; end: Date; resetAt: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, resetAt: end };
}

export interface ZeliEntitlementSnapshot {
  allowance: number;
  planName: string | null;
  period: string;
  source: "subscription" | "fallback";
}

export class ZeliAccessError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ZeliAccessError";
    this.code = code;
  }
}

/**
 * Resolve the tenant's included Zeli allowance and refuse unpaid or suspended
 * subscriptions. Grace-period subscriptions keep their allowance.
 */
export async function zeliEntitlementForTenant(
  tenantId: string,
  now: Date = new Date()
): Promise<ZeliEntitlementSnapshot> {
  const subscription = await db.zeliSubscription.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      periodEnd: true,
      graceEndsAt: true,
      plan: { select: { name: true, usageAllowance: true } },
    },
  });

  if (subscription) {
    if (subscription.status === "pending_payment" || subscription.status === "pending") {
      throw new ZeliAccessError(
        "Complete your subscription payment to use Zeli. Your data is safe and nothing was charged.",
        "payment_required"
      );
    }
    if (subscription.status === "suspended") {
      throw new ZeliAccessError(
        "Zeli is paused because the subscription is suspended. Renew from Billing to restore access.",
        "subscription_suspended"
      );
    }
    const activeLike = ["active", "grace_period", "past_due"].includes(subscription.status);
    if (!activeLike) {
      throw new ZeliAccessError(
        "Zeli requires an active subscription. Choose a package from Billing to continue.",
        "subscription_inactive"
      );
    }
    return {
      allowance: subscription.plan.usageAllowance ?? ZELI_FALLBACK_MONTHLY_ALLOWANCE,
      planName: subscription.plan.name,
      period: usagePeriodKey(now),
      source: "subscription",
    };
  }

  return {
    allowance: ZELI_FALLBACK_MONTHLY_ALLOWANCE,
    planName: null,
    period: usagePeriodKey(now),
    source: "fallback",
  };
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export interface QuotaResult {
  used: number;
  limit: number;
  remaining: number;
  period: string;
}

/** Atomically consume one request from the tenant's monthly allowance. */
export async function consumeZeliQuota(
  tenantId: string,
  now: Date = new Date()
): Promise<QuotaResult> {
  const entitlement = await zeliEntitlementForTenant(tenantId, now);
  const period = usagePeriodKey(now);
  const limit = Math.max(1, entitlement.allowance);

  try {
    await db.zeliUsagePeriod.create({
      data: { tenantId, period, requests: 1, limit },
    });
    return { used: 1, limit, remaining: Math.max(0, limit - 1), period };
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
  }

  // Keep the stored limit in step with a plan change, then increment only
  // while below the allowance. The conditional update is the concurrency guard.
  await db.zeliUsagePeriod.updateMany({
    where: { tenantId, period, limit: { not: limit } },
    data: { limit },
  });
  const updated = await db.zeliUsagePeriod.updateMany({
    where: { tenantId, period, requests: { lt: limit } },
    data: { requests: { increment: 1 } },
  });
  if (updated.count === 0) {
    throw new ZeliAccessError(
      `You have used all ${limit} Zeli requests included this month. Your allowance resets on the first day of next month.`,
      "quota_exhausted"
    );
  }

  const row = await db.zeliUsagePeriod.findUnique({
    where: { tenantId_period: { tenantId, period } },
    select: { requests: true, limit: true },
  });
  const used = row?.requests ?? limit;
  return { used, limit, remaining: Math.max(0, limit - used), period };
}

export interface ZeliUsageSummary {
  used: number;
  limit: number;
  remaining: number;
  period: string;
  periodLabel: string;
  resetAt: string;
  planName: string | null;
  source: "subscription" | "fallback";
  blocked: null | { code: string; message: string };
}

/** Usage summary for the billing and Zeli screens. Never throws on gating. */
export async function zeliUsageSummary(
  tenantId: string,
  now: Date = new Date()
): Promise<ZeliUsageSummary> {
  const bounds = periodBounds(now);
  const period = usagePeriodKey(now);
  const label = bounds.start.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  let entitlement: ZeliEntitlementSnapshot;
  try {
    entitlement = await zeliEntitlementForTenant(tenantId, now);
  } catch (error) {
    if (error instanceof ZeliAccessError) {
      return {
        used: 0,
        limit: 0,
        remaining: 0,
        period,
        periodLabel: label,
        resetAt: bounds.resetAt.toISOString(),
        planName: null,
        source: "subscription",
        blocked: { code: error.code, message: error.message },
      };
    }
    throw error;
  }

  const row = await db.zeliUsagePeriod.findUnique({
    where: { tenantId_period: { tenantId, period } },
    select: { requests: true },
  });
  const limit = Math.max(1, entitlement.allowance);
  const used = row?.requests ?? 0;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    period,
    periodLabel: label,
    resetAt: bounds.resetAt.toISOString(),
    planName: entitlement.planName,
    source: entitlement.source,
    blocked: null,
  };
}
