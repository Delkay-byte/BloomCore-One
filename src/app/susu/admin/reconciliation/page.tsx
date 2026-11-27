"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowUpRight, RefreshCw, Scale } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { SkeletonStatCards, SkeletonTable } from "@/components/ui/Skeletons";
import { formatCedi, formatDateTime } from "@/lib/utils";
import { getBranchesForScope } from "@/lib/actions/branch.actions";
import { getCollectors } from "@/lib/actions/susu-collector.actions";
import {
  getReconciliationOverview,
  listReconciliationSessions,
  openReconciliationSession,
  type ReconciliationOverview,
  type SusuReconciliationView,
} from "@/lib/actions/susu-reconciliation.actions";

interface BranchOption {
  id: string;
  name: string;
}
interface CollectorOption {
  id: string;
  branchId: string | null;
  user: { fullName: string };
}

const SESSION_TYPES = [
  { value: "daily_close", label: "Daily collector close" },
  { value: "branch_close", label: "Branch close" },
  { value: "remittance", label: "Money handed in" },
  { value: "sync", label: "Offline sync" },
  { value: "other", label: "Other review" },
];

function dayInput(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "danger" | "warning";
}) {
  const color =
    tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-ink";
  return (
    <div className="card !p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export default function ReconciliationWorkspacePage() {
  const router = useRouter();
  const [overview, setOverview] = useState<ReconciliationOverview | null>(null);
  const [sessions, setSessions] = useState<SusuReconciliationView[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [collectors, setCollectors] = useState<CollectorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [branchId, setBranchId] = useState("");
  const [showOpen, setShowOpen] = useState(false);
  const [type, setType] = useState("daily_close");
  const [collectorId, setCollectorId] = useState("");
  const [periodStart, setPeriodStart] = useState(dayInput());
  const [periodEnd, setPeriodEnd] = useState(dayInput());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [overviewResult, sessionResult, branchRows, collectorRows] = await Promise.all([
        getReconciliationOverview({ branchId: branchId || null }),
        listReconciliationSessions({ branchId: branchId || null, limit: 12 }),
        getBranchesForScope(),
        getCollectors(),
      ]);
      if (!overviewResult.success) {
        setError(overviewResult.error ?? "The workspace could not be loaded.");
        return;
      }
      setOverview(overviewResult.data ?? null);
      if (!sessionResult.success) {
        setError(sessionResult.error ?? "The sessions could not be loaded.");
        return;
      }
      setSessions(sessionResult.data?.sessions ?? []);
      setBranches((branchRows as BranchOption[]) ?? []);
      setCollectors((collectorRows as unknown as CollectorOption[]) ?? []);
    } catch {
      setError("The reconciliation workspace could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredCollectors = useMemo(
    () => (branchId ? collectors.filter((c) => c.branchId === branchId) : collectors),
    [collectors, branchId]
  );

  async function openSession() {
    setError("");
    setSuccess("");
    if (periodStart > periodEnd) {
      setError("The period start must be on or before the period end.");
      return;
    }
    if (type === "daily_close" && !collectorId) {
      setError("Choose the collector for a daily close.");
      return;
    }
    setBusy(true);
    try {
      const result = await openReconciliationSession({
        type,
        branchId: branchId || null,
        collectorId: collectorId || null,
        periodStart,
        periodEnd,
      });
      if (!result.success || !result.data) {
        setError(result.error ?? "The reconciliation session could not be opened.");
        return;
      }
      router.push(`/susu/admin/reconciliation/sessions/${result.data.id}`);
    } catch {
      setError("The reconciliation session could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Scale size={22} aria-hidden /> Reconciliation workspace
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Compare recorded cash, physical handovers and bank receipts. Detection observes
            existing records only; it never edits a contribution, remittance or withdrawal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={13} aria-hidden /> {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowOpen((value) => !value)}
          >
            {showOpen ? "Cancel" : "Open review"}
          </button>
        </div>
      </header>

      {error ? <Notice type="error" message={error}>{error}</Notice> : null}
      {success ? <Notice type="success" message={success}>{success}</Notice> : null}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="workspace-branch" className="text-sm font-medium text-ink">
          Branch
        </label>
        <select
          id="workspace-branch"
          value={branchId}
          onChange={(event) => setBranchId(event.target.value)}
          className="max-w-xs"
        >
          <option value="">All branches in my scope</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </div>

      {showOpen ? (
        <section className="card space-y-4" aria-label="Open a reconciliation review">
          <div>
            <h2 className="text-lg font-semibold">Open a reconciliation review</h2>
            <p className="text-sm text-muted">
              A daily close is an operational handover check. It does not replace the formal
              money-handed-in record or a withdrawal approval.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="form-group">
              <label className="form-label" htmlFor="session-type">Review type</label>
              <select
                id="session-type"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                {SESSION_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="session-branch">Branch</label>
              <select
                id="session-branch"
                value={branchId}
                onChange={(event) => {
                  setBranchId(event.target.value);
                  setCollectorId("");
                }}
              >
                <option value="">Choose a branch</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="session-collector">Collector</label>
              <select
                id="session-collector"
                value={collectorId}
                onChange={(event) => {
                  setCollectorId(event.target.value);
                  const found = collectors.find((c) => c.id === event.target.value);
                  if (found?.branchId) setBranchId(found.branchId);
                }}
              >
                <option value="">{type === "daily_close" ? "Choose a collector" : "All collectors"}</option>
                {filteredCollectors.map((collector) => (
                  <option key={collector.id} value={collector.id}>
                    {collector.user.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="period-start">Period start</label>
              <input
                id="period-start"
                type="date"
                value={periodStart}
                max={periodEnd}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="period-end">Period end</label>
              <input
                id="period-end"
                type="date"
                value={periodEnd}
                min={periodStart}
                onChange={(event) => setPeriodEnd(event.target.value)}
              />
            </div>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void openSession()} disabled={busy}>
            {busy ? "Opening…" : "Open review"}
          </button>
        </section>
      ) : null}

      {loading && !overview ? (
        <SkeletonStatCards count={6} />
      ) : overview ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Stat label="Open cases" value={overview.cases.open + overview.cases.assigned + overview.cases.underReview + overview.cases.awaitingEvidence + overview.cases.escalated + overview.cases.resolutionProposed} />
          <Stat label="Overdue" value={overview.cases.overdue} tone={overview.cases.overdue ? "danger" : "default"} hint="Past the due date" />
          <Stat label="Unassigned" value={overview.cases.unassigned} tone={overview.cases.unassigned ? "warning" : "default"} />
          <Stat label="Outstanding" value={formatCedi(overview.cash.outstanding)} tone={overview.cash.outstanding ? "danger" : "default"} hint="Expected less received" />
          <Stat label="Pending sync" value={overview.pendingSync.queuedTransactions + overview.pendingSync.failedAttempts} tone={overview.pendingSync.queuedTransactions + overview.pendingSync.failedAttempts ? "warning" : "default"} hint={formatCedi(overview.cash.pendingSyncAmount)} />
          <Stat label="Resolved" value={overview.cases.resolved} hint={`${overview.cases.escalated} escalated`} />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card overflow-hidden !p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="font-semibold">Branches</h2>
            <Link href="/susu/admin/reconciliation/branches" className="text-xs font-semibold text-brand-700 hover:underline">
              Branch view
            </Link>
          </div>
          {loading && !overview ? (
            <div className="p-4"><SkeletonTable rows={4} columns={4} showHeader={false} /></div>
          ) : !overview?.branches.length ? (
            <p className="p-4 text-sm text-muted">No branch activity in this scope yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th>Branch</th><th>Open</th><th>Overdue</th><th>Unassigned</th><th>Outstanding</th></tr>
                </thead>
                <tbody>
                  {overview.branches.map((branch) => (
                    <tr key={branch.branchId ?? "none"}>
                      <td className="font-medium">{branch.branchName}</td>
                      <td>{branch.openCases}</td>
                      <td className={branch.overdueCases ? "font-semibold text-red-700" : ""}>{branch.overdueCases}</td>
                      <td>{branch.unassignedCases}</td>
                      <td className="tabular-nums">{formatCedi(branch.outstandingAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card overflow-hidden !p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="font-semibold">Collectors</h2>
            <span className="text-xs text-muted">Differences stay attributed to the collector</span>
          </div>
          {loading && !overview ? (
            <div className="p-4"><SkeletonTable rows={4} columns={4} showHeader={false} /></div>
          ) : !overview?.collectors.length ? (
            <p className="p-4 text-sm text-muted">No collector differences in this view.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th>Collector</th><th>Open</th><th>Overdue</th><th>Outstanding</th><th>Pending</th><th>Last close</th></tr>
                </thead>
                <tbody>
                  {overview.collectors.map((collector) => (
                    <tr key={collector.collectorId}>
                      <td className="font-medium">{collector.collectorName}</td>
                      <td>{collector.openCases}</td>
                      <td className={collector.overdueCases ? "font-semibold text-red-700" : ""}>{collector.overdueCases}</td>
                      <td className="tabular-nums">{formatCedi(collector.outstandingAmount)}</td>
                      <td>{collector.pendingSyncCount}</td>
                      <td>{collector.lastClosingDay ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="card overflow-hidden !p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">Recent reconciliation sessions</h2>
          <span className="text-xs text-muted">{sessions.length} shown</span>
        </div>
        {loading && !sessions.length ? (
          <div className="p-4"><SkeletonTable rows={5} columns={6} /></div>
        ) : !sessions.length ? (
          <div className="p-4">
            <p className="text-sm text-muted">No reconciliation review has been opened yet.</p>
            <p className="mt-1 text-xs text-muted">A balanced review still creates an audit trail; a difference becomes a case.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Type</th><th>Branch</th><th>Collector</th><th>Period</th><th>Status</th><th>Unresolved</th><th /></tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="font-medium capitalize">{session.type.replaceAll("_", " ")}</td>
                    <td>{session.branchName ?? "—"}</td>
                    <td>{session.collectorName ?? "All"}</td>
                    <td className="whitespace-nowrap text-xs">
                      {new Date(session.periodStart).toLocaleDateString()} – {new Date(session.periodEnd).toLocaleDateString()}
                    </td>
                    <td>
                      <span className="badge">{session.statusLabel}</span>
                    </td>
                    <td className={session.unresolvedLines ? "font-semibold text-red-700" : ""}>{session.unresolvedLines}</td>
                    <td>
                      <Link href={`/susu/admin/reconciliation/sessions/${session.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
                        Open <ArrowUpRight size={12} aria-hidden />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {overview?.patterns.length ? (
        <section className="card">
          <h2 className="flex items-center gap-2 font-semibold"><AlertTriangle size={16} aria-hidden /> Repeated patterns</h2>
          <p className="mt-1 text-sm text-muted">Counts by category. These are observations, not a fraud score.</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {overview.patterns.map((pattern) => (
              <li key={pattern.category} className="rounded-control border border-line px-3 py-2">
                <p className="text-sm font-semibold">{pattern.categoryLabel}</p>
                <p className="text-xs text-muted">{pattern.count} case{pattern.count === 1 ? "" : "s"} · {formatCedi(pattern.amountAtStake)} at stake</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted">
        Last updated {overview ? formatDateTime(new Date(overview.generatedAt)) : "—"}. No fraud
        score is calculated or displayed.
      </p>
    </div>
  );
}
