/**
 * MoMo daily reconciliation — the corrected combined-accountability model.
 *
 * A MoMo agent holds business money in two pockets: physical cash and the
 * electronic MoMo float. Customer deposits, cash out and airtime sales move
 * value between those pockets. They never change the combined business money.
 *
 * Expected closing accountability
 *   = opening cash
 *   + opening MoMo float
 *   + additional cash received
 *   + additional MoMo float received
 *   + commission earned
 *   - total business expenses
 *
 * Actual closing accountability
 *   = closing cash
 *   + closing MoMo float
 *
 * Difference = actual - expected.
 *   zero      -> Balanced
 *   positive  -> Positive difference (green)
 *   negative  -> Shortage (red, explanation required before submission)
 *
 * The old model added customer deposits to the float and subtracted cash out
 * from cash independently. That model is gone. The persisted legacy columns
 * (totalCashReceived, totalCashPaid, otherIncome, calculatedMomoVariance,
 * calculatedCashVariance) remain only so historical records stay readable.
 */

export const MOMO_FIELD_LABELS = {
  customerDeposit: "Customer deposit (Cash in)",
  cashOut: "Cash out",
  airtimeSold: "Airtime sold",
  additionalCashReceived: "Additional cash received",
  additionalMomoFloatReceived: "Additional MoMo float received",
  commission: "Commission earned",
  totalExpenses: "Business expenses",
  openingCash: "Opening physical cash",
  openingMomoFloat: "Opening MoMo float",
  closingCash: "Actual closing physical cash",
  closingMomoFloat: "Actual closing MoMo float",
} as const;

export const MOMO_FIELD_HELP = {
  customerDeposit:
    "Total cash customers deposited with you today. Cash in goes up, MoMo float goes down. Combined business money does not change.",
  cashOut:
    "Total cash you paid to customers who withdrew today. Cash goes down, MoMo float goes up. Combined business money does not change.",
  airtimeSold:
    "Total value of airtime you sold to customers today. Cash goes up, MoMo float goes down. Combined business money does not change.",
  additionalCashReceived:
    "Extra physical cash the boss or owner brought for the business today. This increases total business money.",
  additionalMomoFloatReceived:
    "Extra MoMo float the boss or owner sent for the business today. This increases total business money.",
  commission:
    "Enter the commission total shown on your MoMo provider statement. It is added once.",
  totalExpenses:
    "Authorised business expenses paid from cash or float. The total reduces closing accountability.",
} as const;

export type ReconciliationStatus = "balanced" | "positive" | "shortage";

export interface ReconciliationInput {
  openingMomoFloat: number;
  openingCash: number;
  additionalCashReceived?: number;
  additionalMomoFloat?: number;
  customerDeposit?: number;
  cashOut?: number;
  airtimeSold?: number;
  commission?: number;
  totalExpenses?: number;
  closingMomoFloat: number;
  closingCash: number;
}

export interface ReconciliationResult {
  /** Opening cash + opening float. */
  openingTotal: number;
  /** Additional cash + additional float. */
  additionalFunding: number;
  /** Expected closing accountability under the combined model. */
  expectedClosing: number;
  /** Entered closing cash + closing float. */
  actualClosing: number;
  /** actualClosing - expectedClosing. */
  difference: number;
  status: ReconciliationStatus;
  /** Float movement guide: opening float + cash out - deposits - airtime. */
  expectedMomoFloat: number;
  /** Cash movement guide: opening cash + deposits - cash out + airtime. */
  expectedCash: number;
}

function money(value: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

export function calculateReconciliation(
  data: ReconciliationInput
): ReconciliationResult {
  const openingMomoFloat = money(data.openingMomoFloat);
  const openingCash = money(data.openingCash);
  const additionalCashReceived = money(data.additionalCashReceived ?? 0);
  const additionalMomoFloat = money(data.additionalMomoFloat ?? 0);
  const customerDeposit = money(data.customerDeposit ?? 0);
  const cashOut = money(data.cashOut ?? 0);
  const airtimeSold = money(data.airtimeSold ?? 0);
  const commission = money(data.commission ?? 0);
  const totalExpenses = money(data.totalExpenses ?? 0);
  const closingMomoFloat = money(data.closingMomoFloat);
  const closingCash = money(data.closingCash);

  const openingTotal = money(openingCash + openingMomoFloat);
  const additionalFunding = money(additionalCashReceived + additionalMomoFloat);
  const expectedClosing = money(
    openingTotal + additionalFunding + commission - totalExpenses
  );
  const actualClosing = money(closingCash + closingMomoFloat);
  const difference = money(actualClosing - expectedClosing);

  return {
    openingTotal,
    additionalFunding,
    expectedClosing,
    actualClosing,
    difference,
    status:
      difference === 0 ? "balanced" : difference > 0 ? "positive" : "shortage",
    // Informational guides. They explain the movement between the two pockets;
    // they do not drive the reconciliation status.
    expectedMomoFloat: money(
      openingMomoFloat + cashOut - customerDeposit - airtimeSold
    ),
    expectedCash: money(
      openingCash + customerDeposit - cashOut + airtimeSold
    ),
  };
}

export function describeVariance(value: number): string {
  const amount = money(value);
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
 * New records carry calculatedDifference and differenceStatus. Records written
 * before the correction have only the legacy split columns, and the additive
 * migration gives them calculatedDifference = 0 / differenceStatus = "balanced".
 * For those rows the legacy sum is the truthful difference, so it is used only
 * when the new value is zero and the legacy columns disagree with "balanced".
 */
export function resolveStoredDifference(account: {
  calculatedDifference?: unknown;
  differenceStatus?: unknown;
  calculatedMomoVariance?: unknown;
  calculatedCashVariance?: unknown;
}): { difference: number; status: ReconciliationStatus } {
  const modern = money(Number(account.calculatedDifference ?? 0));
  const declared = String(account.differenceStatus ?? "").toLowerCase();
  if (modern !== 0 || declared === "shortage" || declared === "positive") {
    return {
      difference: modern,
      status: modern === 0 ? "balanced" : modern > 0 ? "positive" : "shortage",
    };
  }
  const legacy = money(
    Number(account.calculatedMomoVariance ?? 0) +
      Number(account.calculatedCashVariance ?? 0)
  );
  if (legacy !== 0) {
    return {
      difference: legacy,
      status: legacy > 0 ? "positive" : "shortage",
    };
  }
  return { difference: 0, status: "balanced" };
}
