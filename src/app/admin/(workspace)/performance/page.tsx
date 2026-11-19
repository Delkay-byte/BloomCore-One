"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Download,
  Printer,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import { StatCard } from "@/components/ui/DataDisplay";
import {
  getPerformanceReport,
  type PerformanceReportResponse,
} from "@/lib/actions/performance.actions";
import type { PerformanceDelta } from "@/lib/performance-report";
import { buildCsv } from "@/lib/csv";

type Preset = "last7" | "last30" | "this_month" | "last_month" | "custom";

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  if (preset === "last7") {
    return { from: iso(new Date(today.getTime() - 6 * 86_400_000)), to: iso(today) };
  }
  if (preset === "last30") {
    return { from: iso(new Date(today.getTime() - 29 * 86_400_000)), to: iso(today) };
  }
  if (preset === "this_month") {
    return {
      from: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))),
      to: iso(today),
    };
  }
  if (preset === "last_month") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { from: iso(start), to: iso(end) };
  }
  return { from: iso(new Date(today.getTime() - 29 * 86_400_000)), to: iso(today) };
}

function fmtDay(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

const DELTA_LABEL: Record<PerformanceDelta["metric"], string> = {
  revenue: "Operating revenue",
  expenses: "Expenses",
  netOperating: "Net operating",
  cashIn: "Cash in (principal)",
  cashOut: "Cash out (principal)",
};

export default function AdminPerformancePage() {
  const [preset, setPreset] = useState<Preset>("last30");
  const [range, setRange] = useState(presetRange("last30"));
  const [locationId, setLocationId] = useState("");
  const [data, setData] = useState<PerformanceReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(
        await getPerformanceReport({
          from: range.from,
          to: range.to,
          locationId: locationId || undefined,
        })
      );
    } catch {
      setError("The performance report could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [range, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  function choosePreset(next: Preset) {
    setPreset(next);
    if (next !== "custom") setRange(presetRange(next));
  }

  const maxDaily = data
    ? Math.max(
        1,
        ...data.current.byDay.map((day) => Math.max(day.revenue, day.expenses))
      )
    : 1;

  function exportCsv() {
    if (!data) return;
    const report = data.current;
    const rows: string[][] = [
      ["Period", `${report.period.from} to ${report.period.to}`],
      ["Basis", report.source.financial],
      [],
      ["Location", "Operating revenue", "Expenses", "Net operating", "Debts collected", "Cash in", "Cash out", "Submitted days", "Draft days", "Shortage days", "Ledger-backed days", "Aggregate days"],
      ...report.byLocation.map((row) => [
        row.locationName,
        row.revenue.toFixed(2),
        row.expenses.toFixed(2),
        row.netOperating.toFixed(2),
        row.debtsCollected.toFixed(2),
        row.cashIn.toFixed(2),
        row.cashOut.toFixed(2),
        String(row.submittedDays),
        String(row.draftDays),
        String(row.shortageDays),
        String(row.ledgerDays),
        String(row.aggregateDays),
      ]),
      [],
      ["Day", "Operating revenue", "Expenses", "Net operating", "Cash in", "Cash out"],
      ...report.byDay.map((row) => [
        row.date,
        row.revenue.toFixed(2),
        row.expenses.toFixed(2),
        row.netOperating.toFixed(2),
        row.cashIn.toFixed(2),
        row.cashOut.toFixed(2),
      ]),
      [],
      ["Note", "Draft accounts are excluded from confirmed figures."],
    ];
    const csv = buildCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `maacash-performance-${report.period.from}-to-${report.period.to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Business performance</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Revenue, costs and money movement by branch and by day, with the
            previous period shown alongside so a movement can be judged rather
            than guessed.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <button type="button" onClick={() => void load()} className="btn btn-secondary">
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="btn btn-secondary"
            disabled={!data}
          >
            <Download className="h-4 w-4" aria-hidden /> Export CSV
          </button>
          <button type="button" onClick={() => window.print()} className="btn btn-secondary">
            <Printer className="h-4 w-4" aria-hidden /> Print
          </button>
        </div>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      <section className="card p-4 print:hidden">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs font-medium text-slate-600">
            Period
            <select
              value={preset}
              onChange={(event) => choosePreset(event.target.value as Preset)}
              className="input mt-1 w-full"
            >
              <option value="last7">Last 7 days</option>
              <option value="last30">Last 30 days</option>
              <option value="this_month">This month</option>
              <option value="last_month">Last month</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            From
            <input
              type="date"
              value={range.from}
              onChange={(event) => {
                setPreset("custom");
                setRange((current) => ({ ...current, from: event.target.value }));
              }}
              className="input mt-1 w-full"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            To
            <input
              type="date"
              value={range.to}
              onChange={(event) => {
                setPreset("custom");
                setRange((current) => ({ ...current, to: event.target.value }));
              }}
              className="input mt-1 w-full"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Branch
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className="input mt-1 w-full"
            >
              <option value="">All branches</option>
              {data?.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button type="button" onClick={() => void load()} className="btn btn-primary w-full">
              Apply
            </button>
          </div>
        </div>
      </section>

      {loading && !data ? (
        <p className="text-sm text-slate-500">Building the performance report…</p>
      ) : data ? (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <p>
              <strong>Basis:</strong> {data.current.source.financial}. Principal
              cash-in, cash-out and airtime are shown as volume. Draft accounts
              and ledger-only entries are disclosed separately and never added to
              the confirmed figures.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer font-semibold text-slate-700">
                How each metric is defined
              </summary>
              <dl className="mt-2 space-y-1">
                <div>
                  <dt className="inline font-semibold">Operating revenue: </dt>
                  <dd className="inline">{data.current.source.definitions.revenue}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Expenses: </dt>
                  <dd className="inline">{data.current.source.definitions.expenses}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Net operating: </dt>
                  <dd className="inline">{data.current.source.definitions.netOperating}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Cash movement: </dt>
                  <dd className="inline">{data.current.source.definitions.cashMovement}</dd>
                </div>
              </dl>
            </details>
          </div>

          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Operating revenue"
              value={<CediAmount amount={data.current.totals.revenue} />}
              hint="Commission + other income; excludes debt recovery and principal"
              tone="positive"
              icon={<TrendingUp />}
            />
            <StatCard
              label="Expenses"
              value={<CediAmount amount={data.current.totals.expenses} />}
              tone="negative"
            />
            <StatCard
              label="Net operating"
              value={<CediAmount amount={data.current.totals.netOperating} />}
              hint="Operating revenue − expenses"
              tone={data.current.totals.netOperating >= 0 ? "positive" : "negative"}
            />
            <StatCard
              label="Cash movement"
              value={
                <span className="text-base">
                  <CediAmount amount={data.current.totals.cashIn} /> in /{" "}
                  <CediAmount amount={data.current.totals.cashOut} /> out
                </span>
              }
              hint="Principal volume, not income"
              icon={<Activity />}
            />
            <StatCard
              label="Ledger-backed days"
              value={data.current.totals.ledgerDays}
              hint="Closed from individual transaction rows"
            />
            <StatCard
              label="Aggregate days"
              value={data.current.totals.aggregateDays}
              hint="Operator-declared totals; no transaction-level proof"
              tone={data.current.totals.aggregateDays > 0 ? "warning" : "positive"}
            />
          </section>

          <section className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900">Against the previous period</h2>
              <p className="text-xs text-slate-500">
                {data.previous.period.from} to {data.previous.period.to}
              </p>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {data.comparison.map((delta) => (
                <div key={delta.metric} className="rounded-lg border border-slate-200 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">
                    {DELTA_LABEL[delta.metric]}
                  </p>
                  <p className="mt-1 text-sm font-bold text-slate-900 tnum">
                    <CediAmount amount={delta.current} />
                  </p>
                  <p
                    className={`mt-0.5 flex items-center gap-1 text-xs ${
                      delta.change === 0
                        ? "text-slate-500"
                        : delta.change > 0
                          ? "text-emerald-700"
                          : "text-red-700"
                    }`}
                  >
                    {delta.change > 0 ? (
                      <ArrowUpRight className="h-3 w-3" aria-hidden />
                    ) : delta.change < 0 ? (
                      <ArrowDownRight className="h-3 w-3" aria-hidden />
                    ) : null}
                    {delta.changePercent === null
                      ? "New this period"
                      : `${delta.changePercent > 0 ? "+" : ""}${delta.changePercent}%`}
                    <span className="text-slate-400">
                      vs <CediAmount amount={delta.previous} />
                    </span>
                  </p>
                </div>
              ))}
            </div>
          </section>

          {(data.current.drafts.days > 0 ||
            data.current.completeness.locationDaysWithoutAccount > 0 ||
            data.current.completeness.ledgerOnlyTransactions > 0 ||
            data.current.totals.unreviewedDays > 0) && (
            <Notice type="warning" popup={false}>
              <span className="block font-semibold">Not everything is confirmed yet</span>
              {data.current.drafts.days > 0 && (
                <span className="block">
                  {data.current.drafts.days} draft account
                  {data.current.drafts.days === 1 ? "" : "s"} excluded from revenue and
                  expenses ({data.current.drafts.days} day
                  {data.current.drafts.days === 1 ? "" : "s"}).
                </span>
              )}
              {data.current.totals.unreviewedDays > 0 && (
                <span className="block">
                  {data.current.totals.unreviewedDays} submitted account
                  {data.current.totals.unreviewedDays === 1 ? " is" : "s are"} not yet
                  reviewed.
                </span>
              )}
              {data.current.completeness.ledgerOnlyTransactions > 0 && (
                <span className="block">
                  {data.current.completeness.ledgerOnlyTransactions} ledger entr
                  {data.current.completeness.ledgerOnlyTransactions === 1 ? "y is" : "ies are"}{" "}
                  not linked to a daily account; they appear in activity counts only.
                </span>
              )}
              {data.current.completeness.locationDaysWithoutAccount > 0 && (
                <span className="block">
                  {data.current.completeness.locationDaysWithoutAccount} location-day
                  {data.current.completeness.locationDaysWithoutAccount === 1 ? "" : "s"} in
                  this period have no account at all. Closed days are included in this
                  count, so treat it as a completeness prompt, not a loss figure.
                </span>
              )}
            </Notice>
          )}

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Branch performance</h2>
              <p className="text-xs text-slate-500">
                Confirmed accounts only · {data.current.period.days} day
                {data.current.period.days === 1 ? "" : "s"}
              </p>
            </div>
            {data.current.byLocation.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                No active branches match this filter.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Branch</th>
                      <th className="px-4 py-2 text-right">Operating revenue</th>
                      <th className="px-4 py-2 text-right">Expenses</th>
                      <th className="px-4 py-2 text-right">Net</th>
                      <th className="px-4 py-2 text-right">Debts collected</th>
                      <th className="px-4 py-2 text-right">Cash in</th>
                      <th className="px-4 py-2 text-right">Cash out</th>
                      <th className="px-4 py-2 text-right">Confirmed days</th>
                      <th className="px-4 py-2 text-right">Draft days</th>
                      <th className="px-4 py-2 text-right">Shortage days</th>
                      <th className="px-4 py-2 text-right">Ledger days</th>
                      <th className="px-4 py-2 text-right">Aggregate days</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.current.byLocation.map((row) => (
                      <tr key={row.locationId}>
                        <td className="px-4 py-2 font-medium text-slate-800">
                          {row.locationName}
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={row.revenue} />
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={row.expenses} />
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-semibold tnum ${
                            row.netOperating >= 0 ? "text-emerald-700" : "text-red-700"
                          }`}
                        >
                          <CediAmount amount={row.netOperating} />
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={row.debtsCollected} />
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={row.cashIn} />
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={row.cashOut} />
                        </td>
                        <td className="px-4 py-2 text-right tnum">{row.submittedDays}</td>
                        <td className="px-4 py-2 text-right tnum">{row.draftDays}</td>
                        <td className="px-4 py-2 text-right tnum">{row.shortageDays}</td>
                        <td className="px-4 py-2 text-right tnum">{row.ledgerDays}</td>
                        <td className="px-4 py-2 text-right tnum">{row.aggregateDays}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-slate-200 bg-slate-50 text-sm font-semibold">
                    <tr>
                      <td className="px-4 py-2">All branches</td>
                      <td className="px-4 py-2 text-right tnum">
                        <CediAmount amount={data.current.totals.revenue} />
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        <CediAmount amount={data.current.totals.expenses} />
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        <CediAmount amount={data.current.totals.netOperating} />
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        <CediAmount amount={data.current.totals.debtsCollected} />
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        <CediAmount amount={data.current.totals.cashIn} />
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        <CediAmount amount={data.current.totals.cashOut} />
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        {data.current.totals.submittedDays}
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        {data.current.totals.draftDays}
                      </td>
                      <td className="px-4 py-2 text-right tnum">
                        {data.current.totals.shortageDays}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          <section className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900">Daily trend</h2>
              <p className="text-xs text-slate-500">
                Green = operating revenue, red = expenses. Bars scale to the highest day.
              </p>
            </div>
            {data.current.byDay.every(
              (day) => day.revenue === 0 && day.expenses === 0
            ) ? (
              <p className="mt-3 text-sm text-slate-500">
                No confirmed daily figures in this period yet.
              </p>
            ) : (
              <div className="mt-3 space-y-1.5">
                {data.current.byDay.map((day) => (
                  <div key={day.date} className="grid grid-cols-[4rem_1fr] items-center gap-2">
                    <span className="text-[11px] text-slate-500">{fmtDay(day.date)}</span>
                    <div className="space-y-0.5">
                      <div className="h-2 rounded bg-slate-100">
                        <div
                          className="h-2 rounded bg-emerald-500"
                          style={{ width: `${Math.min(100, (day.revenue / maxDaily) * 100)}%` }}
                          title={`Operating revenue ${day.revenue.toFixed(2)}`}
                        />
                      </div>
                      <div className="h-1 rounded bg-slate-100">
                        <div
                          className="h-1 rounded bg-red-400"
                          style={{ width: `${Math.min(100, (day.expenses / maxDaily) * 100)}%` }}
                          title={`Expenses ${day.expenses.toFixed(2)}`}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-bold text-slate-900">Operating context</h2>
            <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Context label="Recorded ledger entries" value={String(data.current.totals.transactionCount)} />
              <Context
                label="Airtime sold"
                value={`GH₵${data.current.totals.airtimeSold.toFixed(2)}`}
              />
              <Context
                label="Net reconciliation variance"
                value={`GH₵${data.current.totals.netVariance.toFixed(2)}`}
              />
              <Context
                label="Transfers completed"
                value={`${data.current.completeness.completedTransfers} · GH₵${data.current.completeness.completedTransferAmount.toFixed(2)}`}
              />
              <Context
                label="Transfers still open"
                value={`${data.current.completeness.openTransfers} · GH₵${data.current.completeness.openTransferAmount.toFixed(2)}`}
              />
              <Context label="Shifts recorded" value={String(data.current.completeness.shifts)} />
              <Context
                label="Shift handover variances"
                value={`${data.current.completeness.shiftVariances} · GH₵${data.current.completeness.shiftVarianceAmount.toFixed(2)}`}
              />
              <Context
                label="Basis"
                value={`${data.current.period.days} days · ${data.current.completeness.activeLocations} branches`}
              />
            </dl>
            <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
              {data.current.source.operational}. Operating revenue and expenses
              are taken once from the daily account, so a ledger transaction cannot
              increase reported revenue a second time.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Context({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-semibold text-slate-900">{value}</dd>
    </div>
  );
}
