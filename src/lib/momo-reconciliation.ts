/**
 * MoMo daily reconciliation — the approved simplified model.
 *
 * The agent holds business money in two pockets: physical cash and the
 * electronic MoMo float (E-cash). Customer deposits, withdrawals and airtime
 * sales move value between those two pockets. They never change the combined
 * business money, so the daily closing form does not ask for them.
 *
 * Expected closing accountability
 *   = opening physical cash + opening E-cash
 *   + commission + debts collected - expenses
 *
 * Equivalently:
 *   net daily profit / increase = commission + debts collected - expenses
 *   expected closing = opening total + net daily profit / increase
 *
 * Actual closing accountability
 *   = closing physical cash + closing E-cash
 *
 * Difference (accountability)
 *   negative only when actual closing is below the opening capital floor
 *   positive only when actual closing is above the full expected closing total
 *   zero when counted money is within that balanced band
 *
 * Profit that is withdrawn or not retained is never labelled as a loss. A day
 * whose closing total equals the opening total is balanced, even when the day
 * earned a net profit that the owner withdrew.
 *
 * Arithmetic runs on integer pesewas so no binary floating-point drift can
 * change a financial result. Inputs are rounded to two decimal places.
 *
 * Legacy columns (additionalCashReceived, additionalMomoFloat, totalCashIn,
 * totalCashOut, totalAirtimeSold, totalCashReceived, totalCashPaid,
 * otherIncome, calculatedMomoVariance, calculatedCashVariance) remain on
 * historical rows for readability. They are accepted by this module for
 * backward compatibility but never enter the simplified formula.
 */

export const MOMO_FIELD_LABELS = {
  openingCash: "Total Physical Cash",
  openingMomoFloat: "Total E-cash",
  closingCash: "Total Physical Cash",
  closingMomoFloat: "Total E-cash",
  totalExpenses: "Expenses",
  commission: "Commission",
  debtsCollected: "Debts Collected",
} as const;

export const MOMO_FIELD_HELP = {
  openingCash: "All physical business cash available when the day starts.",
  openingMomoFloat: "All electronic MoMo float available when the day starts.",
  closingCash: "The physical cash you actually counted at closing.",
  closingMomoFloat: "The MoMo E-cash balance you actually see at closing.",
  totalExpenses: "Food, transport, data and other legitimate business costs.",
  commission: "Enter the total commission earned today from your MoMo provider statement.",
  debtsCollected: "Money collected from people who previously owed the agent.",
} as const;

export type ReconciliationStatus = "balanced" | "positive" | "shortage";

/**
 * Marker appended to the stored status so a reader can tell a row written under
 * the net-profit model from an older row whose expected closing used a
 * different formula. The database column is a string, so no migration is
 * required and historical rows are never rewritten.
 */
const NET_MODEL_SUFFIX = "|net-v2";

export function encodeReconciliationStatus(status: ReconciliationStatus): string {
  return `${status}${NET_MODEL_SUFFIX}`;
}

export function parseReconciliationStatus(value: unknown): {
  status: ReconciliationStatus;
  netModel: boolean;
} {
  const raw = String(value ?? "").trim().toLowerCase();
  const netModel = raw.endsWith(NET_MODEL_SUFFIX);
  const base = netModel ? raw.slice(0, -NET_MODEL_SUFFIX.length) : raw;
  const status: ReconciliationStatus =
    base === "shortage" || base === "positive" ? base : "balanced";
  return { status, netModel };
}

export interface ReconciliationInput {
  openingMomoFloat: number;
  openingCash: number;
  debtsCollected?: number;
  commission?: number;
  totalExpenses?: number;
  closingMomoFloat: number;
  closingCash: number;
  /**
   * Legacy fields accepted for compatibility with historical callers.
   * They are deliberately ignored by the approved simplified formula.
   */
  additionalCashReceived?: number;
  additionalMomoFloat?: number;
  customerDeposit?: number;
  cashOut?: number;
  airtimeSold?: number;
}

export interface ReconciliationResult {
  /** Opening physical cash + opening E-cash. */
  openingTotal: number;
  /** Money collected from people who previously owed the agent. */
  debtsCollected: number;
  /** Commission entered once from the provider statement. */
  commission: number;
  /** Itemised business expenses. */
  expenses: number;
  /** Commission + debts collected - expenses. */
  netIncrease: number;
  /**
   * The minimum closing total that still preserves the business's money.
   *
   * When the day made a profit, the opening capital must remain (the profit may
   * be withdrawn). When the day made a net loss, the expected closing total is
   * below the opening total.
   */
  capitalFloor: number;
  /** Expected closing accountability if all profit remains in the business. */
  expectedClosing: number;
  /** Closing physical cash + closing E-cash. */
  actualClosing: number;
  /** Profit still held at closing. */
  profitRetained: number;
  /** Profit withdrawn or not reflected in the counted closing total. */
  profitNotRetained: number;
  /**
   * Accountability difference.
   *
   * Negative only when counted money is below the opening capital floor.
   * Positive only when counted money is above the full expected closing total.
   * Zero when actual closing is within the balanced band between those two.
   */
  difference: number;
  status: ReconciliationStatus;
}

/** Convert an arbitrary money input to integer pesewas, safely. */
export function toPesewas(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100);
}

/** Convert integer pesewas back to a two-decimal money amount. */
export function fromPesewas(value: number): number {
  return Math.round(value) / 100;
}

function pesewas(value: unknown): number {
  return toPesewas(value);
}

export function calculateReconciliation(
  data: ReconciliationInput
): ReconciliationResult {
  const openingCash = pesewas(data.openingCash);
  const openingMomoFloat = pesewas(data.openingMomoFloat);
  const debtsCollected = pesewas(data.debtsCollected ?? 0);
  const commission = pesewas(data.commission ?? 0);
  const expenses = pesewas(data.totalExpenses ?? 0);
  const closingCash = pesewas(data.closingCash);
  const closingMomoFloat = pesewas(data.closingMomoFloat);

  const openingTotal = openingCash + openingMomoFloat;
  const netIncrease = debtsCollected + commission - expenses;
  const expectedClosing = openingTotal + netIncrease;
  const capitalFloor = openingTotal + Math.min(netIncrease, 0);
  const actualClosing = closingCash + closingMomoFloat;

  // A negative difference is reported ONLY when the counted money is below the
  // opening capital floor. Money between the capital floor and the full
  // expected closing is profit that was withdrawn or not retained. It is never
  // labelled as a loss. Money above the full expected total is a surplus.
  let difference = 0;
  let status: ReconciliationStatus = "balanced";
  if (actualClosing < capitalFloor) {
    difference = actualClosing - capitalFloor;
    status = "shortage";
  } else if (actualClosing > expectedClosing) {
    difference = actualClosing - expectedClosing;
    status = "positive";
  }

  const profitRetained =
    netIncrease > 0
      ? Math.max(0, Math.min(actualClosing - openingTotal, netIncrease))
      : 0;
  const profitNotRetained =
    netIncrease > 0 ? Math.max(0, netIncrease - profitRetained) : 0;

  return {
    openingTotal: fromPesewas(openingTotal),
    debtsCollected: fromPesewas(debtsCollected),
    commission: fromPesewas(commission),
    expenses: fromPesewas(expenses),
    netIncrease: fromPesewas(netIncrease),
    capitalFloor: fromPesewas(capitalFloor),
    expectedClosing: fromPesewas(expectedClosing),
    actualClosing: fromPesewas(actualClosing),
    profitRetained: fromPesewas(profitRetained),
    profitNotRetained: fromPesewas(profitNotRetained),
    difference: fromPesewas(difference),
    status,
  };
}

export function describeVariance(value: number): string {
  const amount = pesewas(value);
  if (amount === 0) return "Balanced";
  return amount < 0 ? "Shortage" : "Positive surplus";
}

export function statusLabel(status: ReconciliationStatus): string {
  if (status === "balanced") return "Balanced";
  if (status === "positive") return "Positive surplus";
  return "Shortage — Investigation Required";
}

/**
 * Resolve the stored difference for a persisted daily account.
 *
 * New records carry calculatedDifference and differenceStatus. Historical
 * records written under an earlier formula keep their stored difference; they
 * are never recalculated with the simplified formula. The legacy split columns
 * are used only when the modern value is absent/zero and they disagree with a
 * balanced status.
 */
export function resolveStoredDifference(account: {
  calculatedDifference?: unknown;
  differenceStatus?: unknown;
  calculatedMomoVariance?: unknown;
  calculatedCashVariance?: unknown;
}): { difference: number; status: ReconciliationStatus; netModel: boolean } {
  const modern = fromPesewas(pesewas(account.calculatedDifference ?? 0));
  const declared = parseReconciliationStatus(account.differenceStatus);
  if (declared.netModel) {
    // New rows carry the status explicitly. A balanced row may legitimately
    // store zero while its profit was withdrawn, so the sign of the number is
    // never used to turn a balanced day into a shortage.
    return {
      difference: declared.status === "balanced" ? 0 : modern,
      status: declared.status,
      netModel: true,
    };
  }
  if (modern !== 0 || declared.status === "shortage" || declared.status === "positive") {
    return {
      difference: modern,
      status: modern === 0 ? "balanced" : modern > 0 ? "positive" : "shortage",
      netModel: false,
    };
  }
  const legacy = fromPesewas(
    pesewas(account.calculatedMomoVariance ?? 0) +
      pesewas(account.calculatedCashVariance ?? 0)
  );
  if (legacy !== 0) {
    return {
      difference: legacy,
      status: legacy > 0 ? "positive" : "shortage",
      netModel: false,
    };
  }
  return { difference: 0, status: "balanced", netModel: false };
}
