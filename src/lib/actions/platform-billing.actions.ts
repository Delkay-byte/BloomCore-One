"use server";

import { db } from "@/lib/db";
import { requirePlatformPage } from "@/lib/platform-auth";
import { foundingSlots } from "@/lib/pricing/founding";
import { usagePeriodKey } from "@/lib/zeli/usage";

/**
 * Platform Super Admin billing overview.
 *
 * Subscription revenue is deliberately separate from tenant MoMo transaction
 * volume and business balances: only Zeli subscriptions appear here.
 */

export interface PlatformBillingOverview {
  mrr: number;
  annualContracted: number;
  collectedCash: number;
  counts: {
    active: number;
    pending: number;
    grace: number;
    suspended: number;
    failed: number;
    refunded: number;
  };
  upcoming: Array<{
    tenant: string;
    code: string;
    plan: string;
    amount: number;
    periodEnd: string;
    lifecycle: string;
  }>;
  grace: Array<{ tenant: string; code: string; graceEndsAt: string | null; amount: number }>;
  suspended: Array<{ tenant: string; code: string; suspendedSince: string | null }>;
  founding: { capacity: number; used: number; remaining: number; rows: Array<{
    slot: number;
    tenant: string;
    code: string;
    plan: string;
    periodsUsed: number;
    periodsGranted: number;
    status: string;
    monthlyPrice: number;
    standardPrice: number;
  }> };
  zeli: { period: string; requests: number; tenants: number };
  payments: Array<{
    tenant: string;
    reference: string;
    plan: string;
    amount: number;
    status: string;
    paidAt: string | null;
  }>;
}

export async function getPlatformBillingOverview(): Promise<PlatformBillingOverview> {
  await requirePlatformPage();
  const now = new Date();
  const monthAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const period = usagePeriodKey(now);

  const subscriptions = await db.zeliSubscription.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      plan: { select: { name: true, billingInterval: true } },
      tenant: { select: { name: true, code: true } },
    },
  });

  const counts = { active: 0, pending: 0, grace: 0, suspended: 0, failed: 0, refunded: 0 };
  let mrr = 0;
  let annualContracted = 0;
  let collectedCash = 0;
  const upcoming: PlatformBillingOverview["upcoming"] = [];
  const grace: PlatformBillingOverview["grace"] = [];
  const suspended: PlatformBillingOverview["suspended"] = [];

  for (const row of subscriptions) {
    const amount = Number(row.amount);
    if (row.paidAt && row.status !== "refunded") collectedCash += amount;
    if (row.status === "active") {
      counts.active += 1;
      if (row.plan.billingInterval === "year") annualContracted += amount;
      else mrr += amount;
      if (row.periodEnd && row.periodEnd > now && row.periodEnd <= monthAhead) {
        upcoming.push({
          tenant: row.tenant.name,
          code: row.tenant.code,
          plan: row.plan.name,
          amount,
          periodEnd: row.periodEnd.toISOString(),
          lifecycle: "active",
        });
      }
    } else if (row.status === "grace_period") {
      counts.grace += 1;
      grace.push({
        tenant: row.tenant.name,
        code: row.tenant.code,
        graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
        amount,
      });
    } else if (row.status === "suspended") {
      counts.suspended += 1;
      suspended.push({
        tenant: row.tenant.name,
        code: row.tenant.code,
        suspendedSince: row.updatedAt.toISOString(),
      });
    } else if (row.status === "pending" || row.status === "pending_payment") {
      counts.pending += 1;
    } else if (row.status === "failed") {
      counts.failed += 1;
    } else if (row.status === "refunded") {
      counts.refunded += 1;
    }
  }

  const slots = await foundingSlots();
  const usage = await db.zeliUsagePeriod.aggregate({
    where: { period },
    _sum: { requests: true },
    _count: { tenantId: true },
  });

  return {
    mrr,
    annualContracted,
    collectedCash,
    counts,
    upcoming: upcoming.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(0, 15),
    grace: grace.slice(0, 15),
    suspended: suspended.slice(0, 15),
    founding: {
      capacity: slots.capacity,
      used: slots.used,
      remaining: slots.remaining,
      rows: slots.rows.map((row) => ({
        slot: row.slot,
        tenant: row.tenant.name,
        code: row.tenant.code,
        plan: row.plan.name,
        periodsUsed: row.periodsUsed,
        periodsGranted: row.periodsGranted,
        status: row.status,
        monthlyPrice: Number(row.monthlyPrice),
        standardPrice: Number(row.standardPrice),
      })),
    },
    zeli: { period, requests: usage._sum.requests ?? 0, tenants: usage._count.tenantId },
    payments: subscriptions
      .filter((row) => ["active", "refunded", "failed"].includes(row.status))
      .slice(0, 20)
      .map((row) => ({
        tenant: row.tenant.name,
        reference: row.providerReference,
        plan: row.plan.name,
        amount: Number(row.amount),
        status: row.status,
        paidAt: row.paidAt?.toISOString() ?? null,
      })),
  };
}
