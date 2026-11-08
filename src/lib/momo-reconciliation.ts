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
 *   + debts collected + commission - expenses
 *
 * Actual closing accountability
 *   = closing physical cash + closing E-cash
 *
 * Difference = actual - expected.
 *   zero      -> Balanced (green)
 *   positive  -> Positive difference (green)
 *   negative  -> Shortage (red, explanation required before submission)
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
  /** Expected closing accountability under the simplified model. */
  expectedClosing: number;
  /** Closing physical cash + closing E-cash. */
  actualClosing: number;
  /** actualClosing - expectedClosing. */
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
  const expectedClosing =
    openingTotal + debtsCollected + commission - expenses;
  const actualClosing = closingCash + closingMomoFloat;
  const difference = actualClosing - expectedClosing;

  return {
    openingTotal: fromPesewas(openingTotal),
    debtsCollected: fromPesewas(debtsCollected),
    commission: fromPesewas(commission),
    expenses: fromPesewas(expenses),
    expectedClosing: fromPesewas(expectedClosing),
    actualClosing: fromPesewas(actualClosing),
    difference: fromPesewas(difference),
    status:
      difference === 0 ? "balanced" : difference > 0 ? "positive" : "shortage",
  };
}

export function describeVariance(value: number): string {
  const amount = pesewas(value);
  if (amount === 0) return "Balanced";
  return amount < 0 ? "Shortage" : "Positive difference";
}

export function statusLabel(status: ReconciliationStatus): string {
  if (status === "balanced") return "Balanced";
  if (status === "positive") return "Positive difference";
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
}): { difference: number; status: ReconciliationStatus } {
  const modern = fromPesewas(pesewas(account.calculatedDifference ?? 0));
  const declared = String(account.differenceStatus ?? "").toLowerCase();
  if (modern !== 0 || declared === "shortage" || declared === "positive") {
    return {
      difference: modern,
      status: modern === 0 ? "balanced" : modern > 0 ? "positive" : "shortage",
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
    };
  }
  return { difference: 0, status: "balanced" };
}
