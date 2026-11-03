"use client";

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  BarChart3,
  CheckCircle2,
  Download,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { StatCard } from "@/components/ui/DataDisplay";
import { SkeletonPage } from "@/components/ui/Skeletons";
import {
  explainZeliChartAction,
  refreshZeliAnalyticsNow,
  type AnalyticsDashboardData,
} from "@/lib/actions/zeli-analytics.actions";
import type { ExplainableChartId } from "@/lib/zeli/intelligence/compose";
import { formatDateTime } from "@/lib/utils";

const PERIODS: Array<{ value: string; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This week" },
  { value: "previous_week", label: "Previous week" },
  { value: "this_month", label: "This month" },
  { value: "previous_month", label: "Previous month" },
  { value: "this_quarter", label: "This quarter" },
  { value: "custom", label: "Custom" },
];

interface Props {
  data: AnalyticsDashboardData;
  filters: {
    period: string;
    from: string | null;
    to: string | null;
    locationId: string | null;
  };
}

function money(value: number): string {
  return `GH₵${value.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function Change({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-slate-400">not comparable</span>;
  const positive = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${
        positive ? "text-emerald-700" : "text-red-700"
      }`}
    >
      {positive ? <ArrowUpRight size={12} aria-hidden /> : <ArrowDownRight size={12} aria-hidden />}
      {positive ? "+" : ""}
      {value.toFixed(1)}% vs previous
    </span>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  warning: "border-red-200 bg-red-50 text-red-900",
  attention: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-brand-100 bg-brand-50 text-brand-900",
};

export default function AnalyticsDashboard({ data, filters }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [explaining, setExplaining] = useState<ExplainableChartId | null>(null);
  const [explanation, setExplanation] = useState<{
    chartId: ExplainableChartId;
    title: string;
    text: string;
    statements: Array<{ kind: string; label: string; text: string }>;
    freshness: string | null;
  } | null>(null);
  const [explainError, setExplainError] = useState("");
  const [customFrom, setCustomFrom] = useState(filters.from ?? "");
  const [customTo, setCustomTo] = useState(filters.to ?? "");

  const { snapshot, insights, recommendations } = data;

  const exportHref = useMemo(() => {
    const params = new URLSearchParams();
    params.set("period", filters.period);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.locationId) params.set("location", filters.locationId);
    return `/api/zeli/analytics/export?${params.toString()}`;
  }, [filters]);

  function navigate(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value) params.delete(key);
      else params.set(key, value);
    }
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  async function refresh() {
    setRefreshing(true);
    setRefreshError("");
    try {
      const result = await refreshZeliAnalyticsNow({
        period: filters.period,
        from: filters.from ?? undefined,
        to: filters.to ?? undefined,
        locationId: filters.locationId ?? undefined,
      });
      if (!result.success) {
        setRefreshError(result.error ?? "Refresh failed.");
        return;
      }
      router.refresh();
    } catch {
      setRefreshError("Refresh failed. The previous aggregates were kept.");
    } finally {
      setRefreshing(false);
    }
  }

  async function explain(chartId: ExplainableChartId) {
    setExplaining(chartId);
    setExplainError("");
    setExplanation(null);
    try {
      const result = await explainZeliChartAction({
        chartId,
        period: filters.period,
        from: filters.from ?? undefined,
        to: filters.to ?? undefined,
        locationId: filters.locationId ?? undefined,
      });
      if (!result.success || !result.data) {
        setExplainError(result.error ?? "Zeli could not explain this chart.");
        return;
      }
      setExplanation({
        chartId,
        title: result.data.title,
        text: result.data.text,
        statements: result.data.statements,
        freshness: result.data.freshness,
      });
    } catch {
      setExplainError("Zeli could not explain this chart.");
    } finally {
      setExplaining(null);
    }
  }

  if (pending) {
    return (
      <div aria-busy="true">
        <SkeletonPage />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="zeli-analytics-dashboard">
      <header className="flex flex-col gap-4 rounded-2xl border border-brand-100 bg-white p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gold-600">
              Zeli Business Intelligence
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-brand-900">
              {snapshot.tenant.name}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {snapshot.period.label} · {snapshot.filters.locationName ?? "All branches"} ·{" "}
              {snapshot.tenant.code}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`badge ${
                snapshot.freshness.stale ? "badge-yellow" : "badge-green"
              }`}
              title={snapshot.freshness.warning ?? undefined}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  snapshot.freshness.stale ? "bg-amber-500" : "bg-emerald-600"
                }`}
                aria-hidden
              />
              {snapshot.freshness.stale ? "Stale data" : "Current aggregate"}
            </span>
            <button
              type="button"
              onClick={refresh}
              className="btn btn-secondary btn-sm"
              disabled={refreshing}
              data-testid="zeli-refresh"
            >
              {refreshing ? (
                <Loader2 size={14} className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw size={14} aria-hidden />
              )}
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <a href={exportHref} className="btn btn-primary btn-sm" data-testid="zeli-export">
              <Download size={14} aria-hidden /> Export CSV
            </a>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Reporting period">
            {PERIODS.map((period) => (
              <button
                key={period.value}
                type="button"
                onClick={() =>
                  navigate({
                    period: period.value,
                    ...(period.value !== "custom" ? { from: null, to: null } : {}),
                  })
                }
                aria-pressed={filters.period === period.value}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  filters.period === period.value
                    ? "border-brand-700 bg-brand-700 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-brand-300"
                }`}
              >
                {period.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            {filters.period === "custom" && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-slate-600">
                  From
                  <input
                    type="date"
                    className="mt-1 block"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  To
                  <input
                    type="date"
                    className="mt-1 block"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!customFrom || !customTo}
                  onClick={() =>
                    navigate({ period: "custom", from: customFrom, to: customTo })
                  }
                >
                  Apply range
                </button>
              </div>
            )}
            <label className="text-xs font-medium text-slate-600 sm:ml-auto">
              Branch
              <select
                className="mt-1 block min-w-48"
                value={filters.locationId ?? "all"}
                onChange={(event) =>
                  navigate({
                    location: event.target.value === "all" ? null : event.target.value,
                  })
                }
              >
                <option value="all">All branches</option>
                {snapshot.locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-slate-500">
            Last successful refresh: {formatDateTime(snapshot.freshness.refreshedAt)} · Auto-refresh
            interval {snapshot.freshness.ttlSeconds}s ·{" "}
            <span title={snapshot.freshness.source}>{snapshot.freshness.source}</span>
          </p>
          {snapshot.freshness.warning && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
              {snapshot.freshness.warning}
            </p>
          )}
          {refreshError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
              {refreshError}
            </p>
          )}
        </div>
      </header>

      <section aria-label="Key figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Contributions"
          value={money(snapshot.totals.contributions)}
          hint={`${snapshot.totals.contributionCount} records · ${snapshot.currency}`}
          tone="brand"
          icon={<Banknote aria-hidden />}
        />
        <StatCard
          label="Withdrawals (net)"
          value={money(snapshot.totals.withdrawals)}
          hint={`${snapshot.totals.withdrawalCount} completed records`}
          icon={<Wallet aria-hidden />}
        />
        <StatCard
          label="Net cash flow"
          value={money(snapshot.totals.netCashFlow)}
          hint="Contributions + cash income − withdrawals − expenses"
          tone={snapshot.totals.netCashFlow < 0 ? "negative" : "positive"}
          icon={<BarChart3 aria-hidden />}
        />
        <StatCard
          label="Open exceptions"
          value={String(snapshot.exceptions.total)}
          hint={`${snapshot.exceptions.pendingWithdrawals} withdrawals · ${snapshot.exceptions.remittanceDiscrepancies} remittance discrepancies`}
          tone={snapshot.exceptions.total > 0 ? "warning" : "default"}
          icon={<AlertTriangle aria-hidden />}
        />
        <StatCard
          label="Remittances"
          value={money(snapshot.totals.remittances)}
          hint={`Net variance ${money(snapshot.totals.remittanceVariance)}`}
        />
        <StatCard label="Expenses" value={money(snapshot.totals.expenses)} hint={`${snapshot.totals.expenseCount} expense records`} />
        <StatCard
          label="Active accounts"
          value={String(snapshot.totals.activeAccounts)}
          hint={`${snapshot.customer.activeAccounts} contributed in the period`}
        />
        <StatCard
          label="Transaction volume"
          value={String(snapshot.totals.transactionCount)}
          hint={`${snapshot.totals.newCustomers} new customers registered`}
        />
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Contributions", value: snapshot.comparison.contributionsPct },
          { label: "Withdrawals", value: snapshot.comparison.withdrawalsPct },
          { label: "Expenses", value: snapshot.comparison.expensesPct },
          { label: "Transaction volume", value: snapshot.comparison.transactionVolumePct },
        ].map((item) => (
          <div key={item.label} className="card !p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {item.label}
            </p>
            <div className="mt-1">
              <Change value={item.value} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-sm text-brand-900">
        <ShieldCheck size={18} className="mt-0.5 flex-none" aria-hidden />
        <p>
          <strong>Computed from your records.</strong> These figures are calculated by BloomCore One
          on the server from authorized financial records. Zeli&apos;s explanations are rule-based,
          not model-generated. External AI processing is disabled; no chart data leaves this
          application.
        </p>
      </div>

      <section aria-label="Financial and operational charts" className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard
            title="Contributions and withdrawals"
            description={`${snapshot.period.label} · daily UTC buckets`}
            chartId="contributions_vs_withdrawals"
            onExplain={explain}
            explaining={explaining}
            empty={snapshot.series.every((point) => point.contributions === 0 && point.withdrawals === 0)}
            emptyHint="No contributions or withdrawals were recorded for this period and branch."
            summary={`Contributions total ${money(snapshot.totals.contributions)}; withdrawals total ${money(snapshot.totals.withdrawals)}.`}
          >
            <AreaChart data={snapshot.series}>
              <defs>
                <linearGradient id="zeliContrib" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0E4D34" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#0E4D34" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
              <Tooltip formatter={(value: unknown) => money(Number(value ?? 0))} />
              <Legend />
              <Area
                type="monotone"
                dataKey="contributions"
                name="Contributions"
                stroke="#0E4D34"
                fill="url(#zeliContrib)"
              />
              <Line
                type="monotone"
                dataKey="withdrawals"
                name="Withdrawals"
                stroke="#C9A227"
                strokeWidth={2}
                dot={false}
              />
            </AreaChart>
          </ChartCard>

          <ChartCard
            title="Income versus expenses"
            description="Daily-account commission and other income against recorded expenses"
            chartId="income_vs_expenses"
            onExplain={explain}
            explaining={explaining}
            empty={snapshot.series.every((point) => point.income === 0 && point.expenses === 0)}
            emptyHint="No daily-account income or expenses were recorded."
            summary={`Cash income ${money(snapshot.totals.cashIncome)}; expenses ${money(snapshot.totals.expenses)}.`}
          >
            <BarChart data={snapshot.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
              <Tooltip formatter={(value: unknown) => money(Number(value ?? 0))} />
              <Legend />
              <Bar dataKey="income" name="Income" fill="#0E4D34" radius={[3, 3, 0, 0]} />
              <Bar dataKey="expenses" name="Expenses" fill="#C9A227" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard
            title="Net cash-flow trend"
            description="Contributions + cash income − withdrawals − expenses"
            chartId="net_cash_flow"
            onExplain={explain}
            explaining={explaining}
            empty={snapshot.series.every((point) => point.netCashFlow === 0)}
            emptyHint="No net cash movement was recorded."
            summary={`Net cash flow for the period is ${money(snapshot.totals.netCashFlow)}.`}
          >
            <LineChart data={snapshot.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={56} />
              <Tooltip formatter={(value: unknown) => money(Number(value ?? 0))} />
              <Line
                type="monotone"
                dataKey="netCashFlow"
                name="Net cash flow"
                stroke="#0E4D34"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartCard>

          <ChartCard
            title="Remittance trend"
            description="Active remittances; reversed records are excluded"
            chartId="remittances"
            onExplain={explain}
            explaining={explaining}
            empty={snapshot.series.every((point) => point.remittances === 0)}
            emptyHint="No remittances were recorded for this period."
            summary={`Remittances total ${money(snapshot.totals.remittances)} with net variance ${money(snapshot.totals.remittanceVariance)}.`}
          >
            <AreaChart data={snapshot.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
              <Tooltip formatter={(value: unknown) => money(Number(value ?? 0))} />
              <Area
                type="monotone"
                dataKey="remittances"
                name="Remittances"
                stroke="#C9A227"
                fill="#C9A227"
                fillOpacity={0.18}
              />
            </AreaChart>
          </ChartCard>

          <ChartCard
            title="Daily transaction activity"
            description="Contributions, withdrawals and remittances per day"
            chartId="transaction_volume"
            onExplain={explain}
            explaining={explaining}
            empty={snapshot.series.every((point) => point.transactionCount === 0)}
            emptyHint="No transactions were recorded."
            summary={`${snapshot.totals.transactionCount} transactions were recorded in the period.`}
          >
            <BarChart data={snapshot.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tick={{ fontSize: 11 }} width={40} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="transactionCount" name="Transactions" fill="#0E4D34" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard
            title="Branch performance"
            description="Contributions by recording location for the selected period"
            chartId="branch_performance"
            onExplain={explain}
            explaining={explaining}
            empty={snapshot.branchPerformance.length === 0}
            emptyHint="No active branch has financial activity in this period."
            summary={`${snapshot.branchPerformance.length} branches compared by contributions.`}
          >
            <BarChart data={snapshot.branchPerformance} layout="vertical" margin={{ left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis type="number" tickFormatter={compact} tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="locationName"
                width={110}
                tick={{ fontSize: 11 }}
              />
              <Tooltip formatter={(value: unknown) => money(Number(value ?? 0))} />
              <Bar dataKey="contributions" name="Contributions" fill="#0E4D34" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard
            title="Customer activity"
            description="New registrations versus accounts that contributed"
            chartId="customer_activity"
            onExplain={explain}
            explaining={explaining}
            empty={snapshot.series.every((point) => point.newCustomers === 0 && point.activeAccounts === 0)}
            emptyHint="No customer or contribution activity in this period."
            summary={`${snapshot.customer.newCustomers} new customers and ${snapshot.customer.activeAccounts} contributing accounts.`}
          >
            <LineChart data={snapshot.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tick={{ fontSize: 11 }} width={40} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="newCustomers" name="New customers" stroke="#C9A227" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="activeAccounts" name="Active accounts" stroke="#0E4D34" strokeWidth={2} dot={false} />
            </LineChart>
          </ChartCard>
        </div>
      </section>

      {explainError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {explainError}
        </p>
      )}

      {explanation && (
        <section
          className="card border-brand-200 bg-white"
          aria-label="Zeli chart explanation"
          data-testid="zeli-explanation"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gold-600">
                Zeli explanation · rule-based
              </p>
              <h2 className="mt-1 font-semibold text-brand-900">{explanation.title}</h2>
              {explanation.freshness && (
                <p className="mt-1 text-xs text-slate-500">{explanation.freshness}</p>
              )}
            </div>
            <button
              type="button"
              className="rounded p-1 text-slate-400 hover:text-slate-700"
              onClick={() => setExplanation(null)}
              aria-label="Close explanation"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="mt-3 space-y-3">
            {explanation.statements.map((item, index) => (
              <div key={`${item.kind}-${index}`} className="flex gap-2 text-sm">
                <span
                  className={`mt-0.5 flex-none rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    item.kind === "calculated_fact"
                      ? "bg-brand-100 text-brand-800"
                      : item.kind === "detected_pattern"
                        ? "bg-gold-100 text-gold-800"
                        : item.kind === "suggested_action"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {item.label}
                </span>
                <p className="text-slate-700">{item.text}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="card bg-white">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold text-brand-900">Detected patterns</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Rule-based observations with their calculation and source. Not model reasoning.
              </p>
            </div>
            <span className="badge badge-gray">{insights.length}</span>
          </div>
          {insights.length === 0 ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center">
              <CheckCircle2 className="mx-auto text-emerald-600" size={22} aria-hidden />
              <p className="mt-2 text-sm font-medium text-slate-700">
                No rule-based anomaly crossed its threshold
              </p>
              <p className="mt-1 text-xs text-slate-500">
                This does not prove the records are complete. Review the underlying reports.
              </p>
            </div>
          ) : (
            <ul className="mt-3 space-y-3">
              {insights.map((insight) => (
                <li
                  key={insight.id}
                  className={`rounded-xl border px-4 py-3 ${SEVERITY_STYLE[insight.severity]}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide">
                      {insight.severity}
                    </span>
                    <span className="text-xs opacity-70">{insight.category.replace("_", " ")}</span>
                  </div>
                  <h3 className="mt-1 text-sm font-semibold">{insight.title}</h3>
                  <p className="mt-1 text-sm">{insight.detail}</p>
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer font-medium">Calculation and source</summary>
                    <p className="mt-1">{insight.calculation}</p>
                    <p className="mt-1">Source: {insight.source}</p>
                    <p className="mt-1">Freshness: {insight.freshness}</p>
                    <p className="mt-1">Confidence: {insight.confidence}</p>
                    <p className="mt-1">Limitations: {insight.limitations.join(" ")}</p>
                    {insight.evidence.length > 0 && (
                      <ul className="mt-1 list-disc pl-4">
                        {insight.evidence.map((item) => (
                          <li key={item.label}>
                            {item.label}: {item.value}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="space-y-4">
          <div className="card bg-white">
            <h2 className="flex items-center gap-2 font-semibold text-brand-900">
              <Info size={16} aria-hidden /> Recommendations
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Safe, read-only next steps. Zeli never posts, approves or reverses money.
            </p>
            {recommendations.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No recommendation crossed its threshold for this period.
              </p>
            ) : (
              <ol className="mt-3 space-y-2 text-sm">
                {recommendations.map((recommendation) => (
                  <li key={recommendation.id} className="rounded-lg border border-slate-200 p-2.5">
                    <p className="font-medium text-slate-800">{recommendation.title}</p>
                    <p className="mt-1 text-slate-600">{recommendation.action}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="card bg-white">
            <h2 className="flex items-center gap-2 font-semibold text-brand-900">
              <Sparkles size={16} aria-hidden /> Ask Zeli
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Continue in the conversational workspace. It uses the same server-computed figures.
            </p>
            <Link href="/zeli" className="btn btn-secondary btn-sm mt-3 inline-flex">
              Open Zeli Assistant
            </Link>
          </div>

          <div className="card bg-white text-xs text-slate-500">
            <h2 className="text-sm font-semibold text-slate-800">How these figures are calculated</h2>
            <ul className="mt-2 space-y-1.5">
              <li>{snapshot.reconciliation.contributionSource}.</li>
              <li>{snapshot.reconciliation.withdrawalSource}.</li>
              <li>{snapshot.reconciliation.remittanceSource}.</li>
              <li>{snapshot.reconciliation.expenseSource}.</li>
            </ul>
            <p className="mt-2">{snapshot.reconciliation.note}</p>
          </div>
        </aside>
      </section>
    </div>
  );
}

function ChartCard({
  title,
  description,
  chartId,
  onExplain,
  explaining,
  empty,
  emptyHint,
  summary,
  children,
}: {
  title: string;
  description: string;
  chartId: ExplainableChartId;
  onExplain: (chartId: ExplainableChartId) => void;
  explaining: ExplainableChartId | null;
  empty: boolean;
  emptyHint: string;
  summary: string;
  children: React.ReactElement;
}) {
  return (
    <section className="card bg-white" aria-label={title}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold text-brand-900">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => onExplain(chartId)}
          className="btn btn-secondary btn-sm flex-none"
          disabled={explaining === chartId}
          aria-label={`Explain ${title} with Zeli`}
        >
          {explaining === chartId ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <Sparkles size={13} aria-hidden />
          )}
          Explain
        </button>
      </div>
      {empty ? (
        <div className="mt-4 flex h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 text-center">
          <BarChart3 className="text-slate-300" size={24} aria-hidden />
          <p className="mt-2 text-sm font-medium text-slate-600">No data for this period</p>
          <p className="mt-1 max-w-xs text-xs text-slate-500">{emptyHint}</p>
        </div>
      ) : (
        <>
          <p className="sr-only">{summary}</p>
          <div className="mt-4 h-64 w-full" role="img" aria-label={summary}>
            <ResponsiveContainer width="100%" height="100%">
              {children}
            </ResponsiveContainer>
          </div>
        </>
      )}
    </section>
  );
}
