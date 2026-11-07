import { db } from "@/lib/db";
import {
  enumerateDays,
  periodLabel,
  resolvePeriod,
  type PeriodPreset,
  type ResolvedPeriod,
} from "./period";

/**
 * Authoritative analytics aggregation for Zeli Business Intelligence.
 *
 * This module reads the existing MaaCash domain tables. It never writes a
 * financial record and never computes an official balance in the browser. The
 * figures here must reconcile with the MoMo and Susu reports:
 *  - contributions exclude reversed rows (`reversedAt` is set),
 *  - withdrawals are completed and non-reversed,
 *  - remittances exclude reversed rows,
 *  - corrections are reflected because the live DailyAccount row is corrected,
 *  - every query is bounded by tenantId and the reporting period.
 *
 * Per-day aggregates are persisted in `ZeliAnalyticsDaily` so repeated page
 * loads do not re-aggregate the whole period. Refresh is idempotent (unique
 * key + upsert), so duplicate events cannot double-count.
 */

export type { PeriodPreset, ResolvedPeriod };

export interface AnalyticsFilters {
  period: PeriodPreset;
  from?: string;
  to?: string;
  locationId?: string;
}

export interface AnalyticsTotals {
  contributions: number;
  contributionCount: number;
  withdrawals: number;
  withdrawalCount: number;
  commissions: number;
  remittances: number;
  remittanceVariance: number;
  remittanceCount: number;
  expenses: number;
  expenseCount: number;
  cashIncome: number;
  transactionCount: number;
  netCashFlow: number;
  activeAccounts: number;
  newCustomers: number;
}

export interface AnalyticsSeriesPoint {
  date: string;
  contributions: number;
  withdrawals: number;
  expenses: number;
  income: number;
  netCashFlow: number;
  remittances: number;
  transactionCount: number;
  activeAccounts: number;
  newCustomers: number;
}

export interface BranchPerformance {
  locationId: string;
  locationName: string;
  contributions: number;
  withdrawals: number;
  remittances: number;
  expenses: number;
  netCashFlow: number;
  transactionCount: number;
}

export interface CollectorActivity {
  collectorId: string;
  collectorName: string;
  contributions: number;
  contributionCount: number;
  remittances: number;
  remittanceCount: number;
}

export interface ExceptionSummary {
  pendingWithdrawals: number;
  remittanceDiscrepancies: number;
  dailyAccountsAwaitingReview: number;
  collectorsWithoutRemittance: number;
  incompleteDailyAccounts: number;
  total: number;
}

export interface CustomerAnalytics {
  newCustomers: number;
  activeAccounts: number;
  contributingAccounts: number;
  totalActiveAccounts: number;
  dormantAccounts: number;
  singleContributionAccounts: number;
  engagement: Array<{ bucket: string; accounts: number }>;
  series: Array<{ date: string; newCustomers: number; activeAccounts: number }>;
}

export interface AnalyticsSnapshot {
  tenant: { id: string; name: string; code: string };
  filters: { period: PeriodPreset; from: string | null; to: string | null; locationId: string | null; locationName: string | null };
  period: { start: string; end: string; label: string; days: number };
  previousPeriod: { start: string; end: string; label: string };
  totals: AnalyticsTotals;
  previousTotals: AnalyticsTotals;
  comparison: {
    contributionsPct: number | null;
    withdrawalsPct: number | null;
    expensesPct: number | null;
    netCashFlowPct: number | null;
    transactionVolumePct: number | null;
  };
  series: AnalyticsSeriesPoint[];
  branchPerformance: BranchPerformance[];
  collectorActivity: CollectorActivity[];
  customer: CustomerAnalytics;
  exceptions: ExceptionSummary;
  freshness: {
    refreshedAt: string;
    stale: boolean;
    warning: string | null;
    source: string;
    ttlSeconds: number;
  };
  currency: "GHS";
  locations: Array<{ id: string; name: string }>;
  reconciliation: {
    contributionSource: string;
    withdrawalSource: string;
    remittanceSource: string;
    expenseSource: string;
    note: string;
  };
}

const REFRESH_TTL_SECONDS = 60;

function money(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function emptyTotals(): AnalyticsTotals {
  return {
    contributions: 0,
    contributionCount: 0,
    withdrawals: 0,
    withdrawalCount: 0,
    commissions: 0,
    remittances: 0,
    remittanceVariance: 0,
    remittanceCount: 0,
    expenses: 0,
    expenseCount: 0,
    cashIncome: 0,
    transactionCount: 0,
    netCashFlow: 0,
    activeAccounts: 0,
    newCustomers: 0,
  };
}

interface DailyAccumulator {
  date: string;
  contributions: number;
  contributionCount: number;
  withdrawals: number;
  withdrawalCount: number;
  commissions: number;
  remittances: number;
  remittanceVariance: number;
  remittanceCount: number;
  expenses: number;
  expenseCount: number;
  cashIncome: number;
  transactionCount: number;
  accounts: Set<string>;
  newCustomers: number;
}

function emptyDay(date: string): DailyAccumulator {
  return {
    date,
    contributions: 0,
    contributionCount: 0,
    withdrawals: 0,
    withdrawalCount: 0,
    commissions: 0,
    remittances: 0,
    remittanceVariance: 0,
    remittanceCount: 0,
    expenses: 0,
    expenseCount: 0,
    cashIncome: 0,
    transactionCount: 0,
    accounts: new Set<string>(),
    newCustomers: 0,
  };
}

async function locationScope(tenantId: string, locationId: string | null) {
  if (!locationId || locationId === "all") {
    return {
      location: null,
      userIds: [] as string[],
      collectorIds: [] as string[],
    };
  }
  const location = await db.location.findFirst({
    where: { id: locationId, tenantId },
    select: { id: true, name: true },
  });
  // An unknown or foreign location is treated as no data, not as "all".
  if (!location) {
    return { location: null, userIds: ["__none__"], collectorIds: ["__none__"] };
  }
  const [users, collectors] = await Promise.all([
    db.user.findMany({
      where: { tenantId, locationId: location.id },
      select: { id: true },
    }),
    db.collector.findMany({
      where: { tenantId, user: { locationId: location.id } },
      select: { id: true },
    }),
  ]);
  return {
    location,
    userIds: users.map((row) => row.id),
    collectorIds: collectors.map((row) => row.id),
  };
}

/** Aggregate the source records for one range and scope. */
async function aggregateRange(
  tenantId: string,
  range: { start: Date; endExclusive: Date },
  locationId: string | null
): Promise<Map<string, DailyAccumulator>> {
  const days = new Map<string, DailyAccumulator>();
  for (const date of enumerateDays(range)) days.set(date, emptyDay(date));

  const scope = await locationScope(tenantId, locationId);
  const scoped = Boolean(locationId && locationId !== "all");

  const contributionWhere = {
    tenantId,
    reversedAt: null,
    collectionDate: { gte: range.start, lt: range.endExclusive },
    ...(scoped
      ? {
          OR: [
            { collectorId: { in: scope.collectorIds } },
            { collectorId: null, recordedById: { in: scope.userIds } },
          ],
        }
      : {}),
  };

  const withdrawalWhere = {
    tenantId,
    status: "completed",
    reversedAt: null,
    createdAt: { gte: range.start, lt: range.endExclusive },
    ...(scoped ? { authorizedById: { in: scope.userIds } } : {}),
  };

  const remittanceWhere = {
    tenantId,
    reversedAt: null,
    createdAt: { gte: range.start, lt: range.endExclusive },
    ...(scoped ? { collectorId: { in: scope.collectorIds } } : {}),
  };

  const dailyAccountWhere = {
    tenantId,
    businessDate: { gte: range.start, lt: range.endExclusive },
    ...(scoped ? { locationId: locationId as string } : {}),
  };

  const [contributions, withdrawals, remittances, dailyAccounts, expenses, newCustomers] =
    await Promise.all([
      db.contribution.findMany({
        where: contributionWhere,
        select: {
          amount: true,
          collectionDate: true,
          accountId: true,
        },
      }),
      db.withdrawal.findMany({
        where: withdrawalWhere,
        select: { netAmount: true, createdAt: true },
      }),
      db.collectorRemittance.findMany({
        where: remittanceWhere,
        select: { remittedAmount: true, variance: true, createdAt: true },
      }),
      db.dailyAccount.findMany({
        where: dailyAccountWhere,
        select: { commission: true, otherIncome: true, businessDate: true },
      }),
      db.expense.findMany({
        where: {
          tenantId,
          createdAt: { gte: range.start, lt: range.endExclusive },
          ...(scoped
            ? { dailyAccount: { locationId: locationId as string, tenantId } }
            : {}),
        },
        select: { amount: true, createdAt: true },
      }),
      scoped
        ? Promise.resolve([] as Array<{ registeredAt: Date }>)
        : db.customer.findMany({
            where: {
              tenantId,
              registeredAt: { gte: range.start, lt: range.endExclusive },
            },
            select: { registeredAt: true },
          }),
    ]);

  // Commissions are attributed to the location that recorded the related
  // contributions; otherwise they remain tenant-wide.
  const contributionAccountIds = Array.from(
    new Set(contributions.map((row) => row.accountId))
  );
  const commissions =
    scoped && contributionAccountIds.length === 0
      ? []
      : await db.commission.findMany({
          where: {
            tenantId,
            createdAt: { gte: range.start, lt: range.endExclusive },
            ...(scoped ? { accountId: { in: contributionAccountIds } } : {}),
          },
          select: { amount: true, createdAt: true },
        });

  for (const row of contributions) {
    const bucket = days.get(dayKey(row.collectionDate));
    if (!bucket) continue;
    const amount = money(row.amount);
    bucket.contributions = money(bucket.contributions + amount);
    bucket.contributionCount += 1;
    bucket.transactionCount += 1;
    bucket.accounts.add(row.accountId);
  }
  for (const row of withdrawals) {
    const bucket = days.get(dayKey(row.createdAt));
    if (!bucket) continue;
    bucket.withdrawals = money(bucket.withdrawals + money(row.netAmount));
    bucket.withdrawalCount += 1;
    bucket.transactionCount += 1;
  }
  for (const row of remittances) {
    const bucket = days.get(dayKey(row.createdAt));
    if (!bucket) continue;
    bucket.remittances = money(bucket.remittances + money(row.remittedAmount));
    bucket.remittanceVariance = money(
      bucket.remittanceVariance + money(row.variance)
    );
    bucket.remittanceCount += 1;
    bucket.transactionCount += 1;
  }
  for (const row of dailyAccounts) {
    const bucket = days.get(dayKey(row.businessDate));
    if (!bucket) continue;
    bucket.cashIncome = money(
      bucket.cashIncome + money(row.commission) + money(row.otherIncome)
    );
  }
  for (const row of expenses) {
    const bucket = days.get(dayKey(row.createdAt));
    if (!bucket) continue;
    bucket.expenses = money(bucket.expenses + money(row.amount));
    bucket.expenseCount += 1;
  }
  for (const row of commissions) {
    const bucket = days.get(dayKey(row.createdAt));
    if (!bucket) continue;
    bucket.commissions = money(bucket.commissions + money(row.amount));
  }
  for (const row of newCustomers) {
    const bucket = days.get(dayKey(row.registeredAt));
    if (!bucket) continue;
    bucket.newCustomers += 1;
  }

  return days;
}

function rowsToTotals(rows: Array<{
  contributions: unknown;
  contributionCount: number;
  withdrawals: unknown;
  withdrawalCount: number;
  commissions: unknown;
  remittances: unknown;
  remittanceVariance: unknown;
  remittanceCount: number;
  expenses: unknown;
  expenseCount: number;
  cashIncome: unknown;
  transactionCount: number;
  activeCustomers: number;
  newCustomers: number;
}>): AnalyticsTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.contributions = money(totals.contributions + money(row.contributions));
    totals.contributionCount += row.contributionCount;
    totals.withdrawals = money(totals.withdrawals + money(row.withdrawals));
    totals.withdrawalCount += row.withdrawalCount;
    totals.commissions = money(totals.commissions + money(row.commissions));
    totals.remittances = money(totals.remittances + money(row.remittances));
    totals.remittanceVariance = money(
      totals.remittanceVariance + money(row.remittanceVariance)
    );
    totals.remittanceCount += row.remittanceCount;
    totals.expenses = money(totals.expenses + money(row.expenses));
    totals.expenseCount += row.expenseCount;
    totals.cashIncome = money(totals.cashIncome + money(row.cashIncome));
    totals.transactionCount += row.transactionCount;
    totals.activeAccounts += row.activeCustomers;
    totals.newCustomers += row.newCustomers;
  }
  // Active accounts are the maximum distinct accounts seen in a day bucket:
  // summing daily distinct counts would double-count, so the refresh stores
  // the distinct per-day count and the snapshot replaces this with the period
  // distinct value from a dedicated query.
  totals.netCashFlow = money(
    totals.contributions + totals.cashIncome - totals.withdrawals - totals.expenses
  );
  return totals;
}

async function readAggregateRows(tenantId: string, scope: string, start: string, end: string) {
  return db.zeliAnalyticsDaily.findMany({
    where: { tenantId, scope, businessDate: { gte: start, lte: end } },
    orderBy: { businessDate: "asc" },
  });
}

/**
 * Rebuild the requested range. This is idempotent: each bucket is upserted by
 * (tenant, scope, date), so a retry or duplicate event cannot double-count.
 */
export async function refreshAnalyticsRange(params: {
  tenantId: string;
  scope: string;
  range: { start: Date; endExclusive: Date };
  force?: boolean;
}): Promise<{ refreshedAt: Date; rows: Awaited<ReturnType<typeof readAggregateRows>>; skipped: boolean }> {
  const startKey = dayKey(params.range.start);
  const endKey = dayKey(new Date(params.range.endExclusive.getTime() - 1));
  const existing = await db.zeliAnalyticsRefresh.findUnique({
    where: {
      tenantId_scope_rangeStart_rangeEnd: {
        tenantId: params.tenantId,
        scope: params.scope,
        rangeStart: startKey,
        rangeEnd: endKey,
      },
    },
  });
  const fresh =
    !params.force &&
    existing?.status === "ok" &&
    Date.now() - existing.refreshedAt.getTime() < REFRESH_TTL_SECONDS * 1000;
  if (fresh) {
    return {
      refreshedAt: existing!.refreshedAt,
      rows: await readAggregateRows(params.tenantId, params.scope, startKey, endKey),
      skipped: true,
    };
  }

  const started = Date.now();
  try {
    const days = await aggregateRange(
      params.tenantId,
      params.range,
      params.scope === "all" ? null : params.scope
    );
    const rows = Array.from(days.values());
    await db.$transaction(
      rows.map((row) =>
        db.zeliAnalyticsDaily.upsert({
          where: {
            tenantId_scope_businessDate: {
              tenantId: params.tenantId,
              scope: params.scope,
              businessDate: row.date,
            },
          },
          create: {
            tenantId: params.tenantId,
            scope: params.scope,
            businessDate: row.date,
            contributions: row.contributions,
            contributionCount: row.contributionCount,
            withdrawals: row.withdrawals,
            withdrawalCount: row.withdrawalCount,
            commissions: row.commissions,
            remittances: row.remittances,
            remittanceVariance: row.remittanceVariance,
            remittanceCount: row.remittanceCount,
            expenses: row.expenses,
            expenseCount: row.expenseCount,
            cashIncome: row.cashIncome,
            transactionCount: row.transactionCount,
            activeCustomers: row.accounts.size,
            newCustomers: row.newCustomers,
            refreshedAt: new Date(),
          },
          update: {
            contributions: row.contributions,
            contributionCount: row.contributionCount,
            withdrawals: row.withdrawals,
            withdrawalCount: row.withdrawalCount,
            commissions: row.commissions,
            remittances: row.remittances,
            remittanceVariance: row.remittanceVariance,
            remittanceCount: row.remittanceCount,
            expenses: row.expenses,
            expenseCount: row.expenseCount,
            cashIncome: row.cashIncome,
            transactionCount: row.transactionCount,
            activeCustomers: row.accounts.size,
            newCustomers: row.newCustomers,
            refreshedAt: new Date(),
          },
        })
      )
    );
    const refreshedAt = new Date();
    await db.zeliAnalyticsRefresh.upsert({
      where: {
        tenantId_scope_rangeStart_rangeEnd: {
          tenantId: params.tenantId,
          scope: params.scope,
          rangeStart: startKey,
          rangeEnd: endKey,
        },
      },
      create: {
        tenantId: params.tenantId,
        scope: params.scope,
        rangeStart: startKey,
        rangeEnd: endKey,
        status: "ok",
        rowCount: rows.length,
        durationMs: Date.now() - started,
        refreshedAt,
      },
      update: {
        status: "ok",
        rowCount: rows.length,
        durationMs: Date.now() - started,
        error: null,
        refreshedAt,
      },
    });
    return {
      refreshedAt,
      rows: await readAggregateRows(params.tenantId, params.scope, startKey, endKey),
      skipped: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Refresh failed";
    await db.zeliAnalyticsRefresh
      .upsert({
        where: {
          tenantId_scope_rangeStart_rangeEnd: {
            tenantId: params.tenantId,
            scope: params.scope,
            rangeStart: startKey,
            rangeEnd: endKey,
          },
        },
        create: {
          tenantId: params.tenantId,
          scope: params.scope,
          rangeStart: startKey,
          rangeEnd: endKey,
          status: "failed",
          error: message,
          durationMs: Date.now() - started,
        },
        update: {
          status: "failed",
          error: message,
          durationMs: Date.now() - started,
          refreshedAt: new Date(),
        },
      })
      .catch(() => undefined);
    throw error;
  }
}

async function safeRows(
  tenantId: string,
  scope: string,
  range: { start: Date; endExclusive: Date },
  force?: boolean
): Promise<{ rows: Awaited<ReturnType<typeof readAggregateRows>>; refreshedAt: Date; stale: boolean; warning: string | null }> {
  try {
    const result = await refreshAnalyticsRange({ tenantId, scope, range, force });
    return { rows: result.rows, refreshedAt: result.refreshedAt, stale: false, warning: null };
  } catch {
    const startKey = dayKey(range.start);
    const endKey = dayKey(new Date(range.endExclusive.getTime() - 1));
    const rows = await readAggregateRows(tenantId, scope, startKey, endKey);
    const record = await db.zeliAnalyticsRefresh.findUnique({
      where: {
        tenantId_scope_rangeStart_rangeEnd: {
          tenantId,
          scope,
          rangeStart: startKey,
          rangeEnd: endKey,
        },
      },
    });
    return {
      rows,
      refreshedAt: record?.refreshedAt ?? new Date(0),
      stale: true,
      warning:
        "Analytics could not be refreshed. Showing the last successful aggregate; use Retry to try again.",
    };
  }
}

/** Branch performance for the period. One bounded query per financial source. */
async function computeBranches(
  tenantId: string,
  range: { start: Date; endExclusive: Date }
): Promise<BranchPerformance[]> {
  const locations = await db.location.findMany({
    where: { tenantId, status: "active" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 50,
  });
  if (locations.length === 0) return [];
  const users = await db.user.findMany({
    where: { tenantId, locationId: { not: null } },
    select: { id: true, locationId: true },
  });
  const locationByUser = new Map(users.map((row) => [row.id, row.locationId!]));
  const collectors = await db.collector.findMany({
    where: { tenantId },
    select: { id: true, userId: true },
  });
  const locationByCollector = new Map(
    collectors.map((row) => [row.id, locationByUser.get(row.userId) ?? null])
  );

  const [contributions, withdrawals, remittances, expenses] = await Promise.all([
    db.contribution.findMany({
      where: { tenantId, reversedAt: null, collectionDate: { gte: range.start, lt: range.endExclusive } },
      select: { amount: true, collectorId: true, recordedById: true },
    }),
    db.withdrawal.findMany({
      where: { tenantId, status: "completed", reversedAt: null, createdAt: { gte: range.start, lt: range.endExclusive } },
      select: { netAmount: true, authorizedById: true },
    }),
    db.collectorRemittance.findMany({
      where: { tenantId, reversedAt: null, createdAt: { gte: range.start, lt: range.endExclusive } },
      select: { remittedAmount: true, collectorId: true },
    }),
    db.expense.findMany({
      where: { tenantId, createdAt: { gte: range.start, lt: range.endExclusive } },
      select: { amount: true, dailyAccount: { select: { locationId: true } } },
    }),
  ]);

  const map = new Map<string, BranchPerformance>(
    locations.map((location) => [
      location.id,
      {
        locationId: location.id,
        locationName: location.name,
        contributions: 0,
        withdrawals: 0,
        remittances: 0,
        expenses: 0,
        netCashFlow: 0,
        transactionCount: 0,
      },
    ])
  );

  for (const row of contributions) {
    const locationId = row.collectorId
      ? locationByCollector.get(row.collectorId)
      : locationByUser.get(row.recordedById);
    if (!locationId) continue;
    const branch = map.get(locationId);
    if (!branch) continue;
    branch.contributions = money(branch.contributions + money(row.amount));
    branch.transactionCount += 1;
  }
  for (const row of withdrawals) {
    const locationId = locationByUser.get(row.authorizedById);
    if (!locationId) continue;
    const branch = map.get(locationId);
    if (!branch) continue;
    branch.withdrawals = money(branch.withdrawals + money(row.netAmount));
    branch.transactionCount += 1;
  }
  for (const row of remittances) {
    const locationId = locationByCollector.get(row.collectorId);
    if (!locationId) continue;
    const branch = map.get(locationId);
    if (!branch) continue;
    branch.remittances = money(branch.remittances + money(row.remittedAmount));
    branch.transactionCount += 1;
  }
  for (const row of expenses) {
    const locationId = row.dailyAccount.locationId;
    const branch = map.get(locationId);
    if (!branch) continue;
    branch.expenses = money(branch.expenses + money(row.amount));
    branch.transactionCount += 1;
  }
  for (const branch of map.values()) {
    branch.netCashFlow = money(
      branch.contributions - branch.withdrawals - branch.expenses
    );
  }
  return Array.from(map.values()).sort((a, b) => b.netCashFlow - a.netCashFlow);
}

async function computeCollectors(
  tenantId: string,
  range: { start: Date; endExclusive: Date },
  locationId: string | null
): Promise<CollectorActivity[]> {
  const collectors = await db.collector.findMany({
    where: {
      tenantId,
      ...(locationId && locationId !== "all"
        ? { user: { locationId } }
        : {}),
    },
    select: { id: true, user: { select: { fullName: true } } },
    take: 100,
  });
  if (collectors.length === 0) return [];
  const ids = collectors.map((row) => row.id);
  const [contributions, remittances] = await Promise.all([
    db.contribution.findMany({
      where: {
        tenantId,
        collectorId: { in: ids },
        reversedAt: null,
        collectionDate: { gte: range.start, lt: range.endExclusive },
      },
      select: { collectorId: true, amount: true },
    }),
    db.collectorRemittance.findMany({
      where: {
        tenantId,
        collectorId: { in: ids },
        reversedAt: null,
        createdAt: { gte: range.start, lt: range.endExclusive },
      },
      select: { collectorId: true, remittedAmount: true },
    }),
  ]);
  const map = new Map<string, CollectorActivity>(
    collectors.map((collector) => [
      collector.id,
      {
        collectorId: collector.id,
        collectorName: collector.user.fullName,
        contributions: 0,
        contributionCount: 0,
        remittances: 0,
        remittanceCount: 0,
      },
    ])
  );
  for (const row of contributions) {
    const entry = row.collectorId ? map.get(row.collectorId) : null;
    if (!entry) continue;
    entry.contributions = money(entry.contributions + money(row.amount));
    entry.contributionCount += 1;
  }
  for (const row of remittances) {
    const entry = map.get(row.collectorId);
    if (!entry) continue;
    entry.remittances = money(entry.remittances + money(row.remittedAmount));
    entry.remittanceCount += 1;
  }
  return Array.from(map.values())
    .filter((row) => row.contributionCount > 0 || row.remittanceCount > 0)
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, 25);
}

async function computeCustomerAnalytics(
  tenantId: string,
  range: { start: Date; endExclusive: Date },
  locationId: string | null,
  series: AnalyticsSeriesPoint[]
): Promise<CustomerAnalytics> {
  const scoped = Boolean(locationId && locationId !== "all");
  const contributions = await db.contribution.findMany({
    where: {
      tenantId,
      reversedAt: null,
      collectionDate: { gte: range.start, lt: range.endExclusive },
      ...(scoped
        ? {
            OR: [
              { collector: { user: { locationId } } },
              { collectorId: null, recordedBy: { locationId } },
            ],
          }
        : {}),
    },
    select: { accountId: true, collectionDate: true },
  });
  const accountDays = new Map<string, Set<string>>();
  for (const row of contributions) {
    const key = dayKey(row.collectionDate);
    const set = accountDays.get(row.accountId) ?? new Set<string>();
    set.add(key);
    accountDays.set(row.accountId, set);
  }
  const accountIds = Array.from(accountDays.keys());
  const customers = await db.susuAccount.findMany({
    where: { tenantId, id: { in: accountIds } },
    select: { customerId: true },
    distinct: ["customerId"],
  });
  const engagementBuckets = [
    { bucket: "1 contribution", min: 1, max: 1 },
    { bucket: "2–5 contributions", min: 2, max: 5 },
    { bucket: "6–10 contributions", min: 6, max: 10 },
    { bucket: "11+ contributions", min: 11, max: Number.MAX_SAFE_INTEGER },
  ];
  const engagement = engagementBuckets.map((bucket) => ({
    bucket: bucket.bucket,
    accounts: accountIds.filter((id) => {
      const count = contributions.filter((row) => row.accountId === id).length;
      return count >= bucket.min && count <= bucket.max;
    }).length,
  }));
  const newCustomers = scoped
    ? 0
    : await db.customer.count({
        where: {
          tenantId,
          registeredAt: { gte: range.start, lt: range.endExclusive },
        },
      });
  const totalActiveAccounts = await db.susuAccount.count({
    where: { tenantId, status: "active" },
  });
  const singleContributionAccounts = engagement[0]?.accounts ?? 0;
  return {
    newCustomers,
    activeAccounts: accountIds.length,
    contributingAccounts: customers.length,
    totalActiveAccounts,
    dormantAccounts: Math.max(0, totalActiveAccounts - accountIds.length),
    singleContributionAccounts,
    engagement,
    series: series.map((point) => ({
      date: point.date,
      newCustomers: point.newCustomers,
      activeAccounts: point.activeAccounts,
    })),
  };
}

async function computeExceptions(
  tenantId: string,
  range: { start: Date; endExclusive: Date },
  locationId: string | null
): Promise<ExceptionSummary> {
  const scoped = Boolean(locationId && locationId !== "all");
  const [pendingWithdrawals, remittanceDiscrepancies, dailyAccounts, collectors, contributions] =
    await Promise.all([
      db.withdrawal.count({
        where: {
          tenantId,
          status: "pending",
          ...(scoped ? { authorizedById: { in: await locationUserIds(tenantId, locationId!) } } : {}),
        },
      }),
      db.collectorRemittance.count({
        where: {
          tenantId,
          status: "discrepancy",
          reversedAt: null,
          createdAt: { gte: range.start, lt: range.endExclusive },
        },
      }),
      db.dailyAccount.findMany({
        where: {
          tenantId,
          ...(scoped ? { locationId: locationId as string } : {}),
        },
        select: { status: true },
      }),
      db.collector.findMany({
        where: {
          tenantId,
          ...(scoped ? { user: { locationId: locationId as string } } : {}),
        },
        select: { id: true },
      }),
      db.contribution.findMany({
        where: {
          tenantId,
          collectorId: { not: null },
          reversedAt: null,
          collectionDate: { gte: range.start, lt: range.endExclusive },
          ...(scoped ? { collector: { user: { locationId: locationId as string } } } : {}),
        },
        select: { collectorId: true },
        distinct: ["collectorId"],
      }),
    ]);

  const remittanceCoverage = await db.collectorRemittance.findMany({
    where: {
      tenantId,
      reversedAt: null,
      createdAt: { gte: range.start, lt: range.endExclusive },
      ...(scoped ? { collector: { user: { locationId: locationId as string } } } : {}),
    },
    select: { collectorId: true },
    distinct: ["collectorId"],
  });
  const remitted = new Set(remittanceCoverage.map((row) => row.collectorId));
  const unpaidCollectors = contributions.filter(
    (row) => row.collectorId && !remitted.has(row.collectorId)
  ).length;
  const incomplete = dailyAccounts.filter(
    (row) => row.status === "draft" || row.status === "submitted"
  ).length;
  const awaitingReview = dailyAccounts.filter((row) => row.status === "submitted").length;
  const total =
    pendingWithdrawals + remittanceDiscrepancies + awaitingReview + unpaidCollectors;
  return {
    pendingWithdrawals,
    remittanceDiscrepancies,
    dailyAccountsAwaitingReview: awaitingReview,
    collectorsWithoutRemittance: Math.min(unpaidCollectors, collectors.length),
    incompleteDailyAccounts: incomplete,
    total,
  };
}

async function locationUserIds(tenantId: string, locationId: string): Promise<string[]> {
  const rows = await db.user.findMany({
    where: { tenantId, locationId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Build the full dashboard snapshot for one tenant and filter set. */
export async function buildAnalyticsSnapshot(params: {
  tenant: { id: string; name: string; code: string };
  filters: AnalyticsFilters;
  now?: Date;
  forceRefresh?: boolean;
}): Promise<AnalyticsSnapshot> {
  const resolved = resolvePeriod(params.filters.period, {
    from: params.filters.from,
    to: params.filters.to,
    now: params.now,
  });
  const locationId =
    params.filters.locationId && params.filters.locationId !== "all"
      ? params.filters.locationId
      : null;
  if (locationId) {
    const exists = await db.location.findFirst({
      where: { id: locationId, tenantId: params.tenant.id },
      select: { id: true, name: true },
    });
    if (!exists) throw new Error("Location not found for this business.");
  }
  const scope = locationId ?? "all";

  const previous = await safeRows(
    params.tenant.id,
    scope,
    resolved.previous,
    params.forceRefresh
  );
  const current = await safeRows(
    params.tenant.id,
    scope,
    resolved,
    params.forceRefresh
  );

  const totals = rowsToTotals(current.rows);
  const previousTotals = rowsToTotals(previous.rows);

  // Distinct accounts across the period (not the sum of daily distinct counts).
  const scoped = Boolean(locationId);
  const distinctAccounts = await db.contribution.findMany({
    where: {
      tenantId: params.tenant.id,
      reversedAt: null,
      collectionDate: { gte: resolved.start, lt: resolved.endExclusive },
      ...(scoped
        ? {
            OR: [
              { collector: { user: { locationId } } },
              { collectorId: null, recordedBy: { locationId } },
            ],
          }
        : {}),
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  totals.activeAccounts = distinctAccounts.length;

  const series: AnalyticsSeriesPoint[] = current.rows.map((row) => ({
    date: row.businessDate,
    contributions: money(row.contributions),
    withdrawals: money(row.withdrawals),
    expenses: money(row.expenses),
    income: money(row.cashIncome),
    netCashFlow: money(
      money(row.contributions) + money(row.cashIncome) - money(row.withdrawals) - money(row.expenses)
    ),
    remittances: money(row.remittances),
    transactionCount: row.transactionCount,
    activeAccounts: row.activeCustomers,
    newCustomers: row.newCustomers,
  }));

  const [branchPerformance, collectorActivity, customer, exceptions, locations] =
    await Promise.all([
      computeBranches(params.tenant.id, resolved),
      computeCollectors(params.tenant.id, resolved, locationId),
      computeCustomerAnalytics(params.tenant.id, resolved, locationId, series),
      computeExceptions(params.tenant.id, resolved, locationId),
      db.location.findMany({
        where: { tenantId: params.tenant.id, status: "active" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
  totals.newCustomers = customer.newCustomers;

  return {
    tenant: params.tenant,
    filters: {
      period: resolved.preset,
      from: params.filters.from ?? null,
      to: params.filters.to ?? null,
      locationId,
      locationName: locationId
        ? locations.find((row) => row.id === locationId)?.name ?? null
        : null,
    },
    period: {
      start: resolved.start.toISOString(),
      end: new Date(resolved.endExclusive.getTime() - 1).toISOString(),
      label: resolved.label,
      days: resolved.days,
    },
    previousPeriod: {
      start: resolved.previous.start.toISOString(),
      end: new Date(resolved.previous.endExclusive.getTime() - 1).toISOString(),
      label: resolved.previous.label,
    },
    totals,
    previousTotals,
    comparison: {
      contributionsPct: pct(totals.contributions, previousTotals.contributions),
      withdrawalsPct: pct(totals.withdrawals, previousTotals.withdrawals),
      expensesPct: pct(totals.expenses, previousTotals.expenses),
      netCashFlowPct: pct(totals.netCashFlow, previousTotals.netCashFlow),
      transactionVolumePct: pct(totals.transactionCount, previousTotals.transactionCount),
    },
    series,
    branchPerformance,
    collectorActivity,
    customer,
    exceptions,
    freshness: {
      refreshedAt: current.refreshedAt.toISOString(),
      stale: current.stale || previous.stale,
      warning: current.warning,
      source: "MaaCash financial records · ZeliAnalyticsDaily aggregate",
      ttlSeconds: REFRESH_TTL_SECONDS,
    },
    currency: "GHS",
    locations,
    reconciliation: {
      contributionSource: "Contribution rows where reversedAt is null in the selected period",
      withdrawalSource: "Completed Withdrawal rows where reversedAt is null",
      remittanceSource: "CollectorRemittance rows where reversedAt is null",
      expenseSource: "Expense rows linked to the selected period's daily accounts",
      note: `Figures reconcile with the standard reports for ${periodLabel(resolved)}. Reversed records and out-of-period records are excluded.`,
    },
  };
}

/** Force a refresh for a tenant/scope/range (used by the Refresh button). */
export async function refreshZeliAnalyticsForTenant(params: {
  tenantId: string;
  filters: AnalyticsFilters;
  now?: Date;
}): Promise<{ refreshedAt: string; period: string }> {
  const resolved = resolvePeriod(params.filters.period, {
    from: params.filters.from,
    to: params.filters.to,
    now: params.now,
  });
  const scope =
    params.filters.locationId && params.filters.locationId !== "all"
      ? params.filters.locationId
      : "all";
  const current = await refreshAnalyticsRange({
    tenantId: params.tenantId,
    scope,
    range: resolved,
    force: true,
  });
  await refreshAnalyticsRange({
    tenantId: params.tenantId,
    scope,
    range: resolved.previous,
    force: true,
  });
  return { refreshedAt: current.refreshedAt.toISOString(), period: resolved.label };
}
