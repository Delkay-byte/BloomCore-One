import type { ExplainableChartId } from "./compose";
import type { PeriodPreset } from "./period";

/**
 * Deterministic intent recognition for the providerless Zeli workspace.
 *
 * A small, explicit intent set keeps the assistant honest: supported questions
 * are answered from authorized records, everything else receives a clear
 * limitation and a pointer to a report. No free-text answer is invented.
 */

export type ZeliIntent =
  | "business_summary"
  | "compare_periods"
  | "contributions_withdrawals"
  | "remittances"
  | "exceptions"
  | "branches"
  | "chart_explanation"
  | "metric_definition"
  | "why_changed"
  | "customer_lookup"
  | "daily_accounts"
  | "unsupported";

export interface ClassifiedIntent {
  intent: ZeliIntent;
  period: PeriodPreset | null;
  chartId: ExplainableChartId | null;
  matchedKeywords: string[];
}

function has(text: string, ...terms: string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

function detectPeriod(text: string): PeriodPreset | null {
  if (/\btoday\b|\bso far today\b/.test(text)) return "today";
  if (/\byesterday\b/.test(text)) return "yesterday";
  if (/\bprevious week\b|\blast week\b/.test(text)) return "previous_week";
  if (/\bthis week\b|\bweek so far\b/.test(text)) return "this_week";
  if (/\bprevious month\b|\blast month\b/.test(text)) return "previous_month";
  if (/\bthis month\b|\bmonth so far\b|\bmonth to date\b/.test(text)) return "this_month";
  if (/\bthis quarter\b|\bquarter so far\b|\bquarter to date\b/.test(text)) return "this_quarter";
  return null;
}

const CHART_KEYWORDS: Array<{ id: ExplainableChartId; terms: string[] }> = [
  { id: "contributions_vs_withdrawals", terms: ["contributions and withdrawals", "contribution chart"] },
  { id: "income_vs_expenses", terms: ["income versus expenses", "income vs expenses", "income and expenses"] },
  { id: "net_cash_flow", terms: ["net cash flow", "cash-flow trend", "cash flow chart"] },
  { id: "remittances", terms: ["remittance trend", "remittance chart"] },
  { id: "transaction_volume", terms: ["transaction volume", "transaction activity", "transaction chart"] },
  { id: "branch_performance", terms: ["branch performance", "branch chart", "branch comparison"] },
  { id: "customer_activity", terms: ["customer activity", "customer chart"] },
  { id: "exceptions", terms: ["exceptions chart", "exception chart"] },
];

export function classifyIntent(question: string): ClassifiedIntent {
  const text = question.toLowerCase().replace(/\s+/g, " ").trim();
  const period = detectPeriod(text);

  const definition = has(
    text,
    "how is",
    "how are",
    "how do you calculate",
    "how is this calculated",
    "how is the figure calculated",
    "what does this metric mean",
    "what is included in",
    "explain how"
  );
  if (
    definition.length > 0 &&
    has(text, "calculated", "calculate", "metric", "figure", "contribution", "withdrawal", "remittance", "cash flow", "active account", "exception").length > 0
  ) {
    return { intent: "metric_definition", period, chartId: null, matchedKeywords: definition };
  }

  const lookup = has(text, "find customer", "search customer", "find account", "search account", "look up customer", "lookup customer", "customer called", "account number", "account id");
  if (lookup.length > 0) {
    return { intent: "customer_lookup", period, chartId: null, matchedKeywords: lookup };
  }

  const chartTerms = has(text, "explain this chart", "explain the chart", "what does this chart", "explain chart", "this graph", "this chart");
  if (chartTerms.length > 0) {
    const chartId =
      CHART_KEYWORDS.find((entry) => entry.terms.some((term) => text.includes(term)))?.id ?? null;
    return { intent: "chart_explanation", period, chartId, matchedKeywords: chartTerms };
  }

  const changed = has(text, "why did", "why has", "why are", "what changed", "explain the change", "explain why", "reason for");
  if (changed.length > 0) {
    return { intent: "why_changed", period, chartId: null, matchedKeywords: changed };
  }

  const branches = has(text, "branch", "location", "compare branches", "which branch", "branch performance");
  if (branches.length > 0 && has(text, "compare", "performance", "which", "summary", "summarise", "summarize").length > 0) {
    return { intent: "branches", period, chartId: null, matchedKeywords: branches };
  }

  const remittance = has(text, "remittance", "remitted", "handed in", "handover", "variance");
  if (remittance.length > 0) {
    return { intent: "remittances", period, chartId: null, matchedKeywords: remittance };
  }

  const exceptions = has(text, "exception", "outstanding", "needs attention", "unusual", "discrepanc", "pending withdrawal", "awaiting review", "overdue");
  if (exceptions.length > 0) {
    return { intent: "exceptions", period, chartId: null, matchedKeywords: exceptions };
  }

  const daily = has(text, "daily account", "draft account", "submitted account", "cash variance", "momo variance");
  if (daily.length > 0) {
    return { intent: "daily_accounts", period, chartId: null, matchedKeywords: daily };
  }

  const compare = has(text, "compare", "versus", " vs ", "month on month", "week on week", "against last", "difference between");
  if (compare.length > 0) {
    return { intent: "compare_periods", period, chartId: null, matchedKeywords: compare };
  }

  const contributions = has(text, "contribution", "savings", "paid in", "collection");
  const withdrawals = has(text, "withdrawal", "paid out", "payout");
  if (contributions.length > 0 || withdrawals.length > 0) {
    return {
      intent: "contributions_withdrawals",
      period,
      chartId: null,
      matchedKeywords: [...contributions, ...withdrawals],
    };
  }

  const summary = has(text, "summarise", "summarize", "summary", "overview", "how are we doing", "today's activity", "business activity", "what happened");
  if (summary.length > 0) {
    return { intent: "business_summary", period, chartId: null, matchedKeywords: summary };
  }

  return { intent: "unsupported", period, chartId: null, matchedKeywords: [] };
}

/** Suggested prompts shown by the workspace. Kept aligned with the intents. */
export function suggestedQuestionsForRole(
  role: string,
  options: { analyticsAvailable: boolean }
): string[] {
  if (role === "admin") {
    const base = [
      "Summarise this month's business activity.",
      "Compare this month with last month.",
      "Summarise contributions and withdrawals for this month.",
      "Explain the remittance variance.",
      "Show outstanding operational exceptions.",
    ];
    if (options.analyticsAvailable) {
      base.push("Compare branch performance this month.", "Explain the contributions and withdrawals chart.");
    }
    return base;
  }
  if (role === "worker") {
    return [
      "What is the status of today's daily account?",
      "Explain the MoMo and cash variance on my latest account.",
      "Find a customer account I need to reference.",
    ];
  }
  if (role === "collector") {
    return [
      "How many customers are assigned to me?",
      "Summarise what I collected and handed in today.",
      "Find a customer by name or account id.",
    ];
  }
  return [
    "Summarise my savings account and active cycle.",
    "How much have I contributed in this cycle?",
    "How do I request a withdrawal?",
  ];
}

/**
 * Whether a non-administrator question is inside the supported set for that
 * role. This keeps the workspace honest: a worker asking for tenant-wide
 * analytics gets a limitation message, not a narrower answer dressed up as the
 * requested one.
 */
export function isSupportedForRole(role: string, question: string): boolean {
  const text = question.toLowerCase();
  if (role === "admin") return true;
  if (role === "customer") {
    return /(account|saving|susu|cycle|contribut|deposit|withdraw|balance|how do i|status)/.test(
      text
    );
  }
  if (role === "worker") {
    return /(daily account|variance|momo|cash|my account|today|status|find customer|search customer|account id)/.test(
      text
    );
  }
  if (role === "collector") {
    return /(assigned|customer|collect|handed in|handover|remittance|today|summar|find customer|account id)/.test(
      text
    );
  }
  return false;
}
