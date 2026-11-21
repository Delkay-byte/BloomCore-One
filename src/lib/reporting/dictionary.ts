/**
 * Metric dictionary for the consolidated MoMo report.
 *
 * The audit's complaint was label drift: figures were called "cash income" or "net
 * cash flow" when they were really principal volume or an operational movement.
 * Every figure shown by the consolidated report names itself here, states its
 * formula, and says whether it is operational flow, accounting result or volume.
 * Nothing is called profit.
 */

export type MetricKind = "volume" | "operational_flow" | "accounting" | "position";

export const METRIC_KIND_LABELS: Record<MetricKind, string> = {
  volume: "Money moved (not income)",
  operational_flow: "Operational flow",
  accounting: "Accounting result",
  position: "Balance at a point in time",
};

export interface MetricDefinition {
  key: string;
  label: string;
  kind: MetricKind;
  formula: string;
  excludes: string;
}

export const METRIC_DICTIONARY: MetricDefinition[] = [
  {
    key: "principal_in",
    label: "Principal in",
    kind: "volume",
    formula: "Sum of completed cash-in transactions for the period.",
    excludes: "Reversals, drafts and failed transactions.",
  },
  {
    key: "principal_out",
    label: "Principal out",
    kind: "volume",
    formula: "Sum of completed cash-out transactions for the period.",
    excludes: "Reversals, drafts and failed transactions.",
  },
  {
    key: "commission",
    label: "Commission earned",
    kind: "accounting",
    formula:
      "Day-total commission rows plus per-transaction commission, with the day total taking precedence so the same money is never counted twice.",
    excludes: "Principal, float and any customer money.",
  },
  {
    key: "other_income",
    label: "Other income",
    kind: "accounting",
    formula: "Sum of recorded other income for the period.",
    excludes: "Commission, debts collected and principal.",
  },
  {
    key: "debts_collected",
    label: "Debts collected",
    kind: "accounting",
    formula: "Sum of recorded debt collections for the period.",
    excludes: "New lending, which this product does not record.",
  },
  {
    key: "expenses",
    label: "Expenses",
    kind: "accounting",
    formula: "Sum of recorded expenses for the period.",
    excludes: "Transfers between branches and float top-ups.",
  },
  {
    key: "net_operating",
    label: "Net operating result",
    kind: "accounting",
    formula: "Commission + other income + debts collected − expenses.",
    excludes:
      "Principal movement, float movement and owner drawings. This is not profit and not a distributable amount.",
  },
  {
    key: "declared_cash",
    label: "Declared cash",
    kind: "position",
    formula: "The most recent branch cash declaration on or before the period end.",
    excludes: "Counting money that a daily close reported but nobody declared.",
  },
  {
    key: "declared_float",
    label: "Declared float",
    kind: "position",
    formula: "The most recent declared float per network, summed.",
    excludes: "Provider balances that were never declared in this product.",
  },
  {
    key: "transfers_in",
    label: "Transfers in",
    kind: "operational_flow",
    formula: "Completed branch transfers into the branch during the period.",
    excludes: "Requested, rejected, cancelled and in-dispute transfers.",
  },
  {
    key: "transfers_out",
    label: "Transfers out",
    kind: "operational_flow",
    formula: "Completed branch transfers out of the branch during the period.",
    excludes: "Requested, rejected, cancelled and in-dispute transfers.",
  },
  {
    key: "close_cash_variance",
    label: "Daily close cash variance",
    kind: "operational_flow",
    formula: "Sum of each submitted daily account's calculated cash variance.",
    excludes: "Handover differences, which are a separate physical check.",
  },
  {
    key: "close_float_variance",
    label: "Daily close float variance",
    kind: "operational_flow",
    formula: "Sum of each submitted daily account's calculated float variance.",
    excludes: "Cash variance.",
  },
  {
    key: "expected_days",
    label: "Expected branch days",
    kind: "operational_flow",
    formula: "Number of days in the period × number of active branches.",
    excludes: "Days a branch was closed by an administrator.",
  },
  {
    key: "submitted_days",
    label: "Days with a submitted close",
    kind: "operational_flow",
    formula: "Distinct branch and business-date pairs with a submitted or reviewed close.",
    excludes: "Draft closes, which are not a record yet.",
  },
  {
    key: "late_days",
    label: "Late closes",
    kind: "operational_flow",
    formula: "Closes submitted more than one day after the business date.",
    excludes: "Corrections recorded after review, which are counted separately.",
  },
];

export const METRIC_BY_KEY = new Map(METRIC_DICTIONARY.map((row) => [row.key, row]));

export const CONSOLIDATED_REPORT_NOTE =
  "Every figure here comes from records in this business. Volume is not income, and net operating result is not profit: it excludes principal, float and owner movements.";

/** Labels the consolidated report must never use, because they imply profit. */
export const FORBIDDEN_LABELS = ["profit", "net profit", "cash income", "net cash flow", "revenue"];
