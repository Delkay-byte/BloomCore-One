/**
 * Business performance reporting rules.
 *
 * The daily account remains the financial source of truth. Ledger transactions
 * are used for operational counts only, never added to revenue a second time.
 * Principal cash-in/cash-out is presented as volume, not income. Only
 * submitted or reviewed accounts count as confirmed performance; draft
 * accounts are reported separately.
 */

export interface PerformanceAccountRow {
  id: string;
  businessDate: Date | string;
  locationId: string;
  status: string;
  ledgerMode: string;
  commission: unknown;
  otherIncome: unknown;
  debtsCollected: unknown;
  totalExpenses: unknown;
  totalCashIn: unknown;
  totalCashOut: unknown;
  totalAirtimeSold: unknown;
  calculatedDifference: unknown;
}

export interface PerformanceLedgerRow {
  id: string;
  type: string;
  status: string;
  businessDate: Date | string;
  locationId: string;
  dailyAccountId: string | null;
}

export interface PerformanceTransferRow {
  id: string;
  status: string;
  amount: unknown;
  createdAt: Date | string;
  sourceLocationId: string;
}

export interface PerformanceShiftRow {
  id: string;
  status: string;
  businessDate: Date | string;
  locationId: string;
  cashVariance: unknown;
  floatVariance: unknown;
}

export interface PerformanceLocation {
  id: string;
  name: string;
}

export interface PerformanceInput {
  from: string;
  to: string;
  locations: PerformanceLocation[];
  accounts: PerformanceAccountRow[];
  ledger: PerformanceLedgerRow[];
  transfers?: PerformanceTransferRow[];
  shifts?: PerformanceShiftRow[];
}

export interface PerformanceTotals {
  /** Commission plus other income. Debts collected is recovery, not revenue. */
  revenue: number;
  commission: number;
  otherIncome: number;
  expenses: number;
  netOperating: number;
  debtsCollected: number;
  cashIn: number;
  cashOut: number;
  airtimeSold: number;
  netVariance: number;
  transactionCount: number;
  submittedDays: number;
  reviewedDays: number;
  draftDays: number;
  shortageDays: number;
  unreviewedDays: number;
}

export interface PerformanceDay {
  date: string;
  revenue: number;
  expenses: number;
  netOperating: number;
  cashIn: number;
  cashOut: number;
  transactionCount: number;
  submittedDays: number;
}

export interface PerformanceLocationRow {
  locationId: string;
  locationName: string;
  revenue: number;
  expenses: number;
  netOperating: number;
  debtsCollected: number;
  cashIn: number;
  cashOut: number;
  transactionCount: number;
  submittedDays: number;
  draftDays: number;
  shortageDays: number;
  netVariance: number;
}

export interface PerformanceReport {
  period: { from: string; to: string; days: number };
  totals: PerformanceTotals;
  drafts: {
    days: number;
    revenue: number;
    expenses: number;
    netOperating: number;
    cashIn: number;
    cashOut: number;
  };
  byDay: PerformanceDay[];
  byLocation: PerformanceLocationRow[];
  completeness: {
    activeLocations: number;
    expectedLocationDays: number;
    locationDaysWithoutAccount: number;
    ledgerOnlyTransactions: number;
    openTransfers: number;
    completedTransfers: number;
    completedTransferAmount: number;
    openTransferAmount: number;
    shifts: number;
    shiftVariances: number;
    shiftVarianceAmount: number;
  };
  source: {
    financial: string;
    operational: string;
    confirmedStatuses: string[];
    definitions: {
      revenue: string;
      expenses: string;
      netOperating: string;
      cashMovement: string;
    };
  };
}

export interface PerformanceDelta {
  metric: "revenue" | "expenses" | "netOperating" | "cashIn" | "cashOut";
  current: number;
  previous: number;
  change: number;
  changePercent: number | null;
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function dayKey(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function inclusiveDays(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const days: string[] = [];
  for (
    let cursor = start.getTime();
    cursor <= end.getTime() && days.length < 370;
    cursor += 86_400_000
  ) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

const CONFIRMED = new Set(["submitted", "reviewed"]);

/** Resolve a safe default period (last 30 calendar days, inclusive). */
export function resolvePerformancePeriod(
  from?: string | null,
  to?: string | null
): { from: string; to: string } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date();
  const fallbackTo = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  const fallbackFrom = new Date(fallbackTo.getTime() - 29 * 86_400_000);
  const valid = (value?: string | null) =>
    value && dateOnly.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
      ? value
      : null;
  let safeFrom = valid(from) ?? fallbackFrom.toISOString().slice(0, 10);
  const safeTo = valid(to) ?? fallbackTo.toISOString().slice(0, 10);
  if (safeFrom > safeTo) safeFrom = safeTo;
  return { from: safeFrom, to: safeTo };
}

export function previousPerformancePeriod(period: { from: string; to: string }): {
  from: string;
  to: string;
} {
  const from = new Date(`${period.from}T00:00:00.000Z`).getTime();
  const to = new Date(`${period.to}T00:00:00.000Z`).getTime();
  const days = Math.round((to - from) / 86_400_000) + 1;
  const prevTo = new Date(from - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);
  return {
    from: prevFrom.toISOString().slice(0, 10),
    to: prevTo.toISOString().slice(0, 10),
  };
}

export function isConfirmedAccountStatus(status: string): boolean {
  return CONFIRMED.has(status);
}

export function buildPerformanceReport(input: PerformanceInput): PerformanceReport {
  const days = inclusiveDays(input.from, input.to);
  const daySet = new Set(days);
  const locationNames = new Map(input.locations.map((row) => [row.id, row.name]));

  const accounts = input.accounts.filter((row) => daySet.has(dayKey(row.businessDate)));
  const ledger = input.ledger.filter((row) => daySet.has(dayKey(row.businessDate)));
  const confirmed = accounts.filter((row) => isConfirmedAccountStatus(row.status));
  const drafts = accounts.filter((row) => !isConfirmedAccountStatus(row.status));

  const ledgerCountByDay = new Map<string, number>();
  const ledgerCountByLocation = new Map<string, number>();
  for (const row of ledger) {
    if (row.status !== "recorded") continue;
    const key = dayKey(row.businessDate);
    ledgerCountByDay.set(key, (ledgerCountByDay.get(key) ?? 0) + 1);
    ledgerCountByLocation.set(
      row.locationId,
      (ledgerCountByLocation.get(row.locationId) ?? 0) + 1
    );
  }

  const dayMap = new Map<string, PerformanceDay>();
  const locationMap = new Map<string, PerformanceLocationRow>();
  const submittedKeys = new Set<string>();

  const blankDay = (date: string): PerformanceDay => ({
    date,
    revenue: 0,
    expenses: 0,
    netOperating: 0,
    cashIn: 0,
    cashOut: 0,
    transactionCount: ledgerCountByDay.get(date) ?? 0,
    submittedDays: 0,
  });
  for (const day of days) dayMap.set(day, blankDay(day));

  const blankLocation = (id: string): PerformanceLocationRow => ({
    locationId: id,
    locationName: locationNames.get(id) ?? "Unknown location",
    revenue: 0,
    expenses: 0,
    netOperating: 0,
    debtsCollected: 0,
    cashIn: 0,
    cashOut: 0,
    transactionCount: ledgerCountByLocation.get(id) ?? 0,
    submittedDays: 0,
    draftDays: 0,
    shortageDays: 0,
    netVariance: 0,
  });
  for (const location of input.locations) locationMap.set(location.id, blankLocation(location.id));

  const totals: PerformanceTotals = {
    revenue: 0,
    commission: 0,
    otherIncome: 0,
    expenses: 0,
    netOperating: 0,
    debtsCollected: 0,
    cashIn: 0,
    cashOut: 0,
    airtimeSold: 0,
    netVariance: 0,
    transactionCount: 0,
    submittedDays: 0,
    reviewedDays: 0,
    draftDays: 0,
    shortageDays: 0,
    unreviewedDays: 0,
  };

  for (const account of confirmed) {
    const commission = money(account.commission);
    const otherIncome = money(account.otherIncome);
    const expenses = money(account.totalExpenses);
    const revenue = money(commission + otherIncome);
    const netOperating = money(revenue - expenses);
    const cashIn = money(account.totalCashIn);
    const cashOut = money(account.totalCashOut);
    const debtsCollected = money(account.debtsCollected);
    const airtimeSold = money(account.totalAirtimeSold);
    const variance = money(account.calculatedDifference);
    const date = dayKey(account.businessDate);

    const day = dayMap.get(date) ?? blankDay(date);
    day.revenue = money(day.revenue + revenue);
    day.expenses = money(day.expenses + expenses);
    day.netOperating = money(day.netOperating + netOperating);
    day.cashIn = money(day.cashIn + cashIn);
    day.cashOut = money(day.cashOut + cashOut);
    day.submittedDays += 1;
    dayMap.set(date, day);

    const location = locationMap.get(account.locationId) ?? blankLocation(account.locationId);
    location.revenue = money(location.revenue + revenue);
    location.expenses = money(location.expenses + expenses);
    location.netOperating = money(location.netOperating + netOperating);
    location.debtsCollected = money(location.debtsCollected + debtsCollected);
    location.cashIn = money(location.cashIn + cashIn);
    location.cashOut = money(location.cashOut + cashOut);
    location.submittedDays += 1;
    location.netVariance = money(location.netVariance + variance);
    if (variance < 0) location.shortageDays += 1;
    locationMap.set(account.locationId, location);

    totals.revenue = money(totals.revenue + revenue);
    totals.commission = money(totals.commission + commission);
    totals.otherIncome = money(totals.otherIncome + otherIncome);
    totals.expenses = money(totals.expenses + expenses);
    totals.netOperating = money(totals.netOperating + netOperating);
    totals.debtsCollected = money(totals.debtsCollected + debtsCollected);
    totals.cashIn = money(totals.cashIn + cashIn);
    totals.cashOut = money(totals.cashOut + cashOut);
    totals.airtimeSold = money(totals.airtimeSold + airtimeSold);
    totals.netVariance = money(totals.netVariance + variance);
    totals.submittedDays += 1;
    if (account.status === "reviewed") totals.reviewedDays += 1;
    if (variance < 0) totals.shortageDays += 1;
    if (account.status === "submitted") totals.unreviewedDays += 1;

    submittedKeys.add(`${account.locationId}:${date}`);
  }

  for (const account of drafts) {
    totals.draftDays += 1;
    const location = locationMap.get(account.locationId) ?? blankLocation(account.locationId);
    location.draftDays += 1;
    locationMap.set(account.locationId, location);
  }

  const draftTotals = drafts.reduce(
    (accumulator, account) => {
      const revenue = money(money(account.commission) + money(account.otherIncome));
      const expenses = money(account.totalExpenses);
      accumulator.revenue = money(accumulator.revenue + revenue);
      accumulator.expenses = money(accumulator.expenses + expenses);
      accumulator.netOperating = money(accumulator.netOperating + revenue - expenses);
      accumulator.cashIn = money(accumulator.cashIn + money(account.totalCashIn));
      accumulator.cashOut = money(accumulator.cashOut + money(account.totalCashOut));
      return accumulator;
    },
    { revenue: 0, expenses: 0, netOperating: 0, cashIn: 0, cashOut: 0 }
  );

  const activeLocationIds = input.locations.map((location) => location.id);
  const distinctSubmitted = new Set(
    confirmed.map((account) => `${account.locationId}:${dayKey(account.businessDate)}`)
  );
  const distinctDraft = new Set(
    drafts.map((account) => `${account.locationId}:${dayKey(account.businessDate)}`)
  );
  const expectedLocationDays = activeLocationIds.length * days.length;
  const locationDaysWithoutAccount = Math.max(
    0,
    expectedLocationDays - distinctSubmitted.size - distinctDraft.size
  );

  totals.transactionCount = ledger.filter((row) => row.status === "recorded").length;

  const transfers = (input.transfers ?? []).filter((row) => {
    const date = dayKey(row.createdAt);
    return daySet.has(date);
  });
  const openTransferStatuses = new Set([
    "draft",
    "requested",
    "approved",
    "dispatched",
    "variance_investigation",
    "disputed",
  ]);
  const shifts = (input.shifts ?? []).filter((row) => daySet.has(dayKey(row.businessDate)));

  return {
    period: { from: input.from, to: input.to, days: days.length },
    totals,
    drafts: {
      days: drafts.length,
      ...draftTotals,
    },
    byDay: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byLocation: Array.from(locationMap.values()).sort((a, b) =>
      a.locationName.localeCompare(b.locationName)
    ),
    completeness: {
      activeLocations: activeLocationIds.length,
      expectedLocationDays,
      locationDaysWithoutAccount,
      ledgerOnlyTransactions: ledger.filter(
        (row) => row.status === "recorded" && !row.dailyAccountId
      ).length,
      openTransfers: transfers.filter((row) => openTransferStatuses.has(row.status)).length,
      completedTransfers: transfers.filter((row) => row.status === "completed").length,
      completedTransferAmount: money(
        transfers
          .filter((row) => row.status === "completed")
          .reduce((sum, row) => sum + money(row.amount), 0)
      ),
      openTransferAmount: money(
        transfers
          .filter((row) => openTransferStatuses.has(row.status))
          .reduce((sum, row) => sum + money(row.amount), 0)
      ),
      shifts: shifts.length,
      shiftVariances: shifts.filter(
        (row) => money(row.cashVariance) !== 0 || money(row.floatVariance) !== 0
      ).length,
      shiftVarianceAmount: money(
        shifts.reduce(
          (sum, row) => sum + money(row.cashVariance) + money(row.floatVariance),
          0
        )
      ),
    },
    source: {
      financial:
        "Commission plus other income from daily accounts with status submitted or reviewed. Debt recovery and principal volume are excluded.",
      operational:
        "Recorded MoMo ledger entries, branch transfers and shifts (counts only; not added to revenue)",
      confirmedStatuses: ["submitted", "reviewed"],
      definitions: {
        revenue:
          "Operating revenue = commission + other income. Debts collected is recovery of an earlier receivable, not new revenue.",
        expenses: "Approved business expenses recorded for confirmed daily accounts.",
        netOperating: "Net operating = operating revenue - expenses.",
        cashMovement:
          "Cash and E-cash movement is principal transaction volume. It is not income, revenue or profit.",
      },
    },
  };
}

export function comparePerformance(
  current: PerformanceReport,
  previous: PerformanceReport
): PerformanceDelta[] {
  const metrics: Array<PerformanceDelta["metric"]> = [
    "revenue",
    "expenses",
    "netOperating",
    "cashIn",
    "cashOut",
  ];
  return metrics.map((metric) => {
    const now = current.totals[metric];
    const before = previous.totals[metric];
    const change = money(now - before);
    return {
      metric,
      current: now,
      previous: before,
      change,
      changePercent:
        before === 0 ? (now === 0 ? 0 : null) : Math.round((change / Math.abs(before)) * 1000) / 10,
    };
  });
}
