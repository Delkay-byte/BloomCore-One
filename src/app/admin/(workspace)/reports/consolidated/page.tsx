"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, RefreshCw } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { StatCard } from "@/components/ui/DataDisplay";
import { METRIC_KIND_LABELS, type MetricKind } from "@/lib/reporting/dictionary";
import {
  exportConsolidatedCsv,
  getConsolidatedReport,
  type ConsolidatedReport,
} from "@/lib/actions/reporting.actions";

/**
 * Consolidated MoMo report.
 *
 * Deliberately three blocks rather than one number: what money is where, what
 * moved and what was earned, and what is missing. Each figure carries its own
 * definition so a position is never read as income.
 */
function today(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
    .toISOString()
    .slice(0, 10);
}

function money(value: number): string {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    minimumFractionDigits: 2,
  }).format(value);
}

export default function ConsolidatedReportPage() {
  const [report, setReport] = useState<ConsolidatedReport | null>(null);
  const [range, setRange] = useState({ from: today(29), to: today(0) });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async (period: { from: string; to: string }) => {
    setLoading(true);
    setError("");
    try {
      const result = await getConsolidatedReport(period);
      if (!result.success || !result.data) {
        setError(result.error ?? "The report could not be built.");
        return;
      }
      setReport(result.data);
    } catch {
      setError("The report could not be built.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  async function download() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await exportConsolidatedCsv(range);
      if (!result.success || !result.data) {
        setError(result.error ?? "The export could not be built.");
        return;
      }
      const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.filename;
      link.click();
      URL.revokeObjectURL(url);
      setSuccess("The CSV was built from the same figures shown on this screen.");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = new Map((report?.branches ?? []).map((row) => [row.id, row.name]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Consolidated MoMo report</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Cash and float positions, settled transfers, the operating result and the
            closes that are missing — in one place, each with its own definition.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-semibold text-slate-700">
            From
            <input
              type="date"
              className="input ml-1 py-1 text-xs"
              value={range.from}
              onChange={(event) => setRange({ ...range, from: event.target.value })}
            />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            To
            <input
              type="date"
              className="input ml-1 py-1 text-xs"
              value={range.to}
              onChange={(event) => setRange({ ...range, to: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void load(range)}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void download()} disabled={busy}>
            <Download className="h-4 w-4" aria-hidden /> Export CSV
          </button>
        </div>
      </div>

      {error ? <Notice type="error">{error}</Notice> : null}
      {success ? <Notice type="success">{success}</Notice> : null}

      {report ? (
        <>
          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Declared cash" value={money(report.position.totals.declaredCash)} />
            <StatCard label="Declared float" value={money(report.position.totals.declaredFloat)} />
            <StatCard
              label="Transfers in / out"
              value={`${money(report.position.totals.transfersIn)} / ${money(report.position.totals.transfersOut)}`}
            />
            <StatCard
              label="Net operating result"
              value={money(report.flow.netOperating)}
              tone={report.flow.netOperating < 0 ? "warning" : undefined}
            />
          </section>

          <section className="card overflow-hidden">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Branch position</h2>
              <p className="text-xs text-slate-500">
                A declaration is a position and a transfer is a movement. They are shown
                side by side, never added together.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Declared cash</th>
                    <th>Declared float</th>
                    <th>Transfers in</th>
                    <th>Transfers out</th>
                    <th>Last close cash</th>
                    <th>Cash variance</th>
                    <th>Float variance</th>
                    <th>Declaration age</th>
                  </tr>
                </thead>
                <tbody>
                  {report.position.branches.map((branch) => (
                    <tr key={branch.locationId} data-testid={`position-${branch.locationId}`}>
                      <td className="text-xs font-medium">
                        {nameOf.get(branch.locationId) ?? branch.locationId}
                      </td>
                      <td className="text-xs tnum">{money(branch.declaredCash)}</td>
                      <td className="text-xs tnum">
                        {money(branch.declaredFloat)}
                        {Object.keys(branch.declaredFloatByNetwork).length > 1 ? (
                          <span className="block text-slate-400">
                            {Object.entries(branch.declaredFloatByNetwork)
                              .map(([key, value]) => `${key.replace(/_/g, " ")} ${money(value)}`)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-xs tnum">{money(branch.transfersIn)}</td>
                      <td className="text-xs tnum">{money(branch.transfersOut)}</td>
                      <td className="text-xs tnum">{money(branch.closingCashReported)}</td>
                      <td className="text-xs tnum">{money(branch.cashVariance)}</td>
                      <td className="text-xs tnum">{money(branch.floatVariance)}</td>
                      <td className="text-xs">
                        {branch.declarationAgeDays === null ? (
                          <span className="text-amber-700">never declared</span>
                        ) : branch.declarationAgeDays > report.staleDeclarationDays ? (
                          <span className="text-amber-700">{branch.declarationAgeDays} days (stale)</span>
                        ) : (
                          `${branch.declarationAgeDays} days`
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Flow and result</h2>
              <p className="text-xs text-slate-500">{report.note}</p>
            </div>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Figure</th>
                    <th>Kind</th>
                    <th>Value</th>
                    <th>How it is calculated</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["principal_in", report.flow.principalIn],
                    ["principal_out", report.flow.principalOut],
                    ["commission", report.flow.commission],
                    ["other_income", report.flow.otherIncome],
                    ["debts_collected", report.flow.debtsCollected],
                    ["expenses", report.flow.expenses],
                    ["net_operating", report.flow.netOperating],
                  ].map(([key, value]) => {
                    const definition = report.dictionary.find((row) => row.key === key);
                    return (
                      <tr key={String(key)}>
                        <td className="text-xs font-medium">{definition?.label ?? String(key)}</td>
                        <td className="text-xs">
                          {definition
                            ? METRIC_KIND_LABELS[definition.kind as MetricKind]
                            : "—"}
                        </td>
                        <td className="text-xs tnum">{money(Number(value))}</td>
                        <td className="text-xs text-slate-500">{definition?.formula}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">What is missing</h2>
              <p className="text-xs text-slate-500">
                {report.completeness.totals.submittedDays} of{" "}
                {report.completeness.totals.expectedDays} expected branch days have a
                submitted close ({report.completeness.totals.coveragePct}%).
              </p>
            </div>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Expected</th>
                    <th>Submitted</th>
                    <th>Missing days</th>
                    <th>Late closes</th>
                    <th>Operators without a close</th>
                    <th>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {report.completeness.branches.map((branch) => (
                    <tr key={branch.locationId}>
                      <td className="text-xs font-medium">{branch.locationName}</td>
                      <td className="text-xs tnum">{branch.expectedDays}</td>
                      <td className="text-xs tnum">{branch.submittedDays}</td>
                      <td className="text-xs">
                        {branch.missingDays.length}
                        {branch.missingDays.length > 0 ? (
                          <span className="block text-slate-400">
                            {branch.missingDays.slice(0, 4).join(", ")}
                            {branch.missingDays.length > 4 ? "…" : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-xs tnum">{branch.lateDays}</td>
                      <td className="text-xs tnum">{branch.operatorsWithoutClose}</td>
                      <td className="text-xs tnum">{branch.coveragePct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.completeness.operatorsWithoutClose.length > 0 ? (
              <p className="px-4 py-2 text-xs text-slate-600">
                No close in this period:{" "}
                {report.completeness.operatorsWithoutClose.map((row) => row.fullName).join(", ")}
              </p>
            ) : null}
          </section>

          <details className="card p-4">
            <summary className="cursor-pointer text-sm font-bold text-slate-900">
              Metric dictionary ({report.dictionary.length} figures)
            </summary>
            <ul className="mt-3 space-y-2 text-xs text-slate-600">
              {report.dictionary.map((metric) => (
                <li key={metric.key}>
                  <span className="font-semibold text-slate-900">{metric.label}</span>{" "}
                  <span className="text-slate-400">({metric.kind.replace(/_/g, " ")})</span>
                  <div>{metric.formula}</div>
                  <div className="text-slate-400">Excludes: {metric.excludes}</div>
                </li>
              ))}
            </ul>
          </details>

          <p className="flex items-start gap-2 text-xs text-slate-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
            {report.position.notes.join(" ")} {report.completeness.notes.join(" ")}
          </p>
        </>
      ) : (
        <p className="text-sm text-slate-500">
          {loading ? "Building the report…" : "No report is available."}
        </p>
      )}
    </div>
  );
}
