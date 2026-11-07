/**
 * MoMo daily reconciliation — approved field names and the arithmetic shared
 * by the worker form, the correction screen, the admin report detail and the
 * server actions.
 *
 * Approved labels (business owner + experienced MoMo operator):
 *   Customer deposit — money added to the MoMo float through customer deposits
 *   Cash out         — cash paid to customers (customer withdrawals)
 *   Cash in          — physical cash received during the day
 *
 * "Cash paid out" is deliberately absent: it duplicated Cash out. The database
 * column (DailyAccount.totalCashPaid) is retained only so historical submitted
 * accounts and their stored variances remain readable. New and corrected
 * accounts store 0 there and the field never contributes to a calculation.
 */

export const MOMO_FIELD_LABELS = {
  customerDeposit: "Customer deposit",
  cashOut: "Cash out",
  cashIn: "Cash in",
} as const;

export const MOMO_FIELD_HELP = {
  customerDeposit:
    "Money you added to MoMo for customers who came to deposit cash with you.",
  cashOut: "Cash you paid to customers who came to withdraw money.",
  cashIn: "Physical cash you received during the day.",
} as const;

export interface ReconciliationInput {
  openingMomoFloat: number;
  openingCash: number;
  customerDeposit: number;
  cashOut: number;
  cashIn: number;
  commission: number;
  otherIncome: number;
  totalExpenses: number;
  closingMomoFloat: number;
  closingCash: number;
}

export interface ReconciliationResult {
  expectedMomoFloat: number;
  expectedCash: number;
  momoVariance: number;
  cashVariance: number;
  totalVariance: number;
}

function money(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Expected MoMo float: opening float + customer deposits - cash out.
 * Expected cash:       opening cash + cash in + commission + other income
 *                      - cash out - business expenses.
 *
 * Cash out is counted exactly once on each side of the books: it reduced the
 * float and it left the cash drawer. It is never subtracted twice from cash.
 */
export function calculateReconciliation(
  data: ReconciliationInput
): ReconciliationResult {
  const openingMomoFloat = Number(data.openingMomoFloat) || 0;
  const openingCash = Number(data.openingCash) || 0;
  const customerDeposit = Number(data.customerDeposit) || 0;
  const cashOut = Number(data.cashOut) || 0;
  const cashIn = Number(data.cashIn) || 0;
  const commission = Number(data.commission) || 0;
  const otherIncome = Number(data.otherIncome) || 0;
  const totalExpenses = Number(data.totalExpenses) || 0;
  const closingMomoFloat = Number(data.closingMomoFloat) || 0;
  const closingCash = Number(data.closingCash) || 0;

  const expectedMomoFloat = money(
    openingMomoFloat + customerDeposit - cashOut
  );
  const expectedCash = money(
    openingCash + cashIn + commission + otherIncome - cashOut - totalExpenses
  );

  const momoVariance = money(closingMomoFloat - expectedMomoFloat);
  const cashVariance = money(closingCash - expectedCash);

  return {
    expectedMomoFloat,
    expectedCash,
    momoVariance,
    cashVariance,
    totalVariance: money(momoVariance + cashVariance),
  };
}

/** Human wording for a signed reconciliation difference (short/over/balanced). */
export function describeVariance(value: number): string {
  const amount = money(value);
  if (amount === 0) return "Balanced";
  return amount < 0 ? "Short" : "Over";
}
