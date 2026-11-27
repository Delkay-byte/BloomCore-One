"use server";

/**
 * Period-based collector performance and customer follow-up for MaaCash Susu.
 *
 * All totals are calculated from authoritative server-side records
 * (Contribution / CollectorCustomerAssignment / OfflineTransaction). Client
 * supplied totals are never trusted. Reversed contributions are excluded from
 * every collection measure.
 *
 * Periods: daily | weekly | monthly | custom. Date ranges use the application's
 * established UTC day-boundary convention (see getTodayString in src/lib/utils),
 * so a "day" is the server's UTC day and a week/month is a rolling window of
 * days rather than a calendar guess.
 *
 * Created by Agent 2 (Phase 2: Collector Management and Field Operations).
 */

import { db } from "@/lib/db";
import {
  requireTenantAdminSusu,
  requireTenantCollector,
  assertTenantEntity,
} from "@/lib/tenant";

export type PerformancePeriod = "daily" | "weekly" | "monthly" | "custom";

interface PerformanceParams {
  collectorId: string;
  period: PerformancePeriod;
  dateFrom?: string | null; // ISO date string, inclusive
  dateTo?: string | null;   // ISO date string, inclusive
}

export interface CollectorPerformance {
  collectorId: string;
  period: PerformancePeriod;
  dateFrom: Date;
  dateTo: Date;
  /** Sum of non-reversed contribution amounts in the period. */
  totalCollected: number;
  /** Number of non-reversed contribution transactions in the period. */
  transactionCount: number;
  /** Distinct accounts with at least one non-reversed contribution in the period. */
  customersServed: number;
  /** Active assignments the collector currently holds. */
  assignedCustomers: number;
  /** Assigned customers with no non-reversed contribution in the period. */
  assignedNotContributing: number;
  /** Per-day collected amounts across the period, oldest first. */
  trend: Array<{ date: string; collected: number; transactions: number }>;
  /** active | inactive | suspended — from the collector lifecycle record. */
  collectorActivityStatus: string;
  /** Offline contributions captured but not yet synced for this collector. */
  pendingSync: { count: number; amount: number };
  /** Non-reversed contributions excluded from totals during the period. */
  reversedExcluded: { count: number; amount: number };
}

/**
 * Resolve an inclusive [dateFrom, dateTo] window for the requested period.
 * Bounds are UTC day starts/ends so SQLite and PostgreSQL compare the same
 * instants the UI displays as local calendar days.
 */
function resolvePeriodWindow(
  period: PerformancePeriod,
  dateFrom?: string | null,
  dateTo?: string | null
): { from: Date; to: Date } {
  const startOfDay = (d: Date) => {
    const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    out.setUTCHours(0, 0, 0, 0);
    return out;
  };
  const endOfDay = (d: Date) => {
    const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    out.setUTCHours(23, 59, 59, 999);
    return out;
  };

  const now = new Date();
  const today = startOfDay(now);

  let from: Date;
  let to: Date;

  if (period === "custom") {
    if (!dateFrom || !dateTo) {
      throw new Error("dateFrom and dateTo are required for a custom period");
    }
    from = startOfDay(new Date(dateFrom + "T00:00:00Z"));
    to = endOfDay(new Date(dateTo + "T00:00:00Z"));
  } else {
    to = endOfDay(today);
    switch (period) {
      case "daily":
        from = startOfDay(today);
        break;
      case "weekly": {
        from = new Date(today);
        from.setUTCDate(from.getUTCDate() - 6);
        from.setUTCHours(0, 0, 0, 0);
        break;
      }
      case "monthly": {
        from = new Date(today.getUTCFullYear(), today.getUTCMonth(), 1);
        from.setUTCHours(0, 0, 0, 0);
        break;
      }
    }
  }

  if (to < from) throw new Error("dateTo must be on or after dateFrom");
  return { from, to };
}

/**
 * Day bucket key (YYYY-MM-DD, UTC) for a collection date.
 */
function dayKey(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * Period-based performance for one collector. Admin or the collector
 * themselves may read it; every query is tenant-scoped.
 */
export async function getCollectorPerformance(params: PerformanceParams): Promise<CollectorPerformance> {
  const ctx =
    (await requireTenantAdminSusu().catch(() => null)) ??
    (await requireTenantCollector().catch(() => null));
  if (!ctx) {
    throw new Error("Not authenticated. Please sign in again.");
  }

  if (!(await assertTenantEntity("collector", params.collectorId, ctx))) {
    throw new Error("Collector not found");
  }

  // A collector may read their own performance; an admin may read any collector
  // in the tenant.
  const isSelf = ctx.role === "collector";
  if (isSelf) {
    const own = await db.collector.findFirst({
      where: { userId: ctx.userId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!own || own.id !== params.collectorId) {
      throw new Error("You may only view your own performance");
    }
  }

  const { from, to } = resolvePeriodWindow(params.period, params.dateFrom, params.dateTo);

  const collector = await db.collector.findFirst({
    where: { id: params.collectorId, tenantId: ctx.tenantId },
    include: { user: { select: { status: true } } },
  });
  if (!collector) throw new Error("Collector not found");

  // Non-reversed contributions for this collector in the window, fetched once
  // and aggregated in memory so the same rows feed every measure.
  const contributions = await db.contribution.findMany({
    where: {
      tenantId: ctx.tenantId,
      collectorId: params.collectorId,
      channel: "collector",
      collectionDate: { gte: from, lte: to },
    },
    select: {
      id: true,
      amount: true,
      collectionDate: true,
      reversedAt: true,
      accountId: true,
    },
    orderBy: { collectionDate: "asc" },
  });

  const reversed = contributions.filter((c) => c.reversedAt != null);
  const valid = contributions.filter((c) => c.reversedAt == null);

  const totalCollected = valid.reduce((sum, c) => sum + Number(c.amount), 0);
  const transactionCount = valid.length;
  const customersServed = new Set(valid.map((c) => c.accountId)).size;
  const reversedExcluded = {
    count: reversed.length,
    amount: reversed.reduce((sum, c) => sum + Number(c.amount), 0),
  };

  // Daily trend, oldest first, with zero-filled days so charts render evenly.
  const trendMap = new Map<string, { collected: number; transactions: number }>();
  let cursor = new Date(from);
  while (cursor <= to) {
    trendMap.set(dayKey(cursor), { collected: 0, transactions: 0 });
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  for (const c of valid) {
    const key = dayKey(c.collectionDate);
    const bucket = trendMap.get(key);
    if (bucket) {
      bucket.collected += Number(c.amount);
      bucket.transactions += 1;
    }
  }
  const trend = Array.from(trendMap.entries()).map(([date, bucket]) => ({ date, ...bucket }));

  // Current assignments and which assigned accounts contributed in the window.
  const assignments = await db.collectorCustomerAssignment.findMany({
    where: { collectorId: params.collectorId, active: true, tenantId: ctx.tenantId },
    select: { accountId: true },
  });
  const assignedCustomers = assignments.length;
  const contributingAccounts = new Set(valid.map((c) => c.accountId));
  const assignedNotContributing = assignments.filter(
    (a) => !contributingAccounts.has(a.accountId)
  ).length;

  // Pending offline sync for this collector's user: captured but not synced.
  const pendingSync = await db.offlineTransaction.aggregate({
    where: {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: "contribution",
      status: { in: ["pending_sync", "syncing", "failed"] },
    },
    _count: true,
  });

  return {
    collectorId: params.collectorId,
    period: params.period,
    dateFrom: from,
    dateTo: to,
    totalCollected: Math.round(totalCollected * 100) / 100,
    transactionCount,
    customersServed,
    assignedCustomers,
    assignedNotContributing,
    trend,
    collectorActivityStatus: collector.status,
    pendingSync: {
      count: pendingSync._count,
      amount: 0,
    },
    reversedExcluded,
  };
}

export interface FollowUpCustomer {
  accountId: string;
  customerId: string;
  customerName: string;
  customerStatus: string;
  accountStatus: string;
  dailyContribution: number;
  lastContributionAt?: Date | null;
  daysOutstanding: number;
  expectedAmount: number;
  collectorId: string;
}

interface FollowUpParams {
  collectorId?: string; // undefined => team-wide (admin only)
  period: PerformancePeriod;
  dateFrom?: string | null;
  dateTo?: string | null;
}

/**
 * Customers assigned to a collector who have not contributed within the
 * relevant period — the actionable field follow-up list.
 *
 * When `collectorId` is omitted the caller must be a tenant admin and the list
 * covers every active assignment in the tenant (team view). A collector may
 * only ever see their own list.
 */
export async function getCollectorFollowUpList(params: FollowUpParams): Promise<FollowUpCustomer[]> {
  const adminCtx = await requireTenantAdminSusu().catch(() => null);
  const collectorCtx = await requireTenantCollector().catch(() => null);
  const ctx = adminCtx ?? collectorCtx;
  if (!ctx) {
    throw new Error("Not authenticated. Please sign in again.");
  }

  const isAdmin = Boolean(adminCtx);
  let resolvedCollectorId = params.collectorId;

  if (resolvedCollectorId) {
    if (!(await assertTenantEntity("collector", resolvedCollectorId, ctx))) {
      throw new Error("Collector not found");
    }
    if (!isAdmin) {
      const own = await db.collector.findFirst({
        where: { userId: ctx.userId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!own || own.id !== resolvedCollectorId) {
        throw new Error("You may only view your own follow-up list");
      }
    }
  } else if (!isAdmin) {
    const own = await db.collector.findFirst({
      where: { userId: ctx.userId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!own) throw new Error("No collector record for this session");
    resolvedCollectorId = own.id;
  }

  const { from, to } = resolvePeriodWindow(params.period, params.dateFrom, params.dateTo);

  const assignments = await db.collectorCustomerAssignment.findMany({
    where: {
      ...(resolvedCollectorId ? { collectorId: resolvedCollectorId } : {}),
      active: true,
      tenantId: ctx.tenantId,
    },
    include: {
      customer: { select: { id: true, customerId: true, fullName: true, status: true } },
      account: { select: { id: true, accountId: true, status: true, dailyContribution: true } },
    },
  });

  // Non-reversed contributions in the window for any of these accounts.
  const accountIds = assignments.map((a) => a.accountId);
  const inWindow = accountIds.length
    ? await db.contribution.findMany({
        where: {
          tenantId: ctx.tenantId,
          accountId: { in: accountIds },
          channel: "collector",
          collectionDate: { gte: from, lte: to },
          reversedAt: null,
        },
        select: { accountId: true, collectionDate: true, amount: true },
      })
    : [];

  const lastByAccount = new Map<string, { at: Date; amount: number }>();
  for (const c of inWindow) {
    const prev = lastByAccount.get(c.accountId);
    if (!prev || c.collectionDate > prev.at) {
      lastByAccount.set(c.accountId, { at: c.collectionDate, amount: Number(c.amount) });
    }
  }

  const list: FollowUpCustomer[] = [];
  for (const assignment of assignments) {
    const daily = Number(assignment.account.dailyContribution);
    const last = lastByAccount.get(assignment.account.id);
    const daysOutstanding = last
      ? Math.max(0, Math.floor((to.getTime() - last.at.getTime()) / (24 * 60 * 60 * 1000)))
      : 31;
    list.push({
      accountId: assignment.account.id,
      customerId: assignment.customer.customerId,
      customerName: assignment.customer.fullName,
      customerStatus: assignment.customer.status,
      accountStatus: assignment.account.status,
      dailyContribution: daily,
      lastContributionAt: last?.at ?? null,
      daysOutstanding,
      expectedAmount: Math.round((daysOutstanding || 1) * daily * 100) / 100,
      collectorId: resolvedCollectorId!,
    });
  }

  // Most overdue first.
  list.sort((a, b) => b.daysOutstanding - a.daysOutstanding);
  return list;
}
