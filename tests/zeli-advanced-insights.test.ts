import { describe, expect, it } from "vitest";
import { detectInsights, recommendationsFrom } from "@/lib/zeli/intelligence/insights";
import type { AnalyticsSnapshot } from "@/lib/zeli/intelligence/metrics";

function baseSnapshot(): AnalyticsSnapshot {
  const empty = {
    contributions: 0,
    contributionCount: 0,
    withdrawals: 0,
    withdrawalCount: 0,
    commissions: 0,
    remittances: 0,
    remittanceVariance: 0,
    remittanceCount: 0,
    expenses: 0,
    expenseCount: 0,
    cashIncome: 0,
    transactionCount: 0,
    netCashFlow: 0,
    activeAccounts: 0,
    newCustomers: 0,
  };
  return {
    tenant: { id: "t", name: "Tenant", code: "T" },
    filters: { period: "this_month", from: null, to: null, locationId: null, locationName: null },
    period: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-10T23:59:59.000Z", label: "This month", days: 10 },
    previousPeriod: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T23:59:59.000Z", label: "Previous month" },
    totals: { ...empty, contributions: 500, contributionCount: 12, transactionCount: 20, activeAccounts: 6, withdrawals: 100, expenses: 50, netCashFlow: 350 },
    previousTotals: { ...empty, contributions: 400, contributionCount: 10, transactionCount: 15, withdrawals: 80, expenses: 40, netCashFlow: 280 },
    comparison: { contributionsPct: 25, withdrawalsPct: 25, expensesPct: 25, netCashFlowPct: 25, transactionVolumePct: 33 },
    series: Array.from({ length: 10 }).map((_, index) => ({
      date: `2026-11-${String(index + 1).padStart(2, "0")}`,
      contributions: index < 2 ? 250 : 0,
      withdrawals: 0,
      expenses: 0,
      income: 0,
      netCashFlow: index < 2 ? 250 : 0,
      remittances: 0,
      transactionCount: index < 2 ? 10 : 0,
      activeAccounts: index < 2 ? 6 : 0,
      newCustomers: 0,
    })),
    branchPerformance: [],
    collectorActivity: [
      { collectorId: "c1", collectorName: "Collector One", contributions: 900, contributionCount: 8, remittances: 900, remittanceCount: 2 },
      { collectorId: "c2", collectorName: "Collector Two", contributions: 50, contributionCount: 2, remittances: 50, remittanceCount: 1 },
      { collectorId: "c3", collectorName: "Collector Three", contributions: 50, contributionCount: 2, remittances: 50, remittanceCount: 1 },
    ],
    customer: {
      newCustomers: 2,
      activeAccounts: 6,
      contributingAccounts: 6,
      totalActiveAccounts: 20,
      dormantAccounts: 14,
      singleContributionAccounts: 5,
      engagement: [
        { bucket: "1 contribution", accounts: 5 },
        { bucket: "2–5 contributions", accounts: 1 },
      ],
      series: [],
    },
    exceptions: {
      pendingWithdrawals: 0,
      remittanceDiscrepancies: 0,
      dailyAccountsAwaitingReview: 0,
      collectorsWithoutRemittance: 0,
      incompleteDailyAccounts: 0,
      total: 0,
    },
    freshness: {
      refreshedAt: "2026-11-10T12:00:00.000Z",
      stale: false,
      warning: null,
      source: "ZeliAnalyticsDaily aggregate",
      ttlSeconds: 60,
    },
    currency: "GHS",
    locations: [],
    reconciliation: {
      contributionSource: "Contribution rows",
      withdrawalSource: "Withdrawal rows",
      remittanceSource: "Remittance rows",
      expenseSource: "Expense rows",
      note: "Reconciles",
    },
  };
}

describe("advanced business insights", () => {
  it("detects dormant accounts, contribution consistency and reporting gaps", () => {
    const insights = detectInsights(baseSnapshot());
    const ids = insights.map((insight) => insight.id);
    expect(ids).toContain("dormant-accounts");
    expect(ids).toContain("contribution-consistency");
    expect(ids).toContain("reporting-gaps");
    expect(ids).toContain("collector-concentration");
    for (const insight of insights) {
      expect(insight.period).toBeTruthy();
      expect(insight.calculation).toBeTruthy();
      expect(insight.source).toBeTruthy();
      expect(insight.freshness).toBeTruthy();
      expect(insight.confidence).toMatch(/high|medium|low/);
      expect(insight.type).toBe("detected_pattern");
    }
  });

  it("produces recommendations with evidence, period, confidence and human action", () => {
    const recommendations = recommendationsFrom(detectInsights(baseSnapshot()));
    expect(recommendations.length).toBeGreaterThan(0);
    for (const recommendation of recommendations) {
      expect(recommendation.title).toBeTruthy();
      expect(recommendation.explanation).toBeTruthy();
      expect(recommendation.evidenceSource).toBeTruthy();
      expect(recommendation.period).toBeTruthy();
      expect(recommendation.suggestedInvestigation).toBeTruthy();
      expect(recommendation.confidence).toMatch(/high|medium|low/);
      expect(recommendation.humanActionRequired).toBe(true);
    }
  });

  it("does not claim fraud or misconduct", () => {
    const serialized = JSON.stringify(detectInsights(baseSnapshot())).toLowerCase();
    expect(serialized).not.toContain("committed fraud");
    expect(serialized).not.toContain("is fraud");
    expect(serialized).not.toContain("proof of misconduct");
  });
});
