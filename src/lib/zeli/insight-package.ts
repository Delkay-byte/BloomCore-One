import type { AnalyticsSnapshot } from "./intelligence/metrics";
import type { ClassifiedIntent } from "./intelligence/intents";
import {
  INSIGHT_SCHEMA_VERSION,
  type InsightPackage,
} from "./gateway";

/** Build the only outbound package allowed for an approved explanation. */
export function buildInsightPackage(
  snapshot: AnalyticsSnapshot,
  intent: ClassifiedIntent["intent"]
): InsightPackage {
  const purpose =
    intent === "branches"
      ? "branch_comparison"
      : intent === "remittances"
        ? "remittance_pattern"
        : intent === "exceptions"
          ? "exception_explanation"
          : intent === "chart_explanation"
            ? "chart_explanation"
            : intent === "compare_periods" || intent === "why_changed"
              ? "period_comparison"
              : "trend_explanation";

  const granularity =
    snapshot.period.days <= 1
      ? "day"
      : snapshot.period.days <= 7
        ? "week"
        : snapshot.period.days <= 31
          ? "month"
          : "quarter";

  const comparisons: Array<{
    metric: InsightPackage["metrics"][number]["metric"];
    change: number | null;
  }> = [
    { metric: "contributions", change: snapshot.comparison.contributionsPct },
    { metric: "withdrawals", change: snapshot.comparison.withdrawalsPct },
    { metric: "net_cash_flow", change: snapshot.comparison.netCashFlowPct },
    { metric: "expenses", change: snapshot.comparison.expensesPct },
    { metric: "transaction_volume", change: snapshot.comparison.transactionVolumePct },
  ];

  const cohort = Math.max(
    snapshot.totals.activeAccounts,
    snapshot.totals.transactionCount,
    snapshot.totals.newCustomers
  );

  return {
    schemaVersion: INSIGHT_SCHEMA_VERSION,
    purpose,
    reportingPeriod: {
      granularity,
      comparison: "previous_period",
    },
    metrics: comparisons.map((entry) => ({
      metric: entry.metric,
      direction:
        entry.change == null
          ? "unknown"
          : entry.change > 0
            ? "up"
            : entry.change < 0
              ? "down"
              : "flat",
      changeBand:
        entry.change == null
          ? "unknown"
          : Math.abs(entry.change) < 5
            ? "lt_5"
            : Math.abs(entry.change) < 10
              ? "5_10"
              : Math.abs(entry.change) < 25
                ? "10_25"
                : Math.abs(entry.change) < 50
                  ? "25_50"
                  : "gt_50",
    })),
    cohortBand: cohort >= 100 ? "100_plus" : cohort >= 25 ? "25_99" : "5_24",
    categories:
      purpose === "branch_comparison"
        ? ["branch_trend"]
        : purpose === "remittance_pattern"
          ? ["remittance_activity"]
          : purpose === "exception_explanation"
            ? ["operational_exception"]
            : ["period_trend"],
  };
}

export function buildSyntheticInsightPackage(): InsightPackage {
  return {
    schemaVersion: INSIGHT_SCHEMA_VERSION,
    purpose: "trend_explanation",
    reportingPeriod: { granularity: "month", comparison: "previous_period" },
    metrics: [
      { metric: "contributions", direction: "up", changeBand: "10_25" },
      { metric: "transaction_volume", direction: "up", changeBand: "5_10" },
    ],
    cohortBand: "25_99",
    categories: ["period_trend"],
    synthetic: true,
    syntheticScenario: "integration_probe",
  };
}
