"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu } from "@/lib/tenant";

export interface HistoryTransaction {
  id: string;
  type: "contribution" | "withdrawal" | "remittance";
  date: Date;
  amount: number;
  channel?: string;
  status?: string;
  customerName: string;
  customerId: string;
  accountId: string;
  collectorName?: string;
  receivedByName?: string;
  recordedByName?: string;
  notes?: string;
  referenceId?: string;
}

export interface HistorySummary {
  totalContributions: number;
  totalOfficeContributions: number;
  totalCollectorContributions: number;
  totalWithdrawals: number;
  totalRemittances: number;
  transactionCount: number;
}

function getDateRange(preset?: string, dateFrom?: string, dateTo?: string): { gte: Date; lte: Date } {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  switch (preset) {
    case "today":
      return { gte: todayStart, lte: new Date(todayStart.getTime() + 86400000) };
    case "yesterday": {
      const yesterdayStart = new Date(todayStart.getTime() - 86400000);
      return { gte: yesterdayStart, lte: todayStart };
    }
    case "24h":
      return { gte: new Date(now.getTime() - 86400000), lte: now };
    case "48h":
      return { gte: new Date(now.getTime() - 2 * 86400000), lte: now };
    case "7d":
      return { gte: new Date(todayStart.getTime() - 6 * 86400000), lte: new Date(todayStart.getTime() + 86400000) };
    case "30d":
      return { gte: new Date(todayStart.getTime() - 29 * 86400000), lte: new Date(todayStart.getTime() + 86400000) };
    case "custom": {
      const gte = dateFrom ? new Date(dateFrom + "T00:00:00.000Z") : new Date(0);
      const lte = dateTo ? new Date(dateTo + "T23:59:59.999Z") : now;
      return { gte, lte };
    }
    default:
      return { gte: new Date(0), lte: now };
  }
}

export async function getFinancialHistory(params?: {
  datePreset?: string;
  dateFrom?: string;
  dateTo?: string;
  transactionType?: string;
  channel?: string;
  customerId?: string;
  staffId?: string;
  collectorId?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  const ctx = await requireTenantAdminSusu();
  const tenantId = ctx.tenantId;

  const page = params?.page || 1;
  const limit = params?.limit || 50;
  const skip = (page - 1) * limit;
  const dateRange = getDateRange(params?.datePreset, params?.dateFrom, params?.dateTo);
  const type = params?.transactionType || "";

  const transactions: HistoryTransaction[] = [];
  let totalContributions = 0;
  let totalOfficeContributions = 0;
  let totalCollectorContributions = 0;
  let totalWithdrawals = 0;
  let totalRemittances = 0;

  // Fetch contributions if needed
  if (!type || type === "contributions") {
    const contribWhere: Record<string, unknown> = {
      tenantId,
      collectionDate: { gte: dateRange.gte, lte: dateRange.lte },
    };
    if (params?.channel) contribWhere.channel = params.channel;
    if (params?.collectorId) contribWhere.collectorId = params.collectorId;
    if (params?.customerId) {
      const customerAccounts = await db.susuAccount.findMany({
        where: { customerId: params.customerId, tenantId },
        select: { id: true },
      });
      contribWhere.accountId = { in: customerAccounts.map((a) => a.id) };
    }
    if (params?.staffId) {
      contribWhere.OR = [
        { recordedById: params.staffId },
        { receivedById: params.staffId },
      ];
    }

    const [contributions, contribCount] = await Promise.all([
      db.contribution.findMany({
        where: contribWhere,
        include: {
          account: { include: { customer: { select: { customerId: true, fullName: true } } } },
          collector: { include: { user: { select: { fullName: true } } } },
          recordedBy: { select: { fullName: true } },
          receivedBy: { select: { fullName: true } },
        },
        orderBy: { collectionDate: "desc" },
        skip,
        take: limit,
      }),
      db.contribution.count({ where: contribWhere }),
    ]);

    totalContributions = contribCount;

    // Calculate sub-totals across ALL matching records (not just this page)
    const [officeAgg, collectorAgg] = await Promise.all([
      db.contribution.aggregate({
        where: { ...contribWhere, channel: "direct_office" },
        _sum: { amount: true },
      }),
      db.contribution.aggregate({
        where: { ...contribWhere, channel: "collector" },
        _sum: { amount: true },
      }),
    ]);
    totalOfficeContributions = Number(officeAgg._sum.amount || 0);
    totalCollectorContributions = Number(collectorAgg._sum.amount || 0);

    for (const c of contributions) {
      transactions.push({
        id: c.id,
        type: "contribution",
        date: c.collectionDate,
        amount: Number(c.amount),
        channel: c.channel,
        status: "completed",
        customerName: c.account.customer.fullName,
        customerId: c.account.customer.customerId,
        accountId: c.account.accountId,
        collectorName: c.collector?.user?.fullName,
        receivedByName: c.receivedByName || c.receivedBy?.fullName || undefined,
        recordedByName: c.recordedByName || c.recordedBy?.fullName || undefined,
        notes: c.notes || undefined,
        referenceId: c.referenceId,
      });
    }
  }

  // Fetch withdrawals if needed
  if (!type || type === "withdrawals") {
    const withdrawalWhere: Record<string, unknown> = {
      tenantId,
      createdAt: { gte: dateRange.gte, lte: dateRange.lte },
    };
    if (params?.customerId) {
      const customerAccounts = await db.susuAccount.findMany({
        where: { customerId: params.customerId, tenantId },
        select: { id: true },
      });
      withdrawalWhere.accountId = { in: customerAccounts.map((a) => a.id) };
    }
    if (params?.status) withdrawalWhere.status = params.status;

    const [withdrawals, withdrawalCount] = await Promise.all([
      db.withdrawal.findMany({
        where: withdrawalWhere,
        include: {
          account: { include: { customer: { select: { customerId: true, fullName: true } } } },
        },
        orderBy: { createdAt: "desc" },
        skip: type === "withdrawals" ? skip : 0,
        take: type === "withdrawals" ? limit : 1000,
      }),
      db.withdrawal.count({ where: withdrawalWhere }),
    ]);

    totalWithdrawals = withdrawalCount;

    const withdrawalAgg = await db.withdrawal.aggregate({
      where: withdrawalWhere,
      _sum: { netAmount: true },
    });
    totalWithdrawals = Number(withdrawalAgg._sum.netAmount || 0);

    for (const w of withdrawals) {
      transactions.push({
        id: w.id,
        type: "withdrawal",
        date: w.createdAt,
        amount: Number(w.netAmount),
        status: w.status,
        customerName: w.account.customer.fullName,
        customerId: w.account.customer.customerId,
        accountId: w.account.accountId,
        notes: w.notes || undefined,
        referenceId: w.referenceId,
      });
    }
  }

  // Fetch remittances (money handed in) if needed
  if (!type || type === "remittances") {
    const remitWhere: Record<string, unknown> = {
      tenantId,
      createdAt: { gte: dateRange.gte, lte: dateRange.lte },
    };
    if (params?.collectorId) remitWhere.collectorId = params.collectorId;

    const [remittances] = await Promise.all([
      db.collectorRemittance.findMany({
        where: remitWhere,
        include: {
          collector: { include: { user: { select: { fullName: true } } } },
        },
        orderBy: { createdAt: "desc" },
        skip: type === "remittances" ? skip : 0,
        take: type === "remittances" ? limit : 1000,
      }),
      db.collectorRemittance.count({ where: remitWhere }),
    ]);

    const remitAgg = await db.collectorRemittance.aggregate({
      where: remitWhere,
      _sum: { remittedAmount: true },
    });
    totalRemittances = Number(remitAgg._sum.remittedAmount || 0);

    for (const r of remittances) {
      transactions.push({
        id: r.id,
        type: "remittance",
        date: r.createdAt,
        amount: Number(r.remittedAmount),
        status: r.status,
        customerName: r.collector.user.fullName,
        customerId: "—",
        accountId: "—",
        collectorName: r.collector.user.fullName,
        notes: r.notes || undefined,
        referenceId: r.referenceId,
      });
    }
  }

  // Sort combined transactions by date descending
  transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const summary: HistorySummary = {
    totalContributions: totalOfficeContributions + totalCollectorContributions,
    totalOfficeContributions,
    totalCollectorContributions,
    totalWithdrawals,
    totalRemittances,
    transactionCount: totalContributions + totalWithdrawals + totalRemittances,
  };

  return {
    transactions: transactions.slice(skip, skip + limit),
    summary,
    pagination: {
      page,
      limit,
      total: transactions.length,
      totalPages: Math.ceil(transactions.length / limit),
    },
  };
}

export async function searchCollectors(query: string) {
  const ctx = await requireTenantAdminSusu();

  if (!query || query.length < 2) return [];

  const normalizedQuery = query.trim().toLowerCase();

  const candidates = await db.collector.findMany({
    where: { status: "active", tenantId: ctx.tenantId },
    include: { user: { select: { id: true, fullName: true, email: true } } },
    take: 100,
  });

  return candidates
    .filter((c) => c.user.fullName.toLowerCase().includes(normalizedQuery))
    .slice(0, 20)
    .map((c) => ({
      id: c.id,
      label: c.user.fullName,
      subLabel: c.user.email,
    }));
}
