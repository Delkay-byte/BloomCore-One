import type { AnalyticsSnapshot } from "./metrics";

/**
 * Deterministic business insight engine.
 *
 * These are rule-based observations, not model reasoning and not predictions.
 * Each insight carries its period, metric, calculation, source, freshness and
 * limitations so the reader can audit it. Correlation is never presented as
 * causation.
 */

export type InsightSeverity = "info" | "attention" | "warning";

export type InsightCategory =
  | "trend"
  | "anomaly"
  | "exception"
  | "branch"
  | "customer"
  | "data_quality";

export interface InsightEvidence {
  label: string;
  value: string;
}

export interface Insight {
  id: string;
  title: string;
  detail: string;
  severity: InsightSeverity;
  category: InsightCategory;
  period: string;
  metric: string;
  calculation: string;
  source: string;
  freshness: string;
  confidence: "high" | "medium" | "low";
  limitations: string[];
  evidence: InsightEvidence[];
  recommendedAction: string | null;
  /** Distinguishes deterministic observations from generated reasoning. */
  type: "detected_pattern";
}

const MIN_BASELINE_MONEY = 100;
const MIN_BASELINE_COUNT = 5;
const CHANGE_THRESHOLD = 10;

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function money(value: number): string {
  return `GH₵${value.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function changeInsight(params: {
  id: string;
  metricLabel: string;
  current: number;
  previous: number;
  unit: "money" | "count";
  period: string;
  source: string;
  freshness: string;
  increaseAction: string;
  decreaseAction: string;
}): Insight | null {
  const change = pctChange(params.current, params.previous);
  const baseline =
    params.unit === "money"
      ? Math.abs(params.previous) >= MIN_BASELINE_MONEY
      : Math.abs(params.previous) >= MIN_BASELINE_COUNT;
  if (change == null || Math.abs(change) < CHANGE_THRESHOLD || !baseline) return null;
  const direction = change > 0 ? "increased" : "decreased";
  const severity: InsightSeverity = Math.abs(change) >= 30 ? "warning" : "attention";
  const formatted = params.unit === "money" ? money : (value: number) => String(value);
  return {
    id: params.id,
    title: `${params.metricLabel} ${direction} by ${Math.abs(change).toFixed(1)}%`,
    detail: `${params.metricLabel} was ${formatted(params.current)} in ${params.period}, compared with ${formatted(params.previous)} in the preceding period.`,
    severity,
    category: "trend",
    period: params.period,
    metric: params.metricLabel,
    calculation: `(${params.current} − ${params.previous}) ÷ |${params.previous}| × 100`,
    source: params.source,
    freshness: params.freshness,
    confidence: Math.abs(change) >= 25 ? "high" : "medium",
    limitations: [
      "A change is a comparison, not a cause. Check operational context before acting.",
      "The preceding period has the same number of days; custom periods compare with the immediately preceding equal-length window.",
    ],
    evidence: [
      { label: "Selected period", value: formatted(params.current) },
      { label: "Previous period", value: formatted(params.previous) },
      { label: "Change", value: `${change > 0 ? "+" : ""}${change.toFixed(1)}%` },
    ],
    recommendedAction: change > 0 ? params.increaseAction : params.decreaseAction,
    type: "detected_pattern",
  };
}

function branchOutliers(snapshot: AnalyticsSnapshot): Insight[] {
  const branches = snapshot.branchPerformance.filter(
    (branch) => branch.contributions > 0 || branch.transactionCount > 0
  );
  if (branches.length < 3) return [];
  const values = branches.map((branch) => branch.contributions);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return [];
  const outliers = branches
    .map((branch) => ({
      branch,
      z: (branch.contributions - mean) / sd,
    }))
    .filter((row) => Math.abs(row.z) >= 2 && Math.abs(row.branch.contributions - mean) >= 50)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 2);
  return outliers.map(({ branch, z }) => ({
    id: `branch-outlier-${branch.locationId}`,
    title: `${branch.locationName} is ${z > 0 ? "above" : "below"} the branch average`,
    detail: `${branch.locationName} recorded ${money(branch.contributions)} in contributions across ${branch.transactionCount} transactions, against a branch average of ${money(mean)}.`,
    severity: (Math.abs(z) >= 2.5 ? "warning" : "attention") as InsightSeverity,
    category: "branch" as const,
    period: snapshot.period.label,
    metric: "Contributions by branch",
    calculation: `z = (branch value − mean) ÷ sample standard deviation (n=${branches.length})`,
    source: snapshot.freshness.source,
    freshness: snapshot.freshness.refreshedAt,
    confidence: "medium" as const,
    limitations: [
      "Branch size, staffing and opening hours differ. This is an operational comparison, not evidence of fault.",
      "Small branches can produce large z-scores from a few transactions.",
    ],
    evidence: [
      { label: "Branch", value: branch.locationName },
      { label: "Branch contributions", value: money(branch.contributions) },
      { label: "Branch average", value: money(mean) },
      { label: "z-score", value: z.toFixed(2) },
    ],
    recommendedAction: "Compare the branch's staffing, opening days and remittance timing before drawing a conclusion.",
    type: "detected_pattern" as const,
  }));
}

function engagementTrend(snapshot: AnalyticsSnapshot): Insight | null {
  const points = snapshot.series.filter((point) => point.activeAccounts > 0);
  if (points.length < 6) return null;
  const midpoint = Math.floor(points.length / 2);
  const first = points.slice(0, midpoint);
  const second = points.slice(midpoint);
  const average = (rows: typeof points) =>
    rows.reduce((sum, row) => sum + row.activeAccounts, 0) / rows.length;
  const before = average(first);
  const after = average(second);
  const change = pctChange(after, before);
  if (change == null || Math.abs(change) < 20 || before < 5) return null;
  return {
    id: "customer-engagement-trend",
    title: `Daily active accounts ${change < 0 ? "declined" : "increased"} across the period`,
    detail: `Average distinct accounts contributing per active day moved from ${before.toFixed(1)} in the first half to ${after.toFixed(1)} in the second half of ${snapshot.period.label}.`,
    severity: change < -20 ? "attention" : "info",
    category: "customer",
    period: snapshot.period.label,
    metric: "Active accounts",
    calculation: "Average distinct contributing accounts per active day, second half vs first half",
    source: snapshot.freshness.source,
    freshness: snapshot.freshness.refreshedAt,
    confidence: "medium",
    limitations: [
      "A day with no contributions is excluded from the daily average.",
      "This measures contribution activity, not customer satisfaction or churn.",
    ],
    evidence: [
      { label: "First-half average", value: before.toFixed(1) },
      { label: "Second-half average", value: after.toFixed(1) },
      { label: "Change", value: `${change > 0 ? "+" : ""}${change.toFixed(1)}%` },
    ],
    recommendedAction:
      change < 0
        ? "Review collector routes and recent account closures before assuming a cause."
        : "Check whether a campaign or new collector explains the increase.",
    type: "detected_pattern",
  };
}

/** Run every detector and return a stable, severity-ordered list. */
export function detectInsights(snapshot: AnalyticsSnapshot): Insight[] {
  const insights: Insight[] = [];
  const period = snapshot.period.label;
  const source = snapshot.freshness.source;
  const freshness = snapshot.freshness.refreshedAt;

  const detectors: Array<Insight | null> = [
    changeInsight({
      id: "contributions-change",
      metricLabel: "Contributions",
      current: snapshot.totals.contributions,
      previous: snapshot.previousTotals.contributions,
      unit: "money",
      period,
      source,
      freshness,
      increaseAction: "Confirm the increase is supported by recorded contributions, not a duplicate entry.",
      decreaseAction: "Check collector coverage and whether any collection days were missed.",
    }),
    changeInsight({
      id: "withdrawals-change",
      metricLabel: "Withdrawals",
      current: snapshot.totals.withdrawals,
      previous: snapshot.previousTotals.withdrawals,
      unit: "money",
      period,
      source,
      freshness,
      increaseAction: "Review large withdrawals and confirm authorization and available balances.",
      decreaseAction: "Check whether withdrawal requests are waiting for authorization.",
    }),
    changeInsight({
      id: "expenses-change",
      metricLabel: "Expenses",
      current: snapshot.totals.expenses,
      previous: snapshot.previousTotals.expenses,
      unit: "money",
      period,
      source,
      freshness,
      increaseAction: "Review the largest expense lines and confirm supporting records.",
      decreaseAction: "Confirm that recurring expenses were not omitted from daily accounts.",
    }),
    changeInsight({
      id: "net-cash-flow-change",
      metricLabel: "Net cash flow",
      current: snapshot.totals.netCashFlow,
      previous: snapshot.previousTotals.netCashFlow,
      unit: "money",
      period,
      source,
      freshness,
      increaseAction: "Check that the improvement is backed by settled cash, not just recorded contributions.",
      decreaseAction: "Compare withdrawals and expenses with the preceding period to locate the movement.",
    }),
    changeInsight({
      id: "transaction-volume-change",
      metricLabel: "Transaction volume",
      current: snapshot.totals.transactionCount,
      previous: snapshot.previousTotals.transactionCount,
      unit: "count",
      period,
      source,
      freshness,
      increaseAction: "Confirm the higher volume is genuine and that no records were duplicated.",
      decreaseAction: "Check for missed collection days or unavailable staff.",
    }),
  ];
  for (const insight of detectors) if (insight) insights.push(insight);

  if (Math.abs(snapshot.totals.remittanceVariance) >= 0.01) {
    insights.push({
      id: "remittance-variance",
      title: "Remittance variance needs review",
      detail: `Collector remittances in ${period} show a net variance of ${money(snapshot.totals.remittanceVariance)} across ${snapshot.totals.remittanceCount} remittance records.`,
      severity: Math.abs(snapshot.totals.remittanceVariance) >= 50 ? "warning" : "attention",
      category: "exception",
      period,
      metric: "Remittance variance",
      calculation: "Sum of active CollectorRemittance.variance for the period",
      source: snapshot.reconciliation.remittanceSource,
      freshness,
      confidence: "high",
      limitations: [
        "Variance can be legitimate when a later remittance covers earlier collections. Compare collector statements before escalating.",
      ],
      evidence: [
        { label: "Net variance", value: money(snapshot.totals.remittanceVariance) },
        { label: "Remittances", value: String(snapshot.totals.remittanceCount) },
        { label: "Reversed remittances", value: "Excluded" },
      ],
      recommendedAction: "Open Money Handed In and review the affected collector's latest remittance.",
      type: "detected_pattern",
    });
  }

  if (snapshot.exceptions.collectorsWithoutRemittance > 0) {
    insights.push({
      id: "collectors-without-remittance",
      title: "Some collectors have no remittance in this period",
      detail: `${snapshot.exceptions.collectorsWithoutRemittance} collector(s) recorded contributions in ${period} without a matching remittance record in the same period.`,
      severity: "warning",
      category: "exception",
      period,
      metric: "Remittance completion",
      calculation: "Distinct collectors with non-reversed contributions minus distinct collectors with a non-reversed remittance",
      source: snapshot.reconciliation.remittanceSource,
      freshness,
      confidence: "high",
      limitations: [
        "A remittance may be recorded under a different period or after the period closes.",
      ],
      evidence: [
        { label: "Collectors without remittance", value: String(snapshot.exceptions.collectorsWithoutRemittance) },
      ],
      recommendedAction: "Check the collector's handover schedule and record the remittance once cash is verified.",
      type: "detected_pattern",
    });
  }

  if (snapshot.exceptions.dailyAccountsAwaitingReview > 0) {
    insights.push({
      id: "daily-accounts-awaiting-review",
      title: "Daily accounts are waiting for review",
      detail: `${snapshot.exceptions.dailyAccountsAwaitingReview} submitted daily account(s) have not been reviewed.`,
      severity: snapshot.exceptions.dailyAccountsAwaitingReview >= 5 ? "warning" : "attention",
      category: "exception",
      period: `Current state at ${new Date(snapshot.freshness.refreshedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
      metric: "Daily account review status",
      calculation: "Count of DailyAccount rows with status = submitted in the selected scope",
      source: "DailyAccount status",
      freshness,
      confidence: "high",
      limitations: ["This is a current-state count, not a period flow."],
      evidence: [
        { label: "Awaiting review", value: String(snapshot.exceptions.dailyAccountsAwaitingReview) },
      ],
      recommendedAction: "Open Money & History, review the submitted accounts, then correct any record that is wrong.",
      type: "detected_pattern",
    });
  }

  if (snapshot.exceptions.pendingWithdrawals > 0) {
    insights.push({
      id: "pending-withdrawals",
      title: "Withdrawal requests are pending",
      detail: `${snapshot.exceptions.pendingWithdrawals} withdrawal request(s) are still pending in the selected scope.`,
      severity: "attention",
      category: "exception",
      period: "Current state",
      metric: "Pending withdrawals",
      calculation: "Count of Withdrawal rows with status = pending",
      source: "Withdrawal status",
      freshness,
      confidence: "high",
      limitations: ["A pending request may be awaiting customer confirmation or authorization."],
      evidence: [
        { label: "Pending requests", value: String(snapshot.exceptions.pendingWithdrawals) },
      ],
      recommendedAction: "Review the request in the Withdrawals screen; Zeli will not approve or post it.",
      type: "detected_pattern",
    });
  }

  insights.push(...branchOutliers(snapshot));
  const engagement = engagementTrend(snapshot);
  if (engagement) insights.push(engagement);

  if (snapshot.freshness.stale) {
    insights.push({
      id: "stale-analytics",
      title: "Analytics data may be out of date",
      detail:
        "The latest refresh did not complete. Figures come from the last successful aggregate and may not include the most recent transactions.",
      severity: "warning",
      category: "data_quality",
      period,
      metric: "Data freshness",
      calculation: "Refresh status and last successful aggregate timestamp",
      source: snapshot.freshness.source,
      freshness,
      confidence: "high",
      limitations: ["Recent transactions may be missing until a successful refresh completes."],
      evidence: [{ label: "Last successful refresh", value: freshness }],
      recommendedAction: "Use Refresh. If the failure continues, check database health from the platform console.",
      type: "detected_pattern",
    });
  }

  if (snapshot.totals.transactionCount === 0) {
    insights.push({
      id: "no-activity",
      title: "No financial activity in this period",
      detail: `No contributions, withdrawals or remittances were recorded in ${period} for the selected scope.`,
      severity: "info",
      category: "data_quality",
      period,
      metric: "Transaction volume",
      calculation: "Count of non-reversed contributions, completed withdrawals and non-reversed remittances",
      source: snapshot.freshness.source,
      freshness,
      confidence: "high",
      limitations: ["An empty period is not necessarily an error; confirm that the business was open."],
      evidence: [{ label: "Transactions", value: "0" }],
      recommendedAction: "Check that staff recorded daily activity and that the selected branch is correct.",
      type: "detected_pattern",
    });
  }

  const order: Record<InsightSeverity, number> = { warning: 0, attention: 1, info: 2 };
  return insights.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Short recommendation list derived from insights, safe and read-only. */
export function recommendationsFrom(insights: Insight[]): Array<{
  id: string;
  title: string;
  action: string;
  severity: InsightSeverity;
}> {
  const seen = new Set<string>();
  const output: Array<{ id: string; title: string; action: string; severity: InsightSeverity }> = [];
  for (const insight of insights) {
    if (!insight.recommendedAction || seen.has(insight.recommendedAction)) continue;
    seen.add(insight.recommendedAction);
    output.push({
      id: `rec-${insight.id}`,
      title: insight.title,
      action: insight.recommendedAction,
      severity: insight.severity,
    });
    if (output.length >= 5) break;
  }
  return output;
}
