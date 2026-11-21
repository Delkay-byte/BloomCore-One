"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { csvCell } from "@/lib/csv";
import {
  computeCashPosition,
  computeConsolidatedFlow,
  DECLARATION_STALE_DAYS,
  type BranchPosition,
  type CashPositionReport,
  type ConsolidatedFlow,
} from "@/lib/reporting/cash-position";
import {
  computeCompleteness,
  LATE_SUBMISSION_DAYS,
  type CompletenessReport,
} from "@/lib/reporting/completeness";
import {
  CONSOLIDATED_REPORT_NOTE,
  METRIC_DICTIONARY,
  type MetricDefinition,
} from "@/lib/reporting/dictionary";

/**
 * Consolidated MoMo reporting.
 *
 * One place that answers "what money is where, what moved, what did we earn and
 * what is missing" — with each answer keeping its own meaning. The figures are
 * computed from the records rather than from cached snapshots, so a report cannot
 * drift from the source rows.
 */

export interface ConsolidatedReport {
  period: { from: string; to: string };
  position: CashPositionReport;
  flow: ConsolidatedFlow;
  completeness: CompletenessReport;
  branches: Array<{ id: string; name: string }>;
  dictionary: MetricDefinition[];
  note: string;
  staleDeclarationDays: number;
  lateSubmissionDays: number;
}

export interface ConsolidatedResponse {
  success: boolean;
  error?: string;
  data?: ConsolidatedReport;
}

function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29))
    .toISOString()
    .slice(0, 10);
  return { from: start, to: end };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function periodFromInput(from?: string, to?: string): { from: string; to: string } {
  const fallback = defaultPeriod();
  const end = DATE_ONLY.test(to ?? "") ? (to as string) : fallback.to;
  const start = DATE_ONLY.test(from ?? "") ? (from as string) : fallback.from;
  if (start > end) return { from: end, to: start };
  const days =
    Math.round(
      (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) /
        86_400_000
    ) + 1;
  if (days > 366) {
    return {
      from: new Date(new Date(`${end}T00:00:00Z`).getTime() - 365 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      to: end,
    };
  }
  return { from: start, to: end };
}

function pct(value: string | number | { toString(): string } | null): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

export async function getConsolidatedReport(input?: {
  from?: string;
  to?: string;
}): Promise<ConsolidatedResponse> {
  const ctx = await requireTenantAdminMomo();
  const period = periodFromInput(input?.from, input?.to);
  const start = new Date(`${period.from}T00:00:00.000Z`);
  const end = new Date(`${period.to}T23:59:59.999Z`);

  const [locations, workers, declarations, accounts, transfers, transactions] =
    await Promise.all([
      db.location.findMany({
        where: { tenantId: ctx.tenantId, status: "active" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      db.user.findMany({
        where: {
          tenantId: ctx.tenantId,
          role: { in: ["worker", "collector"] },
          status: "active",
        },
        select: { id: true, fullName: true, locationId: true, status: true },
      }),
      db.branchAssetBalance.findMany({
        where: { tenantId: ctx.tenantId },
        select: {
          locationId: true,
          assetType: true,
          declaredBalance: true,
          declaredAt: true,
        },
      }),
      db.dailyAccount.findMany({
        where: { tenantId: ctx.tenantId, businessDate: { gte: start, lte: end } },
        select: {
          id: true,
          locationId: true,
          workerId: true,
          businessDate: true,
          status: true,
          submittedAt: true,
          closingCash: true,
          closingMomoFloat: true,
          calculatedCashVariance: true,
          calculatedMomoVariance: true,
          calculatedDifference: true,
          commission: true,
          otherIncome: true,
          debtsCollected: true,
          totalExpenses: true,
        },
      }),
      db.branchTransfer.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: { in: ["received", "completed"] },
          OR: [
            { receivedAt: { gte: start, lte: end } },
            { dispatchedAt: { gte: start, lte: end } },
            { createdAt: { gte: start, lte: end } },
          ],
        },
        select: {
          sourceLocationId: true,
          destinationLocationId: true,
          assetType: true,
          amount: true,
          status: true,
          receivedAt: true,
          dispatchedAt: true,
          createdAt: true,
        },
      }),
      db.momoTransaction.findMany({
        where: { tenantId: ctx.tenantId, businessDate: { gte: start, lte: end } },
        select: {
          type: true,
          direction: true,
          amount: true,
          status: true,
          reversesTransactionId: true,
        },
      }),
    ]);

  const position = computeCashPosition({
    from: period.from,
    to: period.to,
    asOf: new Date(),
    locations: locations.map((row) => row.id),
    declarations: declarations.map((row) => ({
      locationId: row.locationId,
      assetType: row.assetType,
      declaredBalance: pct(row.declaredBalance),
      declaredAt: row.declaredAt,
    })),
    closes: accounts.map((row) => ({
      locationId: row.locationId,
      businessDate: row.businessDate,
      status: row.status,
      closingCash: pct(row.closingCash),
      closingMomoFloat: pct(row.closingMomoFloat),
      calculatedCashVariance: pct(row.calculatedCashVariance),
      calculatedMomoVariance: pct(row.calculatedMomoVariance),
      calculatedDifference: pct(row.calculatedDifference),
    })),
    transfers: transfers.map((row) => ({
      sourceLocationId: row.sourceLocationId,
      destinationLocationId: row.destinationLocationId,
      assetType: row.assetType,
      amount: pct(row.amount),
      status: row.status,
      movedAt: row.receivedAt ?? row.dispatchedAt ?? row.createdAt,
    })),
  });

  const flow = computeConsolidatedFlow({
    transactions: transactions.map((row) => ({
      type: row.type,
      direction: row.direction,
      amount: pct(row.amount),
      status: row.status,
      isReversal: Boolean(row.reversesTransactionId) || row.status === "reversal",
    })),
    closes: accounts.map((row) => ({
      commission: pct(row.commission),
      otherIncome: pct(row.otherIncome),
      debtsCollected: pct(row.debtsCollected),
      totalExpenses: pct(row.totalExpenses),
      status: row.status,
    })),
  });

  const completeness = computeCompleteness({
    from: period.from,
    to: period.to,
    branches: locations,
    workers: workers.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      locationId: row.locationId,
      status: row.status,
    })),
    accounts: accounts.map((row) => ({
      locationId: row.locationId,
      workerId: row.workerId,
      businessDate: row.businessDate,
      status: row.status,
      submittedAt: row.submittedAt,
    })),
  });

  return {
    success: true,
    data: {
      period,
      position,
      flow,
      completeness,
      branches: locations,
      dictionary: METRIC_DICTIONARY,
      note: CONSOLIDATED_REPORT_NOTE,
      staleDeclarationDays: DECLARATION_STALE_DAYS,
      lateSubmissionDays: LATE_SUBMISSION_DAYS,
    },
  };
}

/** The same report as CSV, with the metric dictionary included. */
export async function exportConsolidatedCsv(input?: {
  from?: string;
  to?: string;
}): Promise<{ success: boolean; error?: string; data?: { filename: string; csv: string } }> {
  const result = await getConsolidatedReport(input);
  if (!result.success || !result.data) {
    return { success: false, error: result.error ?? "The report could not be built." };
  }
  const report = result.data;
  const lines: string[] = [];
  lines.push(`Consolidated MoMo report,${report.period.from} to ${report.period.to}`);
  lines.push("");
  lines.push("Branch position");
  lines.push(
    [
      "Branch",
      "Declared cash",
      "Declared float",
      "Transfers in",
      "Transfers out",
      "Closing cash (reported)",
      "Closing float (reported)",
      "Cash variance",
      "Float variance",
      "Declaration age (days)",
    ]
      .map(csvCell)
      .join(",")
  );
  const nameOf = new Map(report.branches.map((row) => [row.id, row.name]));
  for (const branch of report.position.branches) {
    lines.push(
      [
        nameOf.get(branch.locationId) ?? branch.locationId,
        branch.declaredCash,
        branch.declaredFloat,
        branch.transfersIn,
        branch.transfersOut,
        branch.closingCashReported,
        branch.closingFloatReported,
        branch.cashVariance,
        branch.floatVariance,
        branch.declarationAgeDays ?? "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  lines.push(
    [
      "Total",
      report.position.totals.declaredCash,
      report.position.totals.declaredFloat,
      report.position.totals.transfersIn,
      report.position.totals.transfersOut,
      report.position.totals.closingCashReported,
      report.position.totals.closingFloatReported,
      report.position.totals.cashVariance,
      report.position.totals.floatVariance,
      "",
    ]
      .map(csvCell)
      .join(",")
  );

  lines.push("");
  lines.push("Operational flow and accounting result");
  lines.push(["Metric", "Kind", "Value", "Formula"].map(csvCell).join(","));
  const flowRows: Array<[string, string, number]> = [
    ["principal_in", "Money moved (not income)", report.flow.principalIn],
    ["principal_out", "Money moved (not income)", report.flow.principalOut],
    ["commission", "Accounting result", report.flow.commission],
    ["other_income", "Accounting result", report.flow.otherIncome],
    ["debts_collected", "Accounting result", report.flow.debtsCollected],
    ["expenses", "Accounting result", report.flow.expenses],
    ["net_operating", "Accounting result", report.flow.netOperating],
    ["declared_cash", "Balance at a point in time", report.position.totals.declaredCash],
    ["declared_float", "Balance at a point in time", report.position.totals.declaredFloat],
    ["transfers_in", "Operational flow", report.position.totals.transfersIn],
    ["transfers_out", "Operational flow", report.position.totals.transfersOut],
    ["close_cash_variance", "Operational flow", report.position.totals.cashVariance],
    ["close_float_variance", "Operational flow", report.position.totals.floatVariance],
  ];
  for (const [key, kind, value] of flowRows) {
    const definition = report.dictionary.find((row) => row.key === key);
    lines.push([definition?.label ?? key, kind, value, definition?.formula ?? ""].map(csvCell).join(","));
  }

  lines.push("");
  lines.push("Completeness");
  lines.push(
    [
      "Branch",
      "Expected days",
      "Submitted days",
      "Missing days",
      "Late closes",
      "Operators",
      "Operators without a close",
      "Coverage %",
    ]
      .map(csvCell)
      .join(",")
  );
  for (const branch of report.completeness.branches) {
    lines.push(
      [
        branch.locationName,
        branch.expectedDays,
        branch.submittedDays,
        branch.missingDays.length,
        branch.lateDays,
        branch.operators,
        branch.operatorsWithoutClose,
        branch.coveragePct,
      ]
        .map(csvCell)
        .join(",")
    );
  }

  lines.push("");
  lines.push([report.note].map(csvCell).join(","));
  for (const note of report.position.notes) lines.push([note].map(csvCell).join(","));
  for (const note of report.completeness.notes) lines.push([note].map(csvCell).join(","));

  return {
    success: true,
    data: {
      filename: `consolidated-momo-${report.period.from}-to-${report.period.to}.csv`,
      csv: lines.join("\n"),
    },
  };
}

export type { BranchPosition };
