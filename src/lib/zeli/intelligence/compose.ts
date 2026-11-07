import type { AnalyticsSnapshot } from "./metrics";
import { detectInsights, recommendationsFrom, type Insight } from "./insights";

/**
 * Template-based response composition.
 *
 * This module converts verified metrics and detected patterns into readable
 * explanations. It is not a language model: every sentence is selected by a
 * rule and filled from server-computed values. The product therefore labels it
 * as automated interpretation, not generated reasoning.
 */

export type StatementKind =
  | "calculated_fact"
  | "detected_pattern"
  | "automated_interpretation"
  | "suggested_action"
  | "unverified_hypothesis";

export interface ComposedStatement {
  kind: StatementKind;
  label: string;
  text: string;
}

export interface ComposedAnswer {
  title: string;
  text: string;
  statements: ComposedStatement[];
  period: string;
  source: string;
  freshness: string;
  limitations: string[];
  deterministic: true;
  provider: "internal";
  model: "rule-based";
  focus: string;
}

const LABELS: Record<StatementKind, string> = {
  calculated_fact: "CALCULATED FACT",
  detected_pattern: "DETECTED PATTERN",
  automated_interpretation: "AUTOMATED INTERPRETATION",
  suggested_action: "SUGGESTED ACTION",
  unverified_hypothesis: "UNVERIFIED HYPOTHESIS",
};

function money(value: number): string {
  return `GH₵${value.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signedPct(value: number | null): string {
  if (value == null) return "not comparable (no meaningful previous-period base)";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function statement(kind: StatementKind, text: string): ComposedStatement {
  return { kind, label: LABELS[kind], text };
}

function render(answer: Omit<ComposedAnswer, "text">): ComposedAnswer {
  const text = answer.statements
    .map((item) => `[${item.label}] ${item.text}`)
    .join("\n\n");
  return { ...answer, text };
}

function insightStatement(insight: Insight): ComposedStatement {
  return statement(
    "detected_pattern",
    `${insight.title}. ${insight.detail} Calculation: ${insight.calculation}. Source: ${insight.source}.`
  );
}

function overview(snapshot: AnalyticsSnapshot): ComposedAnswer {
  const insights = detectInsights(snapshot);
  const recommendations = recommendationsFrom(insights);
  const statements: ComposedStatement[] = [
    statement(
      "calculated_fact",
      `For ${snapshot.period.label}, contributions were ${money(snapshot.totals.contributions)} across ${snapshot.totals.contributionCount} records. Withdrawals were ${money(snapshot.totals.withdrawals)} across ${snapshot.totals.withdrawalCount} completed records. Remittances were ${money(snapshot.totals.remittances)} with net variance ${money(snapshot.totals.remittanceVariance)}. Expenses were ${money(snapshot.totals.expenses)}.`
    ),
    statement(
      "calculated_fact",
      `Calculated net cash flow is ${money(snapshot.totals.netCashFlow)}: contributions plus cash income, minus withdrawals and expenses. ${snapshot.totals.activeAccounts} distinct accounts contributed in the period, and ${snapshot.totals.newCustomers} customers registered.`
    ),
    statement(
      "calculated_fact",
      `Compared with ${snapshot.previousPeriod.label}: contributions ${signedPct(snapshot.comparison.contributionsPct)}, withdrawals ${signedPct(snapshot.comparison.withdrawalsPct)}, expenses ${signedPct(snapshot.comparison.expensesPct)}, transaction volume ${signedPct(snapshot.comparison.transactionVolumePct)}.`
    ),
  ];

  for (const insight of insights.slice(0, 5)) statements.push(insightStatement(insight));

  statements.push(
    statement(
      "automated_interpretation",
      insights.length === 0
        ? "No rule-based anomaly crossed its configured threshold in this period. That does not prove the records are complete or correct."
        : "The patterns above are comparisons and threshold checks. They show what moved, not why it moved. Operational context is required before acting."
    )
  );

  if (recommendations.length > 0) {
    statements.push(
      statement(
        "suggested_action",
        recommendations
          .map((item, index) => `${index + 1}. ${item.action}`)
          .join(" ")
      )
    );
  } else {
    statements.push(
      statement(
        "suggested_action",
        "No exception crossed the configured recommendation threshold. Continue normal review of the reports."
      )
    );
  }

  statements.push(
    statement(
      "unverified_hypothesis",
      "None. Zeli does not invent explanations. If the patterns do not explain a difference, inspect the source records named in the calculation."
    )
  );

  return render({
    title: "Business summary",
    statements,
    period: snapshot.period.label,
    source: snapshot.freshness.source,
    freshness: `Last refreshed ${snapshot.freshness.refreshedAt}. ${snapshot.freshness.warning ?? ""}`.trim(),
    limitations: [
      "Rule-based output, not model-generated reasoning.",
      "Financial figures exclude reversed records and rows outside the reporting period.",
      "Branch attribution follows the recording user or collector's assigned location.",
    ],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: "overview",
  });
}

function contributionsAndWithdrawals(snapshot: AnalyticsSnapshot): ComposedAnswer {
  const insights = detectInsights(snapshot).filter(
    (insight) => insight.id === "contributions-change" || insight.id === "withdrawals-change"
  );
  const statements: ComposedStatement[] = [
    statement(
      "calculated_fact",
      `Contributions: ${money(snapshot.totals.contributions)} from ${snapshot.totals.contributionCount} non-reversed records. Previous period: ${money(snapshot.previousTotals.contributions)}. Change: ${signedPct(snapshot.comparison.contributionsPct)}.`
    ),
    statement(
      "calculated_fact",
      `Withdrawals: ${money(snapshot.totals.withdrawals)} net paid across ${snapshot.totals.withdrawalCount} completed records. Previous period: ${money(snapshot.previousTotals.withdrawals)}. Change: ${signedPct(snapshot.comparison.withdrawalsPct)}.`
    ),
    statement(
      "calculated_fact",
      `Contributing accounts: ${snapshot.totals.activeAccounts}. Average contribution per record: ${
        snapshot.totals.contributionCount > 0
          ? money(snapshot.totals.contributions / snapshot.totals.contributionCount)
          : "not available (no records)"
      }.`
    ),
  ];
  if (insights.length === 0) {
    statements.push(
      statement(
        "detected_pattern",
        "Neither contributions nor withdrawals crossed the 10% change threshold against a meaningful base."
      )
    );
  } else {
    for (const insight of insights) statements.push(insightStatement(insight));
  }
  statements.push(
    statement(
      "automated_interpretation",
      "A contribution is money recorded into a Susu account. A withdrawal is money paid out after authorization. Reversed rows are excluded from both totals."
    ),
    statement(
      "suggested_action",
      "Open Contributions or Withdrawals to inspect the underlying records. Zeli does not post or approve financial entries."
    ),
    statement("unverified_hypothesis", "None.")
  );
  return render({
    title: "Contributions and withdrawals",
    statements,
    period: snapshot.period.label,
    source: snapshot.freshness.source,
    freshness: `Last refreshed ${snapshot.freshness.refreshedAt}.`,
    limitations: ["Withdrawal totals use netAmount after any charged commission."],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: "contributions_withdrawals",
  });
}

function changePct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function incomeAndExpenses(snapshot: AnalyticsSnapshot): ComposedAnswer {
  const income = snapshot.totals.cashIncome;
  const previousIncome = snapshot.previousTotals.cashIncome;
  return render({
    title: "Income and expenses",
    statements: [
      statement(
        "calculated_fact",
        `Recorded cash income for ${snapshot.period.label}: ${money(income)} across ${snapshot.totals.transactionCount} transaction records. Previous period: ${money(previousIncome)}. Change: ${signedPct(changePct(income, previousIncome))}.`
      ),
      statement(
        "calculated_fact",
        `Recorded expenses: ${money(snapshot.totals.expenses)} across ${snapshot.totals.expenseCount} expense records. Previous period: ${money(snapshot.previousTotals.expenses)}. Change: ${signedPct(snapshot.comparison.expensesPct)}.`
      ),
      statement(
        "calculated_fact",
        `Calculated net cash flow: ${money(snapshot.totals.netCashFlow)}. It is contributions plus recorded cash income, minus withdrawals and expenses.`
      ),
      statement(
        "automated_interpretation",
        "Recorded cash income means commission and other income recorded by the business. It does not include customers' savings contributions, which are reported separately. Expenses are recorded expense entries in the period; reversed records are excluded."
      ),
      statement(
        "suggested_action",
        "Open Money & History to review the individual income and expense entries for the period."
      ),
      statement("unverified_hypothesis", "None."),
    ],
    period: snapshot.period.label,
    source: snapshot.freshness.source,
    freshness: `Last refreshed ${snapshot.freshness.refreshedAt}.`,
    limitations: [
      "Rule-based output, not model-generated reasoning.",
      "Only recorded entries inside the reporting period are included.",
    ],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: "income_expenses",
  });
}

function remittances(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return render({
    title: "Remittance activity",
    statements: [
      statement(
        "calculated_fact",
        `In ${snapshot.period.label}, ${snapshot.totals.remittanceCount} active remittance record(s) totalled ${money(snapshot.totals.remittances)}. Net variance (expected minus remitted) was ${money(snapshot.totals.remittanceVariance)}.`
      ),
      statement(
        "calculated_fact",
        `${snapshot.exceptions.collectorsWithoutRemittance} collector(s) recorded contributions without a remittance in the same period. ${snapshot.exceptions.remittanceDiscrepancies} remittance record(s) are marked as a discrepancy.`
      ),
      statement(
        "detected_pattern",
        snapshot.totals.remittanceVariance === 0
          ? "No net remittance variance was detected for the period."
          : "The net variance is not zero. A later remittance can legitimately cover earlier collections, so check the collector statement before escalating."
      ),
      statement(
        "automated_interpretation",
        "Remittance figures exclude records with reversedAt set. Reversing a remittance keeps the original row for audit but removes it from active totals."
      ),
      statement(
        "suggested_action",
        "Open Money Handed In and compare the expected amount, the amount handed in and the reasons recorded by staff."
      ),
      statement("unverified_hypothesis", "None."),
    ],
    period: snapshot.period.label,
    source: snapshot.reconciliation.remittanceSource,
    freshness: `Last refreshed ${snapshot.freshness.refreshedAt}.`,
    limitations: ["Period boundaries use UTC dates."],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: "remittances",
  });
}

function exceptions(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return render({
    title: "Outstanding operational exceptions",
    statements: [
      statement(
        "calculated_fact",
        `Open exceptions in scope: ${snapshot.exceptions.pendingWithdrawals} pending withdrawal(s), ${snapshot.exceptions.remittanceDiscrepancies} remittance discrepancy record(s), ${snapshot.exceptions.dailyAccountsAwaitingReview} daily account(s) awaiting review, and ${snapshot.exceptions.collectorsWithoutRemittance} collector(s) without a remittance in the period.`
      ),
      statement(
        "calculated_fact",
        `${snapshot.exceptions.incompleteDailyAccounts} daily account(s) are still draft or submitted in the selected scope.`
      ),
      statement(
        "automated_interpretation",
        "These are current-state counts combined with period flow. They identify work to review; they are not proof of loss or misconduct."
      ),
      statement(
        "suggested_action",
        "Work through the oldest items first: review submitted daily accounts, confirm remittance handovers, then resolve pending withdrawals through the authorized screen."
      ),
      statement("unverified_hypothesis", "None."),
    ],
    period: snapshot.period.label,
    source: "DailyAccount, Withdrawal and CollectorRemittance status",
    freshness: `Last refreshed ${snapshot.freshness.refreshedAt}.`,
    limitations: ["Status counts reflect the moment of the refresh, not the selected period end."],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: "exceptions",
  });
}

function branches(snapshot: AnalyticsSnapshot): ComposedAnswer {
  const top = snapshot.branchPerformance.slice(0, 5);
  const insights = detectInsights(snapshot).filter((insight) => insight.category === "branch");
  return render({
    title: "Branch comparison",
    statements: [
      statement(
        "calculated_fact",
        top.length === 0
          ? "No active branch had financial activity in the selected period."
          : top
              .map(
                (branch) =>
                  `${branch.locationName}: contributions ${money(branch.contributions)}, withdrawals ${money(branch.withdrawals)}, expenses ${money(branch.expenses)}, net cash flow ${money(branch.netCashFlow)}`
              )
              .join(". ") + "."
      ),
      ...(insights.length > 0
        ? insights.map(insightStatement)
        : [
            statement(
              "detected_pattern",
              "No branch crossed the statistical outlier threshold. Branches still differ by size and operations."
            ),
          ]),
      statement(
        "automated_interpretation",
        "Branch figures are attributed through the staff member or collector assigned to the location at the time of recording. A transaction with no location link is excluded from branch rows but remains in tenant totals."
      ),
      statement(
        "suggested_action",
        "Compare branch staffing, opening days and remittance timing before treating a difference as a problem."
      ),
      statement("unverified_hypothesis", "None."),
    ],
    period: snapshot.period.label,
    source: snapshot.freshness.source,
    freshness: `Last refreshed ${snapshot.freshness.refreshedAt}.`,
    limitations: ["Branch comparisons are operational, not causal."],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: "branches",
  });
}

export type ExplainableChartId =
  | "contributions_vs_withdrawals"
  | "income_vs_expenses"
  | "net_cash_flow"
  | "remittances"
  | "transaction_volume"
  | "branch_performance"
  | "customer_activity"
  | "exceptions";

const CHART_TITLES: Record<ExplainableChartId, string> = {
  contributions_vs_withdrawals: "Contributions and withdrawals over time",
  income_vs_expenses: "Income versus expenses",
  net_cash_flow: "Net cash-flow trend",
  remittances: "Remittance trend",
  transaction_volume: "Daily transaction activity",
  branch_performance: "Branch performance",
  customer_activity: "Customer activity",
  exceptions: "Operational exceptions",
};

export function isExplainableChart(value: string): value is ExplainableChartId {
  return Object.hasOwn(CHART_TITLES, value);
}

/** Explain one chart using the same server-computed snapshot. */
export function explainChart(
  snapshot: AnalyticsSnapshot,
  chartId: ExplainableChartId
): ComposedAnswer {
  const label = CHART_TITLES[chartId];
  const points = snapshot.series;
  const peak = points.reduce(
    (best, point) => {
      const value =
        chartId === "income_vs_expenses"
          ? Math.max(point.income, point.expenses)
          : chartId === "remittances"
            ? point.remittances
            : chartId === "transaction_volume"
              ? point.transactionCount
              : chartId === "net_cash_flow"
                ? Math.abs(point.netCashFlow)
                : chartId === "customer_activity"
                  ? point.activeAccounts
                  : Math.max(point.contributions, point.withdrawals);
      return value > best.value ? { date: point.date, value } : best;
    },
    { date: "—", value: 0 }
  );
  const insights = detectInsights(snapshot).slice(0, 3);
  const statements: ComposedStatement[] = [
    statement(
      "calculated_fact",
      `${label} for ${snapshot.period.label} is built from ${points.length} daily bucket(s). The highest point is ${peak.date} at ${peak.value}.`
    ),
    statement(
      "calculated_fact",
      `Period totals behind this chart: contributions ${money(snapshot.totals.contributions)}, withdrawals ${money(snapshot.totals.withdrawals)}, cash income ${money(snapshot.totals.cashIncome)}, expenses ${money(snapshot.totals.expenses)}, remittances ${money(snapshot.totals.remittances)}, transactions ${snapshot.totals.transactionCount}.`
    ),
    ...(insights.length > 0
      ? insights.map(insightStatement)
      : [statement("detected_pattern", "No rule-based anomaly crossed its threshold for this period.")]),
    statement(
      "automated_interpretation",
      "The chart shows recorded activity in UTC day buckets. It is a factual series with rule-based annotations; it does not explain causes."
    ),
    statement(
      "suggested_action",
      "Open the matching report to inspect individual records before acting on a movement."
    ),
    statement("unverified_hypothesis", "None."),
  ];
  return render({
    title: `Chart explanation: ${label}`,
    statements,
    period: snapshot.period.label,
    source: snapshot.freshness.source,
    freshness: `Last refreshed ${snapshot.freshness.refreshedAt}.`,
    limitations: [
      "Daily buckets are UTC.",
      "A zero day can mean no activity or missing records; check daily account submissions.",
    ],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: chartId,
  });
}

export function composeOverview(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return overview(snapshot);
}

export function composeContributions(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return contributionsAndWithdrawals(snapshot);
}

export function composeRemittances(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return remittances(snapshot);
}

export function composeIncomeExpenses(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return incomeAndExpenses(snapshot);
}

export function composeExceptions(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return exceptions(snapshot);
}

export function composeBranches(snapshot: AnalyticsSnapshot): ComposedAnswer {
  return branches(snapshot);
}

const DEFINITIONS: Array<{ keys: string[]; metric: string; explanation: string }> = [
  {
    keys: ["contribution", "savings", "deposit"],
    metric: "Contributions",
    explanation:
      "Contributions are non-reversed Contribution rows whose collectionDate falls inside the reporting period. They are the amounts recorded into Susu accounts, not the business's profit.",
  },
  {
    keys: ["withdrawal", "payout"],
    metric: "Withdrawals",
    explanation:
      "Withdrawals are completed, non-reversed Withdrawal rows created inside the period. The total uses netAmount, the amount actually paid after commission.",
  },
  {
    keys: ["remittance", "handed in", "handover"],
    metric: "Remittances",
    explanation:
      "Remittances are non-reversed CollectorRemittance rows. Variance is expectedAmount minus remittedAmount. Reversed remittances remain in history but are excluded here.",
  },
  {
    keys: ["net cash", "cash flow"],
    metric: "Net cash flow",
    explanation:
      "Net cash flow = contributions + recorded daily-account commission and other income − withdrawals − expenses. It is a period movement indicator, not a bank balance.",
  },
  {
    keys: ["active account", "customer activity"],
    metric: "Active accounts",
    explanation:
      "Active accounts are distinct Susu accounts with at least one non-reversed contribution in the period. A customer may hold more than one account.",
  },
  {
    keys: ["exception", "outstanding"],
    metric: "Operational exceptions",
    explanation:
      "Exceptions combine current pending withdrawals, submitted daily accounts awaiting review, remittance discrepancy records and collectors with collections but no remittance in the period.",
  },
];

export function explainMetricDefinition(question: string): ComposedAnswer | null {
  const lower = question.toLowerCase();
  const found = DEFINITIONS.find((definition) =>
    definition.keys.some((key) => lower.includes(key))
  );
  if (!found) return null;
  return render({
    title: `How ${found.metric} is calculated`,
    statements: [
      statement("calculated_fact", found.explanation),
      statement(
        "automated_interpretation",
        "The calculation is implemented in the server-side Zeli intelligence service and reads the same domain tables as the standard reports. It does not ask a language model to total money."
      ),
      statement(
        "suggested_action",
        "Use the matching report to inspect the records. If a figure differs, check the period, branch and reversal status first."
      ),
      statement("unverified_hypothesis", "None."),
    ],
    period: "Definition",
    source: "MaaCash domain schema and server aggregation",
    freshness: "Definition is versioned with the application",
    limitations: ["Definitions can change only through reviewed code and migration."],
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    focus: "definition",
  });
}
