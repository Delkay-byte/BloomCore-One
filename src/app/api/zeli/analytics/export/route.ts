import { NextRequest, NextResponse } from "next/server";
import { getApiZeliAnalyticsContext } from "@/lib/zeli/entitlements";
import { db } from "@/lib/db";
import { buildAnalyticsSnapshot } from "@/lib/zeli/intelligence/metrics";
import { detectInsights } from "@/lib/zeli/intelligence/insights";
import { PeriodValidationError, type PeriodPreset } from "@/lib/zeli/intelligence/period";

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function line(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * GET /api/zeli/analytics/export
 *
 * Exports aggregate figures for the authorized tenant. It does not include
 * customer names, phone numbers, account numbers, transaction ids or notes.
 * The same entitlement guard as the workspace runs before any query.
 */
export async function GET(request: NextRequest) {
  const ctx = await getApiZeliAnalyticsContext();
  if (!ctx) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const period = (params.get("period") || "this_month") as PeriodPreset;
  try {
    const tenant = await db.businessTenant.findUnique({
      where: { id: ctx.tenantId },
      select: { id: true, name: true, code: true, status: true },
    });
    if (!tenant || tenant.status !== "ACTIVE") {
      return NextResponse.json({ error: "Business unavailable" }, { status: 403 });
    }
    const snapshot = await buildAnalyticsSnapshot({
      tenant: { id: tenant.id, name: tenant.name, code: tenant.code },
      filters: {
        period,
        from: params.get("from") || undefined,
        to: params.get("to") || undefined,
        locationId: params.get("location") || undefined,
      },
    });
    const insights = detectInsights(snapshot);

    const rows: string[] = [];
    rows.push(line(["Zeli Business Intelligence export"]));
    rows.push(line(["Business", snapshot.tenant.name, snapshot.tenant.code]));
    rows.push(line(["Period", snapshot.period.label]));
    rows.push(line(["Branch", snapshot.filters.locationName ?? "All branches"]));
    rows.push(line(["Last refreshed", snapshot.freshness.refreshedAt]));
    rows.push(line(["Currency", snapshot.currency]));
    rows.push("");
    rows.push(line(["Totals"]));
    rows.push(line(["Metric", "Value"]));
    rows.push(line(["Contributions", snapshot.totals.contributions]));
    rows.push(line(["Contribution records", snapshot.totals.contributionCount]));
    rows.push(line(["Withdrawals (net)", snapshot.totals.withdrawals]));
    rows.push(line(["Withdrawal records", snapshot.totals.withdrawalCount]));
    rows.push(line(["Remittances", snapshot.totals.remittances]));
    rows.push(line(["Remittance variance", snapshot.totals.remittanceVariance]));
    rows.push(line(["Expenses", snapshot.totals.expenses]));
    rows.push(line(["Cash income", snapshot.totals.cashIncome]));
    rows.push(line(["Net cash flow", snapshot.totals.netCashFlow]));
    rows.push(line(["Active accounts", snapshot.totals.activeAccounts]));
    rows.push(line(["New customers", snapshot.totals.newCustomers]));
    rows.push("");
    rows.push(line(["Daily series"]));
    rows.push(
      line([
        "Date",
        "Contributions",
        "Withdrawals",
        "Expenses",
        "Income",
        "Net cash flow",
        "Remittances",
        "Transactions",
        "Active accounts",
        "New customers",
      ])
    );
    for (const point of snapshot.series) {
      rows.push(
        line([
          point.date,
          point.contributions,
          point.withdrawals,
          point.expenses,
          point.income,
          point.netCashFlow,
          point.remittances,
          point.transactionCount,
          point.activeAccounts,
          point.newCustomers,
        ])
      );
    }
    rows.push("");
    rows.push(line(["Branch performance"]));
    rows.push(line(["Branch", "Contributions", "Withdrawals", "Remittances", "Expenses", "Net cash flow", "Transactions"]));
    for (const branch of snapshot.branchPerformance) {
      rows.push(
        line([
          branch.locationName,
          branch.contributions,
          branch.withdrawals,
          branch.remittances,
          branch.expenses,
          branch.netCashFlow,
          branch.transactionCount,
        ])
      );
    }
    rows.push("");
    rows.push(line(["Detected patterns (rule-based)"]));
    rows.push(line(["Severity", "Title", "Detail", "Calculation", "Source"]));
    for (const insight of insights) {
      rows.push(
        line([
          insight.severity,
          insight.title,
          insight.detail,
          insight.calculation,
          insight.source,
        ])
      );
    }

    const filename = `zeli-analytics-${snapshot.period.start.slice(0, 10)}-${snapshot.period.end.slice(0, 10)}.csv`;
    return new NextResponse(rows.join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PeriodValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
