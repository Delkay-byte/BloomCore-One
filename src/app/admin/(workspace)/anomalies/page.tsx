"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
} from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import AnomalyInvestigationPanel from "@/components/AnomalyInvestigationPanel";
import EvidenceProvenancePanel from "@/components/EvidenceProvenancePanel";
import { getStaff } from "@/lib/actions/staff.actions";
import { StatCard } from "@/components/ui/DataDisplay";
import {
  acknowledgeAnomaly,
  getAnomalyBoard,
  resolveAnomaly,
  runAnomalyScan,
  type AnomalyBoard,
} from "@/lib/actions/anomaly.actions";
import {
  getZeliAnomalyBriefing,
  type ZeliAnomalyBriefingResponse,
} from "@/lib/actions/zeli-anomaly.actions";
import type { AnomalyTriageBriefing } from "@/lib/zeli/anomaly-detection";

type ScanResult = {
  scanned: number;
  created: number;
  updated: number;
  high: number;
  medium: number;
  low: number;
};

const SEVERITY_CLASSES: Record<string, string> = {
  high: "border-red-200 bg-red-50 text-red-800",
  medium: "border-amber-200 bg-amber-50 text-amber-900",
  low: "border-slate-200 bg-slate-50 text-slate-700",
};

const STATUS_CLASSES: Record<string, string> = {
  open: "badge-yellow",
  acknowledged: "badge-blue",
  resolved: "badge-green",
};

const BAND_CLASSES: Record<string, string> = {
  high: "border-red-200 bg-red-50 text-red-800",
  elevated: "border-amber-200 bg-amber-50 text-amber-900",
  low: "border-slate-200 bg-slate-50 text-slate-700",
};

function fmt(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function entityHref(type: string, id: string): string | null {
  if (type === "dailyAccount") return `/admin/reports/${id}`;
  if (type === "branchTransfer") return `/admin/transfers/${id}`;
  if (type === "momoTransaction") return "/admin/ledger";
  if (type === "user") return "/admin/workers";
  if (type === "location") return "/admin/locations";
  if (type === "shiftHandover") return "/admin/shifts";
  return null;
}

const MONEY_RULES = new Set([
  "daily_shortage",
  "daily_overage",
  "large_transaction",
  "expense_spike",
  "transfer_variance",
  "shift_variance",
]);

function last30(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

export default function AdminAnomaliesPage() {
  const [board, setBoard] = useState<AnomalyBoard | null>(null);
  const [briefing, setBriefing] = useState<AnomalyTriageBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [range, setRange] = useState(last30());
  const [filters, setFilters] = useState({
    status: "all",
    severity: "all",
    ruleKey: "all",
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [staff, setStaff] = useState<Array<{ id: string; fullName: string }>>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextBoard, nextBriefing, nextStaff] = await Promise.all([
        getAnomalyBoard(filters),
        getZeliAnomalyBriefing() as Promise<ZeliAnomalyBriefingResponse>,
        getStaff().catch(() => [] as Array<{ id: string; fullName: string }>),
      ]);
      setBoard(nextBoard);
      setBriefing(nextBriefing.success ? nextBriefing.data ?? null : null);
      setStaff(
        (nextStaff as Array<{ id: string; fullName: string }>).map((person) => ({
          id: person.id,
          fullName: person.fullName,
        }))
      );
    } catch {
      setError("The anomaly monitor could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  async function scan() {
    setScanning(true);
    setError("");
    setSuccess("");
    try {
      const result = await runAnomalyScan(range);
      if (!result.success) {
        setError(result.error ?? "The scan could not be completed.");
        return;
      }
      setLastScan(result.data as ScanResult);
      setSuccess("Scan completed. Findings below reflect the current records.");
      await load();
    } catch {
      setError("The scan could not be completed.");
    } finally {
      setScanning(false);
    }
  }

  async function acknowledge(id: string) {
    setBusyId(id);
    setError("");
    setSuccess("");
    const result = await acknowledgeAnomaly({ id, note: notes[id] ?? "" });
    if (!result.success) {
      setError(result.error ?? "The finding could not be acknowledged.");
    } else {
      setSuccess("Finding acknowledged. It remains visible until resolved.");
      await load();
    }
    setBusyId(null);
  }

  async function resolve(id: string) {
    setBusyId(id);
    setError("");
    setSuccess("");
    const result = await resolveAnomaly({ id, note: notes[id] ?? "" });
    if (!result.success) {
      setError(result.error ?? "The finding could not be resolved.");
    } else {
      setSuccess("Finding resolved with the recorded explanation.");
      await load();
    }
    setBusyId(null);
  }

  const rules = new Map((board?.rules ?? []).map((row) => [row.key, row]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Anomaly monitoring</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Every finding comes from a named rule with a fixed threshold. There is
            no scoring model and no AI guess: the same records always produce the
            same findings, and each one points at the record that caused it.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary">
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </button>
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      <section className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            From
            <input
              type="date"
              value={range.from}
              onChange={(event) =>
                setRange((current) => ({ ...current, from: event.target.value }))
              }
              className="input mt-1 block"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            To
            <input
              type="date"
              value={range.to}
              onChange={(event) =>
                setRange((current) => ({ ...current, to: event.target.value }))
              }
              className="input mt-1 block"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void scan()}
            disabled={scanning}
          >
            <ScanSearch className="h-4 w-4" aria-hidden />
            {scanning ? "Scanning…" : "Run scan"}
          </button>
          <p className="text-xs text-slate-500">
            Scans are run on request; no background scheduler is attached. Re-running
            a scan updates the same finding instead of duplicating it.
          </p>
        </div>
        {lastScan && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Last scan: {lastScan.scanned} finding{lastScan.scanned === 1 ? "" : "s"} ·{" "}
            {lastScan.created} new · {lastScan.updated} updated · {lastScan.high} high ·{" "}
            {lastScan.medium} medium · {lastScan.low} low.
          </p>
        )}
      </section>

      {loading && !board ? (
        <p className="text-sm text-slate-500">Loading findings…</p>
      ) : board ? (
        <>
          <section className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Open" value={board.counts.open} tone="warning" />
            <StatCard label="Acknowledged" value={board.counts.acknowledged} />
            <StatCard label="Resolved" value={board.counts.resolved} tone="positive" />
            <StatCard
              label="High severity"
              value={board.counts.high}
              tone={board.counts.high > 0 ? "negative" : "positive"}
              icon={<ShieldAlert />}
            />
            <StatCard label="Medium" value={board.counts.medium} />
            <StatCard label="Low" value={board.counts.low} />
          </section>

          {briefing && (
            <section className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-bold text-slate-900">
                    Zeli anomaly briefing
                  </h2>
                  <p className="mt-1 max-w-3xl text-xs text-slate-600">
                    {briefing.headline}
                  </p>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase ${
                    BAND_CLASSES[briefing.band] ?? BAND_CLASSES.low
                  }`}
                >
                  {briefing.band} attention · {briefing.score}/100
                </span>
              </div>

              <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                Deterministic rule-weighted triage. {briefing.signalsConsidered} active
                finding{briefing.signalsConsidered === 1 ? "" : "s"} considered. This is
                not a probability of fraud, and no external model was called.
              </p>

              {briefing.groups.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">
                  No active findings are available for triage.
                </p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[38rem] text-left text-xs">
                    <thead className="text-[11px] uppercase text-slate-500">
                      <tr>
                        <th className="pb-2 pr-3 font-semibold">Group</th>
                        <th className="pb-2 pr-3 font-semibold">Active</th>
                        <th className="pb-2 pr-3 font-semibold">High</th>
                        <th className="pb-2 pr-3 font-semibold">Attention</th>
                        <th className="pb-2 font-semibold">Why it is ranked here</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {briefing.groups.slice(0, 5).map((group) => (
                        <tr key={group.key}>
                          <td className="py-2 pr-3">
                            <span className="font-medium text-slate-800">
                              {group.label}
                            </span>
                            <span className="ml-1 text-[11px] text-slate-500">
                              ({group.kind})
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-slate-700">{group.signalCount}</td>
                          <td className="py-2 pr-3 text-slate-700">{group.high}</td>
                          <td className="py-2 pr-3">
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${
                                BAND_CLASSES[group.band] ?? BAND_CLASSES.low
                              }`}
                            >
                              {group.band} · {group.score}
                            </span>
                          </td>
                          <td className="py-2 text-slate-600">
                            {group.reasons.slice(0, 2).join(" ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <details className="mt-3 text-[11px] text-slate-600">
                <summary className="cursor-pointer font-semibold text-slate-600">
                  How the attention score is calculated
                </summary>
                <p className="mt-2">{briefing.methodology}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {briefing.limitations.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="card p-3 text-xs font-medium text-slate-600">
              Status
              <select
                value={filters.status}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, status: event.target.value }))
                }
                className="input mt-1 w-full"
              >
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="resolved">Resolved</option>
              </select>
            </label>
            <label className="card p-3 text-xs font-medium text-slate-600">
              Severity
              <select
                value={filters.severity}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, severity: event.target.value }))
                }
                className="input mt-1 w-full"
              >
                <option value="all">All severities</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="card p-3 text-xs font-medium text-slate-600 sm:col-span-2">
              Rule
              <select
                value={filters.ruleKey}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, ruleKey: event.target.value }))
                }
                className="input mt-1 w-full"
              >
                <option value="all">All rules</option>
                {board.rules.map((rule) => (
                  <option key={rule.key} value={rule.key}>
                    {rule.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <details className="card p-4">
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-bold text-slate-900">
              <ChevronDown className="h-4 w-4" aria-hidden /> Rules and thresholds
            </summary>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <p className="rounded-lg bg-slate-50 px-3 py-2">
                Daily short/over: at least{" "}
                <strong>GH₵{board.thresholds.dailyDifference.toFixed(2)}</strong>{" "}
                (high at GH₵{board.thresholds.dailyDifferenceHigh.toFixed(2)}).
              </p>
              <p className="rounded-lg bg-slate-50 px-3 py-2">
                Large transaction:{" "}
                <strong>GH₵{board.thresholds.largeTransaction.toFixed(2)}</strong>{" "}
                (high at GH₵{board.thresholds.largeTransactionHigh.toFixed(2)}).
              </p>
              <p className="rounded-lg bg-slate-50 px-3 py-2">
                Repeated shortages / reversals:{" "}
                <strong>{board.thresholds.repeatedShortages}</strong> in the period.
              </p>
              <p className="rounded-lg bg-slate-50 px-3 py-2">
                Unreviewed account: after{" "}
                <strong>{board.thresholds.unreviewedDays} days</strong>.
              </p>
              <p className="rounded-lg bg-slate-50 px-3 py-2">
                Stale transfer: after{" "}
                <strong>{board.thresholds.staleTransferDays} days</strong>.
              </p>
              <p className="rounded-lg bg-slate-50 px-3 py-2">
                Expense spike:{" "}
                <strong>{board.thresholds.expenseSpikeMultiple}×</strong> the branch
                median, above GH₵{board.thresholds.expenseSpikeFloor.toFixed(2)}.
              </p>
            </div>
            <ul className="mt-3 grid gap-1 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
              {board.rules.map((rule) => (
                <li key={rule.key}>
                  <strong>{rule.label}:</strong> {rule.description}
                </li>
              ))}
            </ul>
          </details>

          {board.anomalies.length === 0 ? (
            <div className="card py-14 text-center">
              <CheckCircle2 className="mx-auto mb-2 h-9 w-9 text-emerald-500" aria-hidden />
              <p className="font-medium text-slate-700">No findings match these filters.</p>
              <p className="mt-1 text-sm text-slate-500">
                Run a scan after new daily accounts, transfers or shifts are recorded.
              </p>
            </div>
          ) : (
            <section className="space-y-3">
              {board.anomalies.map((finding) => {
                const href = entityHref(finding.entityType, finding.entityId);
                const rule = rules.get(finding.ruleKey);
                return (
                  <article key={finding.id} className="card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${
                              SEVERITY_CLASSES[finding.severity] ?? SEVERITY_CLASSES.low
                            }`}
                          >
                            {finding.severity}
                          </span>
                          <span className={`badge ${STATUS_CLASSES[finding.status] ?? "badge-gray"}`}>
                            {finding.status}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            {rule?.label ?? finding.ruleKey}
                          </span>
                        </div>
                        <h2 className="mt-1 text-sm font-bold text-slate-900">
                          {finding.title}
                        </h2>
                        <p className="mt-0.5 break-words text-sm text-slate-600">
                          {finding.summary}
                        </p>
                      </div>
                      {href && (
                        <Link
                          href={href}
                          className="text-xs font-semibold text-brand-700 hover:underline"
                        >
                          Open record
                        </Link>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                      <span>Rule: {finding.ruleKey}</span>
                      {finding.businessDate && (
                        <span>Business date: {finding.businessDate.slice(0, 10)}</span>
                      )}
                      {finding.metricValue !== null && (
                        <span>
                          Measured:{" "}
                          {MONEY_RULES.has(finding.ruleKey) ? (
                            <CediAmount amount={finding.metricValue} />
                          ) : (
                            finding.metricValue
                          )}
                          {finding.thresholdValue !== null && (
                            <>
                              {" "}· threshold{" "}
                              {MONEY_RULES.has(finding.ruleKey) ? (
                                <CediAmount amount={finding.thresholdValue} />
                              ) : (
                                finding.thresholdValue
                              )}
                            </>
                          )}
                        </span>
                      )}
                      <span>Detected: {fmt(finding.detectedAt)}</span>
                      <span>Last seen: {fmt(finding.lastSeenAt)}</span>
                    </div>

                    {finding.evidence && (
                      <details className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">
                          Evidence
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-600">
                          {JSON.stringify(finding.evidence, null, 2)}
                        </pre>
                      </details>
                    )}

                    {finding.status !== "resolved" ? (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <label className="text-xs font-medium text-slate-600">
                          What was checked?
                          <textarea
                            value={notes[finding.id] ?? ""}
                            onChange={(event) =>
                              setNotes((current) => ({
                                ...current,
                                [finding.id]: event.target.value,
                              }))
                            }
                            rows={2}
                            maxLength={500}
                            placeholder="Required to resolve (at least 5 characters); optional to acknowledge."
                            className="input mt-1 w-full"
                          />
                        </label>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {finding.status === "open" && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={busyId === finding.id}
                              onClick={() => void acknowledge(finding.id)}
                            >
                              Acknowledge
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busyId === finding.id || (notes[finding.id] ?? "").trim().length < 5}
                            onClick={() => void resolve(finding.id)}
                          >
                            Resolve
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                        Resolved by {finding.resolvedByName ?? "administrator"} on{" "}
                        {fmt(finding.resolvedAt)}. {finding.resolutionNote}
                      </div>
                    )}

                    {finding.status === "acknowledged" && finding.acknowledgedAt && (
                      <p className="mt-2 text-[11px] text-slate-500">
                        Acknowledged by {finding.acknowledgedByName ?? "administrator"} on{" "}
                        {fmt(finding.acknowledgedAt)}.
                      </p>
                    )}
                  </article>
                );
              })}
            </section>
          )}

          <AnomalyInvestigationPanel
            anomalies={board.anomalies.map((row) => ({
              id: row.id,
              title: row.title,
              ruleKey: row.ruleKey,
              severity: row.severity,
              status: row.status,
            }))}
            staff={staff}
          />

          <EvidenceProvenancePanel />

          <p className="flex items-start gap-2 text-xs text-slate-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
            A finding is a prompt to check a record, not proof of wrongdoing.
            Thresholds are fixed policy values and can be reviewed with the rule
            catalogue above.
          </p>
        </>
      ) : null}
    </div>
  );
}
