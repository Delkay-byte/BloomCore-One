"use server";

import { db } from "@/lib/db";
import { getTenantContext, type TenantContext } from "@/lib/tenant";
import { resolveBranchScope } from "@/lib/branch";
import { revalidatePath } from "next/cache";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { enforceExportRateLimit } from "@/lib/security/export-rate-limit";
import { csvCell, buildCsv } from "@/lib/csv";

const MAX_EXPORT_ROWS = 50_000;
type Money = number;

/** Authenticated identity allowed to read Susu reports within branch scope. */
interface ReportIdentity extends TenantContext {
  tenantId: string;
  userId: string;
  role: string;
}

async function requireReportIdentity(): Promise<TenantContext> {
  const ctx = await getTenantContext("admin", "susu");
  if (!ctx) throw new Error("UNAUTHENTICATED");
  if (!ctx.modules.includes("susu")) throw new Error("FORBIDDEN_MODULE");
  return ctx;
}

function toMoney(value: unknown): Money {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : 0;
}

function sumMoney(rows: Array<{ amount: unknown }>): Money {
  return rows.reduce((sum, row) => sum + toMoney(row.amount), 0);
}

/**
 * Branch scope is always resolved server-side from persisted memberships.
 * A caller may only narrow to a branch they already hold; they can never
 * broaden scope beyond what the session holds.
 */
function branchWhere(
  scope: { kind: "all" } | { kind: "limited"; branchIds: string[] },
  override?: string
): { where: Record<string, unknown>; error?: string } {
  const where: Record<string, unknown> = {};
  if (scope.kind === "limited") {
    const allowed = scope.branchIds;
    if (override) {
      if (!allowed.includes(override)) {
        return { where, error: "Branch not in your authorized scope." };
      }
      where.branchId = override;
    } else {
      where.branchId = { in: allowed };
    }
  } else if (override) {
    where.branchId = override;
  }
  return { where };
}

function periodWhere(
  dateFrom?: string,
  dateTo?: string,
  field = "collectionDate"
): Record<string, { gte?: Date; lte?: Date }> | undefined {
  if (!dateFrom && !dateTo) return undefined;
  const range: Record<string, Date | undefined> = {};
  if (dateFrom) range.gte = new Date(`${dateFrom}T00:00:00.000Z`);
  if (dateTo) range.lte = new Date(`${dateTo}T23:59:59.999Z`);
  return { [field]: range } as Record<string, { gte?: Date; lte?: Date }>;
}

/** Reversal-aware: a reversal entry carries reversalOfId; an original is
 * marked reversed when reversedAt is set. Neither rewrites history. */
function reversalFilters(reversalStatus: "all" | "reversed" | "notReversed"): Record<string, unknown> {
  if (reversalStatus === "reversed") {
    return { OR: [{ reversalOfId: { not: null } }, { reversedAt: { not: null } }] };
  }
  if (reversalStatus === "notReversed") {
    return { reversalOfId: null, reversedAt: null };
  }
  return {};
}

async function baseContributionWhere(
  identity: ReportIdentity,
  params: {
    branchId?: string;
    dateFrom?: string;
    dateTo?: string;
    collectorId?: string;
    accountId?: string;
    cycleId?: string;
    channel?: string;
    reversalStatus?: "all" | "reversed" | "notReversed";
  }
): Promise<{ where: Record<string, unknown>; error?: string }> {
  const scope = await resolveBranchScope(identity);
  const branch = branchWhere(scope, params.branchId);
  if (branch.error) return branch;

  const where: Record<string, unknown> = { tenantId: identity.tenantId, ...branch.where };
  if (params.collectorId) where.collectorId = params.collectorId;
  if (params.accountId) where.accountId = params.accountId;
  if (params.cycleId) where.cycleId = params.cycleId;
  if (params.channel) where.channel = params.channel;
  const period = periodWhere(params.dateFrom, params.dateTo);
  if (period) Object.assign(where, period);
  Object.assign(where, reversalFilters(params.reversalStatus || "all"));
  return { where };
}

/** Management overview. Every figure is reversal-aware and branch scoped. */
export async function getSusuOverview(params?: {
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<{
  success: boolean;
  error?: string;
  data?: {
    period: { from: string | null; to: string | null };
    contributions: {
      grossRecorded: Money;
      reversedAmount: Money;
      netAmount: Money;
      count: number;
      reversalCount: number;
    };
    customers: { active: Money; total: Money };
    collectors: { active: Money };
    collectionActivity: { amount: Money; count: number };
    outstandingBalances: Money;
    remittanceActivity: { declared: Money; received: Money; verified: Money; count: number };
    withdrawalActivity: { requested: Money; netPaid: Money; count: number };
    unresolvedExceptions: number;
    branchComparisons: Array<{
      branchId: string;
      branchName: string;
      contributions: Money;
      remittancesDeclared: Money;
      remittancesReceived: Money;
      outstanding: Money;
    }>;
  };
}> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  const scope = await resolveBranchScope(identity);
  const branch = branchWhere(scope, params?.branchId);
  if (branch.error) return { success: false, error: branch.error };

  const period = periodWhere(params?.dateFrom, params?.dateTo);
  const base: Record<string, unknown> = { tenantId: identity.tenantId, ...branch.where };
  if (period) Object.assign(base, period);

  const [
    grossResult,
    reversedResult,
    countResult,
    reversalCountResult,
    activeCustomers,
    totalCustomers,
    activeCollectors,
    remittances,
    withdrawals,
    openDiscrepancies,
    locations,
  ] = await Promise.all([
    db.contribution.aggregate({
      where: { ...base, reversalOfId: null },
      _sum: { amount: true },
    }),
    db.contribution.aggregate({
      where: { ...base, reversalOfId: { not: null } },
      _sum: { amount: true },
    }),
    db.contribution.count({ where: { ...base, reversalOfId: null } }),
    db.contribution.count({ where: { ...base, OR: [{ reversalOfId: { not: null } }, { reversedAt: { not: null } }] } }),
    db.customer.count({ where: { status: "active", tenantId: identity.tenantId } }),
    db.customer.count({ where: { tenantId: identity.tenantId } }),
    db.collector.count({ where: { status: "active", tenantId: identity.tenantId, ...branch.where } }),
    db.collectorRemittance.findMany({
      where: { tenantId: identity.tenantId, reversedAt: null, ...branch.where },
      select: {
        declaredAmount: true,
        receivedAmount: true,
        verifiedAmount: true,
        outstandingAmount: true,
        branchId: true,
      },
    }),
    db.withdrawal.aggregate({
      where: { ...base },
      _sum: { requestedAmount: true, netAmount: true },
      _count: true,
    }),
    db.remittanceDiscrepancy.count({
      where: { tenantId: identity.tenantId, status: "open", ...branch.where },
    }),
    db.location.findMany({
      where: { tenantId: identity.tenantId, ...(scope.kind === "limited" ? { id: { in: scope.branchIds } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const grossRecorded = toMoney(grossResult._sum?.amount);
  const reversedAmount = Math.abs(toMoney(reversedResult._sum?.amount));
  const netAmount = grossRecorded - reversedAmount;

  const branchMap = new Map(locations.map((l) => [l.id, l.name]));
  const branchStats = new Map<string, { contributions: Money; declared: Money; received: Money; outstanding: Money }>();
  for (const location of locations) {
    branchStats.set(location.id, { contributions: 0, declared: 0, received: 0, outstanding: 0 });
  }

  let declared = 0;
  let received = 0;
  let verified = 0;
  let outstanding = 0;
  for (const r of remittances) {
    const d = toMoney(r.declaredAmount);
    const rcv = toMoney(r.receivedAmount);
    const v = toMoney(r.verifiedAmount);
    const out = toMoney(r.outstandingAmount);
    declared += d;
    received += rcv;
    verified += v;
    outstanding += out;
    const stats = branchStats.get(r.branchId ?? "");
    if (stats) {
      stats.declared += d;
      stats.received += rcv;
      stats.outstanding += out;
    }
  }

  // Contribution amounts per branch from the same aggregate base (grouped in one query).
  const contributionByBranch = await db.contribution.groupBy({
    by: ["branchId"],
    where: { ...base, reversalOfId: null },
    _sum: { amount: true },
  });
  for (const row of contributionByBranch) {
    const stats = branchStats.get(row.branchId ?? "");
    if (stats) stats.contributions = toMoney(row._sum?.amount);
  }

  return {
    success: true,
    data: {
      period: { from: params?.dateFrom ?? null, to: params?.dateTo ?? null },
      contributions: {
        grossRecorded,
        reversedAmount,
        netAmount,
        count: countResult,
        reversalCount: reversalCountResult,
      },
      customers: { active: activeCustomers, total: totalCustomers },
      collectors: { active: activeCollectors },
      collectionActivity: { amount: grossRecorded, count: countResult },
      outstandingBalances: outstanding,
      remittanceActivity: { declared, received, verified, count: remittances.length },
      withdrawalActivity: {
        requested: toMoney(withdrawals._sum?.requestedAmount),
        netPaid: toMoney(withdrawals._sum?.netAmount),
        count: withdrawals._count,
      },
      unresolvedExceptions: openDiscrepancies,
      branchComparisons: Array.from(branchStats.entries()).map(([branchId, stats]) => ({
        branchId,
        branchName: branchMap.get(branchId) ?? branchId,
        contributions: stats.contributions,
        remittancesDeclared: stats.declared,
        remittancesReceived: stats.received,
        outstanding: stats.outstanding,
      })),
    },
  };
}

interface ContributionReportEntry {
  id: string;
  referenceId: string;
  collectionDate: Date;
  amount: Money;
  channel: string;
  status: "reversed" | "normal";
  account: { accountId: string; customerId: string; fullName: string };
  collector?: { id: string; fullName: string };
}
interface ContributionReportPayload {
  contributions: ContributionReportEntry[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  totals: { grossRecorded: Money; reversedAmount: Money; netAmount: Money; count: number };
}

/** Contribution report: traceable rows plus reversal-aware totals. */
export async function getContributionReport(params?: {
  page?: number;
  limit?: number;
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  collectorId?: string;
  accountId?: string;
  cycleId?: string;
  channel?: string;
  reversalStatus?: "all" | "reversed" | "notReversed";
}): Promise<{ success: boolean; error?: string; data?: ContributionReportPayload }> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  const resolved = await baseContributionWhere(identity, {
    branchId: params?.branchId,
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    collectorId: params?.collectorId,
    accountId: params?.accountId,
    cycleId: params?.cycleId,
    channel: params?.channel,
    reversalStatus: params?.reversalStatus,
  });
  if (resolved.error) return { success: false, error: resolved.error };

  const page = params?.page || 1;
  const limit = Math.min(params?.limit || 50, 200);
  const skip = (page - 1) * limit;

  const reversalStatus = params?.reversalStatus || "all";

  const [rows, total] = await Promise.all([
    db.contribution.findMany({
      where: resolved.where,
      include: {
        account: { include: { customer: { select: { customerId: true, fullName: true } } } },
        collector: { include: { user: { select: { fullName: true } } } },
      },
      orderBy: { collectionDate: "desc" },
      skip,
      take: limit,
    }),
    db.contribution.count({ where: resolved.where }),
  ]);

  let gross = 0;
  let reversed = 0;
  for (const row of rows) {
    const amount = toMoney(row.amount);
    if (row.reversalOfId || row.reversedAt) reversed += amount;
    else gross += amount;
  }
  // Totals across the whole filtered set (not just this page), reversal-aware.
  const [grossResult, reversedResult, countResult] = await Promise.all([
    db.contribution.aggregate({ where: { ...resolved.where, reversalOfId: null }, _sum: { amount: true } }),
    db.contribution.aggregate({ where: { ...resolved.where, reversalOfId: { not: null } }, _sum: { amount: true } }),
    db.contribution.count({ where: resolved.where }),
  ]);

  return {
    success: true,
    data: {
      contributions: rows.map((row) => ({
        id: row.id,
        referenceId: row.referenceId,
        collectionDate: row.collectionDate,
        amount: toMoney(row.amount),
        channel: row.channel,
        status: row.reversalOfId || row.reversedAt ? ("reversed" as const) : ("normal" as const),
        account: {
          accountId: row.account.accountId,
          customerId: row.account.customer.customerId,
          fullName: row.account.customer.fullName,
        },
        collector: row.collector
          ? { id: row.collector.id, fullName: row.collector.user.fullName }
          : undefined,
      })),
      pagination: { page, limit, total: countResult, totalPages: Math.ceil(countResult / limit) },
      totals: {
        grossRecorded: toMoney(grossResult._sum?.amount),
        reversedAmount: Math.abs(toMoney(reversedResult._sum?.amount)),
        netAmount: toMoney(grossResult._sum?.amount) - Math.abs(toMoney(reversedResult._sum?.amount)),
        count: countResult,
      },
    },
  };
}

/** Collector performance: one row per collector, reversal-aware. */
export async function getCollectorPerformanceReport(params?: {
  branchId?: string;
  collectorId?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<{
  success: boolean;
  error?: string;
  data?: {
    collectors: Array<{
      id: string;
      fullName: string;
      branchId: string | null;
      contributionCount: number;
      contributionAmount: Money;
      reversedContributionCount: number;
      reversedContributionAmount: Money;
      remittanceDeclarations: number;
      declaredAmount: Money;
      receivedAmount: Money;
      verifiedAmount: Money;
      outstandingAmount: Money;
    }>;
    totals: {
      contributionCount: number;
      contributionAmount: Money;
      declaredAmount: Money;
      receivedAmount: Money;
      verifiedAmount: Money;
      outstandingAmount: Money;
    };
  };
}> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  const scope = await resolveBranchScope(identity);
  const branch = branchWhere(scope, params?.branchId);
  if (branch.error) return { success: false, error: branch.error };

  const period = periodWhere(params?.dateFrom, params?.dateTo);
  const base: Record<string, unknown> = { tenantId: identity.tenantId, ...branch.where };
  if (period) Object.assign(base, period);
  if (params?.collectorId) base.collectorId = params.collectorId;

  const collectors = await db.collector.findMany({
    where: { tenantId: identity.tenantId, status: "active", ...branch.where, ...(params?.collectorId ? { id: params.collectorId } : {}) },
    select: { id: true, branchId: true, user: { select: { fullName: true } } },
    orderBy: { createdAt: "asc" },
  });

  const result: Array<{
    id: string; fullName: string; branchId: string | null;
    contributionCount: number; contributionAmount: Money;
    reversedContributionCount: number; reversedContributionAmount: Money;
    remittanceDeclarations: number; declaredAmount: Money;
    receivedAmount: Money; verifiedAmount: Money; outstandingAmount: Money;
  }> = [];

  for (const collector of collectors) {
    const cBase = { ...base, collectorId: collector.id };
    const [contribs, reversedContribs, remittances] = await Promise.all([
      db.contribution.findMany({ where: { ...cBase, reversalOfId: null }, select: { amount: true } }),
      db.contribution.aggregate({ where: { ...cBase, reversalOfId: { not: null } }, _sum: { amount: true } }),
      db.collectorRemittance.findMany({
        where: { tenantId: identity.tenantId, collectorId: collector.id, reversedAt: null, ...branch.where },
        select: { declaredAmount: true, receivedAmount: true, verifiedAmount: true, outstandingAmount: true },
      }),
    ]);

    const contributionAmount = sumMoney(contribs);
    const declared = remittances.reduce((s, r) => s + toMoney(r.declaredAmount), 0);
    const received = remittances.reduce((s, r) => s + toMoney(r.receivedAmount), 0);
    const verified = remittances.reduce((s, r) => s + toMoney(r.verifiedAmount), 0);
    const outstanding = remittances.reduce((s, r) => s + toMoney(r.outstandingAmount), 0);

    result.push({
      id: collector.id,
      fullName: collector.user.fullName,
      branchId: collector.branchId,
      contributionCount: contribs.length,
      contributionAmount,
      reversedContributionCount: 0,
      reversedContributionAmount: Math.abs(toMoney(reversedContribs._sum?.amount)),
      remittanceDeclarations: remittances.length,
      declaredAmount: declared,
      receivedAmount: received,
      verifiedAmount: verified,
      outstandingAmount: outstanding,
    });
  }

  const totals = result.reduce(
    (acc, row) => ({
      contributionCount: acc.contributionCount + row.contributionCount,
      contributionAmount: acc.contributionAmount + row.contributionAmount,
      declaredAmount: acc.declaredAmount + row.declaredAmount,
      receivedAmount: acc.receivedAmount + row.receivedAmount,
      verifiedAmount: acc.verifiedAmount + row.verifiedAmount,
      outstandingAmount: acc.outstandingAmount + row.outstandingAmount,
    }),
    { contributionCount: 0, contributionAmount: 0, declaredAmount: 0, receivedAmount: 0, verifiedAmount: 0, outstandingAmount: 0 }
  );

  return { success: true, data: { collectors: result, totals } };
}

/** Branch report: company-wide or per-branch figures. */
export async function getBranchReport(params?: {
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<{
  success: boolean;
  error?: string;
  data?: {
    period: { from: string | null; to: string | null };
    branches: Array<{
      branchId: string;
      branchName: string;
      contributionCount: number;
      contributionAmount: Money;
      reversedAmount: Money;
      netContributionAmount: Money;
      collectorCount: number;
      remittanceCount: number;
      declaredAmount: Money;
      receivedAmount: Money;
      verifiedAmount: Money;
      outstandingAmount: Money;
      withdrawalCount: number;
      withdrawalAmount: Money;
      openDiscrepancies: number;
    }>;
    totals: {
      contributionCount: number;
      contributionAmount: Money;
      declaredAmount: Money;
      receivedAmount: Money;
      outstandingAmount: Money;
      openDiscrepancies: number;
    };
  };
}> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  const scope = await resolveBranchScope(identity);
  const branch = branchWhere(scope, params?.branchId);
  if (branch.error) return { success: false, error: branch.error };

  const period = periodWhere(params?.dateFrom, params?.dateTo, "createdAt");
  const base: Record<string, unknown> = { tenantId: identity.tenantId, ...branch.where };
  if (period) Object.assign(base, period);

  const locations = await db.location.findMany({
    where: {
      tenantId: identity.tenantId,
      ...(scope.kind === "limited" ? { id: { in: scope.branchIds } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const result: Array<{
    branchId: string; branchName: string;
    contributionCount: number; contributionAmount: Money; reversedAmount: Money; netContributionAmount: Money;
    collectorCount: number;
    remittanceCount: number; declaredAmount: Money; receivedAmount: Money; verifiedAmount: Money; outstandingAmount: Money;
    withdrawalCount: number; withdrawalAmount: Money;
    openDiscrepancies: number;
  }> = [];

  for (const location of locations) {
    const bWhere = { ...base, branchId: location.id };
    const [contribs, reversedResult, remittances, collectors, withdrawals, discrepancies] = await Promise.all([
      db.contribution.findMany({ where: { ...bWhere, reversalOfId: null }, select: { amount: true } }),
      db.contribution.aggregate({ where: { ...bWhere, reversalOfId: { not: null } }, _sum: { amount: true } }),
      db.collectorRemittance.findMany({
        where: { tenantId: identity.tenantId, branchId: location.id, reversedAt: null },
        select: { declaredAmount: true, receivedAmount: true, verifiedAmount: true, outstandingAmount: true },
      }),
      db.collector.count({ where: { tenantId: identity.tenantId, status: "active", branchId: location.id } }),
      db.withdrawal.aggregate({ where: { ...bWhere }, _sum: { netAmount: true }, _count: true }),
      db.remittanceDiscrepancy.count({
        where: { tenantId: identity.tenantId, status: "open", remittance: { branchId: location.id } },
      }),
    ]);

    const contributionAmount = sumMoney(contribs);
    const reversedAmount = Math.abs(toMoney(reversedResult._sum?.amount));
    const declared = remittances.reduce((s, r) => s + toMoney(r.declaredAmount), 0);
    const received = remittances.reduce((s, r) => s + toMoney(r.receivedAmount), 0);
    const verified = remittances.reduce((s, r) => s + toMoney(r.verifiedAmount), 0);
    const outstanding = remittances.reduce((s, r) => s + toMoney(r.outstandingAmount), 0);

    result.push({
      branchId: location.id,
      branchName: location.name,
      contributionCount: contribs.length,
      contributionAmount,
      reversedAmount,
      netContributionAmount: contributionAmount - reversedAmount,
      collectorCount: collectors,
      remittanceCount: remittances.length,
      declaredAmount: declared,
      receivedAmount: received,
      verifiedAmount: verified,
      outstandingAmount: outstanding,
      withdrawalCount: withdrawals._count,
      withdrawalAmount: toMoney(withdrawals._sum?.netAmount),
      openDiscrepancies: discrepancies,
    });
  }

  const totals = result.reduce(
    (acc, row) => ({
      contributionCount: acc.contributionCount + row.contributionCount,
      contributionAmount: acc.contributionAmount + row.contributionAmount,
      declaredAmount: acc.declaredAmount + row.declaredAmount,
      receivedAmount: acc.receivedAmount + row.receivedAmount,
      outstandingAmount: acc.outstandingAmount + row.outstandingAmount,
      openDiscrepancies: acc.openDiscrepancies + row.openDiscrepancies,
    }),
    { contributionCount: 0, contributionAmount: 0, declaredAmount: 0, receivedAmount: 0, outstandingAmount: 0, openDiscrepancies: 0 }
  );

  return {
    success: true,
    data: {
      period: { from: params?.dateFrom ?? null, to: params?.dateTo ?? null },
      branches: result,
      totals,
    },
  };
}

/** Customer / account statement. Only the account's own tenant is visible. */
export async function getCustomerStatement(accountId: string, params?: {
  dateFrom?: string;
  dateTo?: string;
}): Promise<{
  success: boolean;
  error?: string;
  data?: {
    account: { id: string; accountId: string; customerId: string; fullName: string; dailyContribution: Money; status: string };
    cycle?: { id: string; cycleNumber: number; status: string; startDate: Date; endDate: Date };
    entries: Array<{
      kind: "contribution" | "withdrawal" | "commission" | "reversal";
      date: Date;
      amount: Money;
      credit: Money;
      debit: Money;
      balance: Money;
      referenceId: string;
      reversalOf?: string | null;
    }>;
    summary: { credits: Money; debits: Money; closingBalance: Money };
  };
}> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  const scope = await resolveBranchScope(identity);
  const branch = branchWhere(scope);
  if (branch.error) return { success: false, error: branch.error };

  const contributionPeriod = periodWhere(params?.dateFrom, params?.dateTo, "collectionDate");
  const withdrawalPeriod = periodWhere(params?.dateFrom, params?.dateTo, "createdAt");
  const account = await db.susuAccount.findFirst({
    where: { id: accountId, tenantId: identity.tenantId, ...branch.where },
    include: { customer: { select: { customerId: true, fullName: true } } },
  });
  if (!account) return { success: false, error: "Account not found" };

  const cycle = await db.susuCycle.findFirst({
    where: { accountId: account.id, tenantId: identity.tenantId, status: "active" },
    orderBy: { cycleNumber: "desc" },
  });

  const [contributions, withdrawals, commissions] = await Promise.all([
    db.contribution.findMany({
      where: { accountId: account.id, tenantId: identity.tenantId, ...contributionPeriod },
      orderBy: { collectionDate: "asc" },
    }),
    db.withdrawal.findMany({
      where: { accountId: account.id, tenantId: identity.tenantId, ...withdrawalPeriod },
      orderBy: { createdAt: "asc" },
    }),
    db.commission.findMany({
      where: { accountId: account.id, tenantId: identity.tenantId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const entries: Array<{
    kind: "contribution" | "withdrawal" | "commission" | "reversal";
    date: Date;
    amount: Money;
    credit: Money;
    debit: Money;
    balance: Money;
    referenceId: string;
    reversalOf?: string | null;
  }> = [];

  for (const c of contributions) {
    const amount = toMoney(c.amount);
    const isReversal = Boolean(c.reversalOfId || c.reversedAt);
    entries.push({
      kind: isReversal ? ("reversal" as const) : ("contribution" as const),
      date: c.collectionDate,
      amount,
      credit: isReversal ? 0 : amount,
      debit: isReversal ? amount : 0,
      balance: 0,
      referenceId: c.referenceId,
      reversalOf: c.reversalOfId ?? null,
    });
  }
  for (const w of withdrawals) {
    entries.push({
      kind: "withdrawal",
      date: w.createdAt,
      amount: toMoney(w.netAmount),
      credit: 0,
      debit: toMoney(w.netAmount),
      balance: 0,
      referenceId: w.referenceId,
      reversalOf: null,
    });
  }
  for (const cm of commissions) {
    entries.push({
      kind: "commission",
      date: cm.createdAt,
      amount: toMoney(cm.amount),
      credit: 0,
      debit: toMoney(cm.amount),
      balance: 0,
      referenceId: cm.id,
      reversalOf: null,
    });
  }

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  let balance = 0;
  let credits = 0;
  let debits = 0;
  for (const entry of entries) {
    balance += entry.credit - entry.debit;
    credits += entry.credit;
    debits += entry.debit;
    entry.balance = balance;
  }

  return {
    success: true,
    data: {
      account: {
        id: account.id,
        accountId: account.accountId,
        customerId: account.customer.customerId,
        fullName: account.customer.fullName,
        dailyContribution: toMoney(account.dailyContribution),
        status: account.status,
      },
      cycle: cycle
        ? { id: cycle.id, cycleNumber: cycle.cycleNumber, status: cycle.status, startDate: cycle.startDate, endDate: cycle.endDate }
        : undefined,
      entries,
      summary: { credits, debits, closingBalance: balance },
    },
  };
}

/** Cycle report: per-cycle summary using real cycle definitions. */
export async function getCycleReport(params?: {
  page?: number;
  limit?: number;
  accountId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<{
  success: boolean;
  error?: string;
  data?: {
    cycles: Array<{
      id: string;
      cycleNumber: number;
      status: string;
      account: { accountId: string; customerId: string; fullName: string };
      startDate: Date;
      endDate: Date;
      dailyContribution: Money;
      contributionsRecorded: number;
      contributionsAmount: Money;
      reversedAmount: Money;
      netContributions: Money;
      allocatedAmount: Money;
      withdrawalCount: number;
      withdrawalAmount: Money;
      openDiscrepancies: number;
    }>;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  };
}> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  // SusuAccount and SusuCycle carry no branch attribution, so cycle reporting is
  // tenant-scoped only. Branch attribution lives on Contribution, not on the
  // account/cycle, and is reported separately in the branch report.
  const page = params?.page || 1;
  const limit = Math.min(params?.limit || 50, 200);
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { tenantId: identity.tenantId };
  if (params?.accountId) where.accountId = params.accountId;
  if (params?.status) where.status = params.status;
  if (params?.dateFrom) {
    where.startDate = { ...(where.startDate as object), gte: new Date(params.dateFrom + "T00:00:00.000Z") };
  }
  if (params?.dateTo) {
    where.startDate = { ...(where.startDate as object), lte: new Date(params.dateTo + "T23:59:59.999Z") };
  }

  const [cycles, total] = await Promise.all([
    db.susuCycle.findMany({
      where,
      include: {
        account: { include: { customer: { select: { customerId: true, fullName: true } } } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.susuCycle.count({ where }),
  ]);

  const result: Array<{
    id: string; cycleNumber: number; status: string;
    account: { accountId: string; customerId: string; fullName: string };
    startDate: Date; endDate: Date;
    dailyContribution: Money;
    contributionsRecorded: number; contributionsAmount: Money; reversedAmount: Money; netContributions: Money;
    allocatedAmount: Money;
    withdrawalCount: number; withdrawalAmount: Money;
    openDiscrepancies: number;
  }> = [];

  for (const cycle of cycles) {
    const contribWhere: Record<string, unknown> = {
      cycleId: cycle.id,
      tenantId: identity.tenantId,
    };
    const [contribs, reversedResult, allocations, withdrawals] = await Promise.all([
      db.contribution.findMany({ where: contribWhere, select: { amount: true, reversalOfId: true } }),
      db.contribution.aggregate({ where: { ...contribWhere, reversalOfId: { not: null } }, _sum: { amount: true } }),
      db.contributionAllocation.aggregate({
        where: { contribution: { cycleId: cycle.id, tenantId: identity.tenantId } },
        _sum: { amount: true },
      }),
      db.withdrawal.aggregate({ where: { cycleId: cycle.id, tenantId: identity.tenantId }, _sum: { netAmount: true }, _count: true }),
    ]);

    const contributionsAmount = sumMoney(contribs);
    const reversedAmount = Math.abs(toMoney(reversedResult._sum?.amount));
    const allocatedAmount = toMoney(allocations._sum?.amount);

    result.push({
      id: cycle.id,
      cycleNumber: cycle.cycleNumber,
      status: cycle.status,
      account: {
        accountId: cycle.account.accountId,
        customerId: cycle.account.customer.customerId,
        fullName: cycle.account.customer.fullName,
      },
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      dailyContribution: toMoney(cycle.dailyContribution),
      contributionsRecorded: contribs.length,
      contributionsAmount,
      reversedAmount,
      netContributions: contributionsAmount - reversedAmount,
      allocatedAmount,
      withdrawalCount: withdrawals._count,
      withdrawalAmount: toMoney(withdrawals._sum?.netAmount),
      openDiscrepancies: 0,
    });
  }

  return {
    success: true,
    data: {
      cycles: result,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  };
}

/** Filter dropdown options, scoped to the caller's branch authority. */
export async function getSusuReportOptions(): Promise<{
  success: boolean;
  error?: string;
  data?: {
    branches: Array<{ id: string; name: string }>;
    collectors: Array<{ id: string; fullName: string; branchId: string | null }>;
  };
}> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  const scope = await resolveBranchScope(identity);
  const branch = branchWhere(scope);
  if (branch.error) return { success: false, error: branch.error };

  const [branches, collectors] = await Promise.all([
    db.location.findMany({
      where: { tenantId: identity.tenantId, ...branch.where },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.collector.findMany({
      where: { tenantId: identity.tenantId, status: "active", ...branch.where },
      select: { id: true, branchId: true, user: { select: { fullName: true } } },
      orderBy: [{ createdAt: "asc" }],
    }),
  ]);

  return {
    success: true,
    data: {
      branches: branches.map((b) => ({ id: b.id, name: b.name })),
      collectors: collectors.map((c) => ({ id: c.id, fullName: c.user.fullName, branchId: c.branchId })),
    },
  };
}

/** CSV export of a filtered report. Complete filtered set, never one page. */
export async function exportSusuReport(params: {
  report: "contributions" | "collectors" | "branches" | "cycles";
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  collectorId?: string;
  accountId?: string;
  cycleId?: string;
  channel?: string;
  reversalStatus?: "all" | "reversed" | "notReversed";
  status?: string;
}): Promise<{
  success: boolean;
  error?: string;
  status?: number;
  retryAfter?: number;
  data?: { filename: string; csv: string };
}> {
  let identity: ReportIdentity;
  try { identity = await requireReportIdentity(); } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unauthorized" };
  }

  const rate = await enforceExportRateLimit("susuReport", identity.userId, identity.tenantId);
  if (rate) {
    return { success: false, error: "EXPORT_RATE_LIMITED", status: 429, retryAfter: rate.retryAfter };
  }

  const consumed = await consumeRateLimit(
    "finance:report_export",
    `${identity.tenantId}:${identity.userId}`,
    RATE_LIMITS.financeMutation
  );
  if (!consumed.allowed) {
    return { success: false, error: "Too many export requests. Please wait and try again." };
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `susu-${params.report}-${stamp}.csv`;

  if (params.report === "contributions") {
    const resolved = await baseContributionWhere(identity, {
      branchId: params.branchId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      collectorId: params.collectorId,
      accountId: params.accountId,
      cycleId: params.cycleId,
      channel: params.channel,
      reversalStatus: params.reversalStatus,
    });
    if (resolved.error) return { success: false, error: resolved.error };

    const rows = await db.contribution.findMany({
      where: resolved.where,
      include: {
        account: { include: { customer: { select: { customerId: true, fullName: true } } } },
        collector: { include: { user: { select: { fullName: true } } } },
      },
      orderBy: { collectionDate: "asc" },
      take: MAX_EXPORT_ROWS,
    });
    if (rows.length >= MAX_EXPORT_ROWS) {
      return { success: false, error: "Result set too large for export. Narrow the filters." };
    }

    const csv = buildCsv([
      [
        "Date", "Reference", "Customer", "Account", "Collector", "Channel",
        "Amount (GH₵)", "Reversal", "Reversal Of",
      ],
      ...rows.map((row) => [
        row.collectionDate.toISOString().slice(0, 10),
        row.referenceId,
        row.account.customer.fullName,
        row.account.accountId,
        row.collector?.user.fullName ?? "",
        row.channel,
        toMoney(row.amount),
        Boolean(row.reversalOfId || row.reversedAt) ? "yes" : "no",
        row.reversalOfId ?? "",
      ]),
    ]);
    return { success: true, data: { filename, csv } };
  }

  if (params.report === "branches") {
    const report = await getBranchReport({
      branchId: params.branchId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });
    if (!report.success) return { success: false, error: report.error };
    const csv = buildCsv([
      [
        "Branch", "Contributions", "Contribution Amount (GH₵)", "Reversed (GH₵)", "Net (GH₵)",
        "Collectors", "Remittances", "Declared (GH₵)", "Received (GH₵)", "Verified (GH₵)", "Outstanding (GH₵)", "Open Discrepancies",
      ],
      ...report.data!.branches.map((b) => [
        b.branchName,
        b.contributionCount,
        b.contributionAmount,
        b.reversedAmount,
        b.netContributionAmount,
        b.collectorCount,
        b.remittanceCount,
        b.declaredAmount,
        b.receivedAmount,
        b.verifiedAmount,
        b.outstandingAmount,
        b.openDiscrepancies,
      ]),
    ]);
    return { success: true, data: { filename, csv } };
  }

  if (params.report === "collectors") {
    const report = await getCollectorPerformanceReport({
      branchId: params.branchId,
      collectorId: params.collectorId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });
    if (!report.success) return { success: false, error: report.error };
    const csv = buildCsv([
      [
        "Collector", "Branch", "Contributions", "Contribution Amount (GH₵)", "Reversed Amount (GH₵)",
        "Remittance Declarations", "Declared (GH₵)", "Received (GH₵)", "Verified (GH₵)", "Outstanding (GH₵)",
      ],
      ...report.data!.collectors.map((c) => [
        c.fullName,
        c.branchId ?? "",
        c.contributionCount,
        c.contributionAmount,
        c.reversedContributionAmount,
        c.remittanceDeclarations,
        c.declaredAmount,
        c.receivedAmount,
        c.verifiedAmount,
        c.outstandingAmount,
      ]),
    ]);
    return { success: true, data: { filename, csv } };
  }

  return { success: false, error: "Unsupported report." };
}
