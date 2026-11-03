"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";

export interface MoMoHistoryRecord {
  id: string;
  dailyAccountId: string;
  date: Date;
  businessDate: Date;
  locationName: string;
  locationId: string;
  workerName: string;
  workerId: string;
  type: string;
  amount: number;
  status: string;
  notes: string;
}

export interface MoMoHistorySummary {
  totalCashIn: number;
  totalCashOut: number;
  totalCashReceived: number;
  totalCashPaid: number;
  totalExpenses: number;
  totalCommission: number;
  totalOtherIncome: number;
  totalMomoAdded: number;
  totalMomoPaid: number;
  recordCount: number;
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

export async function getMoMoHistory(params?: {
  datePreset?: string;
  dateFrom?: string;
  dateTo?: string;
  transactionType?: string;
  locationId?: string;
  workerId?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  const ctx = await requireTenantAdminMomo();

  const page = params?.page || 1;
  const limit = params?.limit || 50;
  const skip = (page - 1) * limit;
  const dateRange = getDateRange(params?.datePreset, params?.dateFrom, params?.dateTo);
  const type = params?.transactionType || "";

  const where: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    businessDate: { gte: dateRange.gte, lte: dateRange.lte },
  };
  if (params?.locationId) where.locationId = params.locationId;
  if (params?.workerId) where.workerId = params.workerId;
  if (params?.status) where.status = params.status;

  const [dailyAccounts, total] = await Promise.all([
    db.dailyAccount.findMany({
      where,
      include: {
        location: { select: { id: true, name: true } },
        worker: { select: { id: true, fullName: true } },
        expenses: true,
      },
      orderBy: { businessDate: "desc" },
      skip,
      take: limit,
    }),
    db.dailyAccount.count({ where }),
  ]);

  // Build history records from DailyAccount entries
  const records: MoMoHistoryRecord[] = [];

  for (const account of dailyAccounts) {
    const locName = account.location.name;
    const workName = account.worker.fullName;
    const base = {
      dailyAccountId: account.id,
      date: account.createdAt,
      businessDate: account.businessDate,
      locationName: locName,
      locationId: account.locationId,
      workerName: workName,
      workerId: account.workerId,
      status: account.status,
    };

    // Cash In
    if (!type || type === "cash_in") {
      if (Number(account.totalCashIn) > 0) {
        records.push({
          ...base,
          id: `${account.id}-cashin`,
          type: "Cash Received",
          amount: Number(account.totalCashIn),
          notes: `Cash in for ${locName}`,
        });
      }
    }

    // Cash Out
    if (!type || type === "cash_out") {
      if (Number(account.totalCashOut) > 0) {
        records.push({
          ...base,
          id: `${account.id}-cashout`,
          type: "Cash Paid Out",
          amount: Number(account.totalCashOut),
          notes: `Cash out for ${locName}`,
        });
      }
    }

    // MoMo Float Added
    if (!type || type === "momo_added") {
      const momoAdded = Number(account.closingMomoFloat) - Number(account.openingMomoFloat);
      if (momoAdded > 0) {
        records.push({
          ...base,
          id: `${account.id}-momoadd`,
          type: "Money Added to MoMo",
          amount: momoAdded,
          notes: `MoMo float: ${formatDecimal(account.openingMomoFloat)} → ${formatDecimal(account.closingMomoFloat)}`,
        });
      }
    }

    // MoMo Float Paid Out
    if (!type || type === "momo_paid") {
      const momoPaid = Number(account.openingMomoFloat) - Number(account.closingMomoFloat);
      if (momoPaid > 0) {
        records.push({
          ...base,
          id: `${account.id}-momopaid`,
          type: "Money Paid from MoMo",
          amount: momoPaid,
          notes: `MoMo float: ${formatDecimal(account.openingMomoFloat)} → ${formatDecimal(account.closingMomoFloat)}`,
        });
      }
    }

    // Commission
    if (!type || type === "commission") {
      if (Number(account.commission) > 0) {
        records.push({
          ...base,
          id: `${account.id}-commission`,
          type: "Commission Earned",
          amount: Number(account.commission),
          notes: "Commission from MoMo transactions",
        });
      }
    }

    // Other Income
    if (!type || type === "other_income") {
      if (Number(account.otherIncome) > 0) {
        records.push({
          ...base,
          id: `${account.id}-otherincome`,
          type: "Other Money Received",
          amount: Number(account.otherIncome),
          notes: "Other income recorded",
        });
      }
    }

    // Expenses
    if (!type || type === "expenses") {
      for (const expense of account.expenses) {
        records.push({
          ...base,
          id: expense.id,
          type: "Business Expense",
          amount: Number(expense.amount),
          notes: expense.description,
        });
      }
    }

    // Reconciliation
    if (!type || type === "reconciliation") {
      if (account.reconciliationNote) {
        records.push({
          ...base,
          id: `${account.id}-recon`,
          type: "Reconciliation Record",
          amount: 0,
          notes: account.reconciliationNote,
        });
      }
    }
  }

  // Sort by business date descending, then by type
  records.sort((a, b) => new Date(b.businessDate).getTime() - new Date(a.businessDate).getTime());

  // Calculate summary from ALL matching accounts (not just this page)
  const allAccounts = await db.dailyAccount.findMany({
    where,
    include: { expenses: true },
  });

  const summary: MoMoHistorySummary = {
    totalCashIn: allAccounts.reduce((sum, a) => sum + Number(a.totalCashIn), 0),
    totalCashOut: allAccounts.reduce((sum, a) => sum + Number(a.totalCashOut), 0),
    totalCashReceived: allAccounts.reduce((sum, a) => sum + Number(a.totalCashReceived), 0),
    totalCashPaid: allAccounts.reduce((sum, a) => sum + Number(a.totalCashPaid), 0),
    totalExpenses: allAccounts.reduce((sum, a) => sum + Number(a.totalExpenses), 0),
    totalCommission: allAccounts.reduce((sum, a) => sum + Number(a.commission), 0),
    totalOtherIncome: allAccounts.reduce((sum, a) => sum + Number(a.otherIncome), 0),
    totalMomoAdded: allAccounts.reduce((sum, a) => {
      const diff = Number(a.closingMomoFloat) - Number(a.openingMomoFloat);
      return sum + (diff > 0 ? diff : 0);
    }, 0),
    totalMomoPaid: allAccounts.reduce((sum, a) => {
      const diff = Number(a.openingMomoFloat) - Number(a.closingMomoFloat);
      return sum + (diff > 0 ? diff : 0);
    }, 0),
    recordCount: total,
  };

  return {
    records: records.slice(skip, skip + limit),
    summary,
    pagination: {
      page,
      limit,
      total: records.length,
      totalPages: Math.ceil(records.length / limit),
    },
  };
}

function formatDecimal(val: unknown): string {
  const num = Number(val);
  return isNaN(num) ? "0.00" : num.toFixed(2);
}

export async function searchLocations(query: string) {
  const ctx = await requireTenantAdminMomo();

  if (!query || query.length < 2) return [];

  const normalizedQuery = query.trim().toLowerCase();

  const candidates = await db.location.findMany({
    where: { status: "active", tenantId: ctx.tenantId },
    select: { id: true, name: true, code: true },
    take: 100,
  });

  return candidates
    .filter((l) => l.name.toLowerCase().includes(normalizedQuery) || l.code.toLowerCase().includes(normalizedQuery))
    .slice(0, 20)
    .map((l) => ({
      id: l.id,
      label: l.name,
      subLabel: l.code,
    }));
}

export async function searchWorkers(query: string) {
  const ctx = await requireTenantAdminMomo();

  if (!query || query.length < 2) return [];

  const normalizedQuery = query.trim().toLowerCase();

  const candidates = await db.user.findMany({
    where: { status: "active", role: "worker", tenantId: ctx.tenantId },
    select: { id: true, fullName: true, email: true },
    take: 100,
  });

  return candidates
    .filter((u) => u.fullName.toLowerCase().includes(normalizedQuery) || u.email.toLowerCase().includes(normalizedQuery))
    .slice(0, 20)
    .map((u) => ({
      id: u.id,
      label: u.fullName,
      subLabel: u.email,
    }));
}
