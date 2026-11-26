/**
 * Consolidated cash, float and liquidity position.
 *
 * The pieces already existed separately: daily closes know their own variances,
 * branch declarations know the physical position, and transfers record money moving
 * between branches. These functions put them side by side without pretending they
 * are the same measure — a declaration is a point-in-time position, a transfer is a
 * movement, and a close variance is a difference the branch already recorded.
 *
 * Pure functions: all inputs are plain values so the arithmetic is testable without
 * a database.
 */

export type AssetType = "cash" | "mtn_float" | "telecel_float" | "at_money_float";

export const ASSET_TYPES: AssetType[] = ["cash", "mtn_float", "telecel_float", "at_money_float"];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  cash: "Cash",
  mtn_float: "MTN float",
  telecel_float: "Telecel float",
  at_money_float: "AT Money float",
};

export function isFloatAsset(assetType: string): boolean {
  return assetType !== "cash";
}

export interface Declaration {
  locationId: string;
  assetType: string;
  declaredBalance: number;
  declaredAt: Date;
}

export interface CloseRow {
  locationId: string;
  businessDate: Date;
  status: string;
  closingCash: number;
  closingMomoFloat: number;
  calculatedCashVariance: number;
  calculatedMomoVariance: number;
  calculatedDifference: number;
}

export interface TransferRow {
  sourceLocationId: string;
  destinationLocationId: string;
  assetType: string;
  amount: number;
  status: string;
  /** When the money left the source; falls back to the request time. */
  movedAt: Date;
}

/** Only these transfer states mean the money actually moved. */
const TRANSFER_SETTLED = new Set(["received", "completed"]);

export function transferSettled(status: string): boolean {
  return TRANSFER_SETTLED.has(status);
}

export function roundPesewas(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface BranchPosition {
  locationId: string;
  declaredCash: number;
  declaredFloat: number;
  declaredFloatByNetwork: Record<string, number>;
  declarationAgeDays: number | null;
  transfersIn: number;
  transfersOut: number;
  closingCashReported: number;
  closingFloatReported: number;
  cashVariance: number;
  floatVariance: number;
  /** Declared cash differs from the last reported closing cash. */
  cashMismatch: number | null;
}

export interface CashPositionReport {
  branches: BranchPosition[];
  totals: {
    declaredCash: number;
    declaredFloat: number;
    transfersIn: number;
    transfersOut: number;
    closingCashReported: number;
    closingFloatReported: number;
    cashVariance: number;
    floatVariance: number;
  };
  /** Branches whose latest declaration is older than the warning window. */
  staleDeclarations: Array<{ locationId: string; ageDays: number }>;
  notes: string[];
}

/** A declaration older than this is not a position, it is history. */
export const DECLARATION_STALE_DAYS = 7;

export function computeCashPosition(input: {
  from: string;
  to: string;
  asOf: Date;
  locations: string[];
  declarations: Declaration[];
  closes: CloseRow[];
  transfers: TransferRow[];
}): CashPositionReport {
  const inPeriod = (date: Date) => {
    const key = date.toISOString().slice(0, 10);
    return key >= input.from && key <= input.to;
  };

  const branches: BranchPosition[] = input.locations.map((locationId) => {
    const latest: Record<string, Declaration> = {};
    for (const declaration of input.declarations) {
      if (declaration.locationId !== locationId) continue;
      const current = latest[declaration.assetType];
      if (!current || declaration.declaredAt.getTime() > current.declaredAt.getTime()) {
        latest[declaration.assetType] = declaration;
      }
    }

    const declaredFloatByNetwork: Record<string, number> = {};
    let declaredFloat = 0;
    for (const assetType of ASSET_TYPES) {
      if (!isFloatAsset(assetType)) continue;
      const value = latest[assetType]?.declaredBalance ?? 0;
      if (value !== 0) declaredFloatByNetwork[assetType] = roundPesewas(value);
      declaredFloat += value;
    }
    const declaredCash = latest.cash?.declaredBalance ?? 0;
    const declarationDates = Object.values(latest).map((row) => row.declaredAt.getTime());
    const declarationAgeDays =
      declarationDates.length === 0
        ? null
        : Math.max(
            0,
            Math.floor(
              (input.asOf.getTime() - Math.max(...declarationDates)) / 86_400_000
            )
          );

    const closeRows = input.closes
      .filter((row) => row.locationId === locationId && inPeriod(row.businessDate))
      .sort((a, b) => b.businessDate.getTime() - a.businessDate.getTime());
    const transfers = input.transfers.filter(
      (row) => transferSettled(row.status) && inPeriod(row.movedAt)
    );

    const transfersIn = transfers
      .filter((row) => row.destinationLocationId === locationId)
      .reduce((sum, row) => sum + row.amount, 0);
    const transfersOut = transfers
      .filter((row) => row.sourceLocationId === locationId)
      .reduce((sum, row) => sum + row.amount, 0);

    const closingCashReported = closeRows[0]?.closingCash ?? 0;
    const closingFloatReported = closeRows[0]?.closingMomoFloat ?? 0;

    return {
      locationId,
      declaredCash: roundPesewas(declaredCash),
      declaredFloat: roundPesewas(declaredFloat),
      declaredFloatByNetwork,
      declarationAgeDays,
      transfersIn: roundPesewas(transfersIn),
      transfersOut: roundPesewas(transfersOut),
      closingCashReported: roundPesewas(closingCashReported),
      closingFloatReported: roundPesewas(closingFloatReported),
      cashVariance: roundPesewas(closeRows.reduce((sum, row) => sum + row.calculatedCashVariance, 0)),
      floatVariance: roundPesewas(closeRows.reduce((sum, row) => sum + row.calculatedMomoVariance, 0)),
      cashMismatch:
        latest.cash && closeRows.length > 0
          ? roundPesewas(declaredCash - closingCashReported)
          : null,
    };
  });

  const totals = branches.reduce(
    (acc, branch) => ({
      declaredCash: acc.declaredCash + branch.declaredCash,
      declaredFloat: acc.declaredFloat + branch.declaredFloat,
      transfersIn: acc.transfersIn + branch.transfersIn,
      transfersOut: acc.transfersOut + branch.transfersOut,
      closingCashReported: acc.closingCashReported + branch.closingCashReported,
      closingFloatReported: acc.closingFloatReported + branch.closingFloatReported,
      cashVariance: acc.cashVariance + branch.cashVariance,
      floatVariance: acc.floatVariance + branch.floatVariance,
    }),
    {
      declaredCash: 0,
      declaredFloat: 0,
      transfersIn: 0,
      transfersOut: 0,
      closingCashReported: 0,
      closingFloatReported: 0,
      cashVariance: 0,
      floatVariance: 0,
    }
  );

  const round = (values: typeof totals): typeof totals =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, roundPesewas(value)])
    ) as typeof totals;

  const staleDeclarations = branches
    .filter(
      (branch) =>
        branch.declarationAgeDays !== null && branch.declarationAgeDays > DECLARATION_STALE_DAYS
    )
    .map((branch) => ({ locationId: branch.locationId, ageDays: branch.declarationAgeDays! }));

  const notes: string[] = [
    "A declaration is a point-in-time position; a transfer is a movement. They are shown side by side, not added together.",
    "Only transfers in a settled state (received or completed) count as money that moved.",
  ];
  if (staleDeclarations.length > 0) {
    notes.push(
      `${staleDeclarations.length} branch declaration${staleDeclarations.length === 1 ? " is" : "s are"} older than ${DECLARATION_STALE_DAYS} days and should be refreshed before it is relied on.`
    );
  }

  return { branches, totals: round(totals), staleDeclarations, notes };
}

export interface ConsolidatedFlow {
  principalIn: number;
  principalOut: number;
  commission: number;
  otherIncome: number;
  debtsCollected: number;
  expenses: number;
  netOperating: number;
}

/**
 * The income statement of an operator, honestly labelled.
 *
 * Principal is volume, not income. Net operating result excludes principal, float
 * and owner movements, and is deliberately not called profit.
 */
export function computeConsolidatedFlow(input: {
  transactions: Array<{ type: string; direction: string; amount: number; status: string; isReversal: boolean }>;
  closes: Array<{
    commission: number;
    otherIncome: number;
    debtsCollected: number;
    totalExpenses: number;
    status: string;
  }>;
}): ConsolidatedFlow {
  const usable = (row: { status: string; isReversal: boolean }) =>
    !row.isReversal && !["voided", "failed", "draft"].includes(row.status);

  let principalIn = 0;
  let principalOut = 0;
  for (const row of input.transactions) {
    if (!usable(row)) continue;
    if (row.type !== "cash_in" && row.type !== "cash_out") continue;
    if (row.type === "cash_in") principalIn += row.amount;
    else principalOut += row.amount;
  }

  const closes = input.closes.filter((row) =>
    ["submitted", "reviewed", "corrected", "approved"].includes(row.status)
  );
  const commission = closes.reduce((sum, row) => sum + row.commission, 0);
  const otherIncome = closes.reduce((sum, row) => sum + row.otherIncome, 0);
  const debtsCollected = closes.reduce((sum, row) => sum + row.debtsCollected, 0);
  const expenses = closes.reduce((sum, row) => sum + row.totalExpenses, 0);

  return {
    principalIn: roundPesewas(principalIn),
    principalOut: roundPesewas(principalOut),
    commission: roundPesewas(commission),
    otherIncome: roundPesewas(otherIncome),
    debtsCollected: roundPesewas(debtsCollected),
    expenses: roundPesewas(expenses),
    netOperating: roundPesewas(commission + otherIncome + debtsCollected - expenses),
  };
}
