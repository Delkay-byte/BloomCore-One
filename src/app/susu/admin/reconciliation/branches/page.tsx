"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Building2, RefreshCw } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { SkeletonTable } from "@/components/ui/Skeletons";
import { formatCedi } from "@/lib/utils";
import { getBranchesForScope } from "@/lib/actions/branch.actions";
import {
  getReconciliationOverview,
  listReconciliationSessions,
  type ReconciliationOverview,
  type SusuReconciliationView,
} from "@/lib/actions/susu-reconciliation.actions";

interface BranchOption { id: string; name: string }

export default function BranchReconciliationPage() {
  const [overview, setOverview] = useState<ReconciliationOverview | null>(null);
  const [sessions, setSessions] = useState<SusuReconciliationView[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchId, setBranchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [overviewResult, sessionResult, branchRows] = await Promise.all([
        getReconciliationOverview({ branchId: branchId || null }),
        listReconciliationSessions({ branchId: branchId || null, limit: 50 }),
        getBranchesForScope(),
      ]);
      if (!overviewResult.success) {
        setError(overviewResult.error ?? "The branch view could not be loaded.");
        return;
      }
      setOverview(overviewResult.data ?? null);
      if (!sessionResult.success) {
        setError(sessionResult.error ?? "The branch sessions could not be loaded.");
        return;
      }
      setSessions(sessionResult.data?.sessions ?? []);
      setBranches((branchRows as BranchOption[]) ?? []);
    } catch {
      setError("The branch view could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleBranches = useMemo(
    () => (overview?.branches ?? []).filter((branch) => !branchId || branch.branchId === branchId),
    [overview, branchId]
  );
  const visibleCollectors = useMemo(
    () => (overview?.collectors ?? []).filter((collector) => !branchId || collector.branchId === branchId),
    [overview, branchId]
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Building2 size={22} aria-hidden /> Branch reconciliation
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            See which branches carry unresolved cash, which collectors have differences, and
            whether the latest daily close is complete.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} aria-hidden /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? <Notice type="error" message={error}>{error}</Notice> : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="form-group min-w-56">
          <label className="form-label" htmlFor="branch-view-filter">Branch</label>
          <select id="branch-view-filter" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">All branches in my scope</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </div>
        <Link href="/susu/admin/reconciliation/exceptions?unassigned=1" className="btn btn-secondary btn-sm">Unassigned cases</Link>
        <Link href="/susu/admin/reconciliation/exceptions?overdue=1" className="btn btn-secondary btn-sm">Overdue cases</Link>
        <Link href="/susu/admin/reconciliation/daily-closing" className="btn btn-secondary btn-sm">Daily closings</Link>
      </div>

      {loading && !overview ? (
        <SkeletonTable rows={5} columns={6} />
      ) : !visibleBranches.length ? (
        <div className="card"><p className="text-sm text-muted">No branch has reconciliation activity in this scope.</p></div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleBranches.map((branch) => (
            <section key={branch.branchId ?? "none"} className="card space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{branch.branchName}</h2>
                  <p className="text-xs text-muted">Branch-scoped difference summary</p>
                </div>
                <span className={`badge ${branch.overdueCases ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}`}>
                  {branch.overdueCases ? `${branch.overdueCases} overdue` : "No overdue"}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div><dt className="text-xs text-muted">Open cases</dt><dd className="font-semibold">{branch.openCases}</dd></div>
                <div><dt className="text-xs text-muted">Unassigned</dt><dd className="font-semibold">{branch.unassignedCases}</dd></div>
                <div><dt className="text-xs text-muted">Overdue</dt><dd className={`font-semibold ${branch.overdueCases ? "text-red-700" : ""}`}>{branch.overdueCases}</dd></div>
                <div><dt className="text-xs text-muted">Outstanding</dt><dd className="font-semibold tabular-nums">{formatCedi(branch.outstandingAmount)}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-2 text-xs font-semibold">
                <Link href={`/susu/admin/reconciliation/exceptions?branchId=${branch.branchId ?? ""}`} className="text-brand-700 hover:underline">Open queue</Link>
                <Link href={`/susu/admin/reconciliation/daily-closing`} className="text-brand-700 hover:underline">Daily closing</Link>
              </div>
            </section>
          ))}
        </div>
      )}

      <section className="card overflow-hidden !p-0">
        <h2 className="border-b border-line px-4 py-3 font-semibold">Collector position</h2>
        {loading && !overview ? (
          <div className="p-4"><SkeletonTable rows={5} columns={5} /></div>
        ) : !visibleCollectors.length ? (
          <p className="p-4 text-sm text-muted">No collector differences in this scope.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Collector</th><th>Open</th><th>Overdue</th><th>Outstanding</th><th>Pending sync</th><th>Last close</th></tr></thead>
              <tbody>
                {visibleCollectors.map((collector) => (
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

      <section className="card overflow-hidden !p-0">
        <h2 className="border-b border-line px-4 py-3 font-semibold">Recent sessions in this branch</h2>
        {loading && !sessions.length ? (
          <div className="p-4"><SkeletonTable rows={5} columns={5} /></div>
        ) : !sessions.length ? (
          <p className="p-4 text-sm text-muted">No reconciliation session has been opened for this branch.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Type</th><th>Collector</th><th>Period</th><th>Status</th><th>Unresolved</th><th /></tr></thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="capitalize">{session.type.replaceAll("_", " ")}</td>
                    <td>{session.collectorName ?? "All"}</td>
                    <td className="whitespace-nowrap text-xs">{new Date(session.periodStart).toLocaleDateString()} – {new Date(session.periodEnd).toLocaleDateString()}</td>
                    <td><span className="badge">{session.statusLabel}</span></td>
                    <td className={session.unresolvedLines ? "font-semibold text-red-700" : ""}>{session.unresolvedLines}</td>
                    <td><Link href={`/susu/admin/reconciliation/sessions/${session.id}`} className="text-xs font-semibold text-brand-700 hover:underline">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
