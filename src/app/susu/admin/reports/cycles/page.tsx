"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";

import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getCycleReport, getSusuReportOptions } from "@/lib/actions/susu-reporting.actions";
import ExportReportButton from "../_components/ExportReportButton";
import CediAmount from "@/components/CediAmount";
import { formatDate } from "@/lib/utils";

export default function SusuCyclesReportPage() {
  const handleRedirect = useRedirectHandler();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof getCycleReport>>["data"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts = await getSusuReportOptions();
        if (cancelled || !opts.success) return;
        setBranches(opts.data?.branches ?? []);
      } catch {
        /* the branch filter is optional; the report still loads without it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getCycleReport({
          page,
          status: status || undefined,
          branchId: branchId || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        });
        if (cancelled) return;
        if (!res.success) {
          if (handleRedirect(new Error("UNAUTHENTICATED"), setError, "Failed to load report")) return;
          return;
        }
        setResult(res.data ?? null);
      } catch {
        if (!cancelled) setError("Failed to load report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, status, branchId, dateFrom, dateTo]);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Cycle Report</h1>
          <p className="text-slate-500 mt-1">Per-cycle contribution and withdrawal position</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportReportButton
            report="cycles"
            filters={{
              branchId: branchId || undefined,
              dateFrom: dateFrom || undefined,
              dateTo: dateTo || undefined,
              status: status || undefined,
            }}
          />
          <label className="text-sm text-slate-500">Page</label>
          <input
            type="number"
            min={1}
            value={page}
            onChange={(e) => setPage(Math.max(1, Number(e.target.value) || 1))}
            className="input w-20"
          />
        </div>
      </div>

      {error && (
        <Notice type="error" className="mb-4" message={error}>
          {error}
        </Notice>
      )}

      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="form-group">
            <label className="form-label">Branch</label>
            <select value={branchId} onChange={(e) => { setBranchId(e.target.value); setPage(1); }}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Date From</label>
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          </div>
          <div className="form-group">
            <label className="form-label">Date To</label>
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={9} />
        ) : result ? (
          result.cycles?.length === 0 ? (
            <p className="text-center py-12 text-slate-500">No cycle data available for this period.</p>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Cycle</th>
                    <th>Branch</th>
                    <th>Customer</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Contributions</th>
                    <th>Reversed</th>
                    <th>Net</th>
                    <th>Allocated</th>
                    <th>Withdrawal</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cycles.map((row) => (
                    <tr key={row.id}>
                      <td className="text-sm font-medium">#{row.cycleNumber}</td>
                      <td className="text-sm">{row.branchName ?? "—"}</td>
                      <td className="text-sm">{row.account?.fullName ?? ""}</td>
                      <td className="text-sm">{row.startDate ? formatDate(row.startDate) : ""}</td>
                      <td className="text-sm">{row.endDate ? formatDate(row.endDate) : ""}</td>
                      <td className="font-mono"><CediAmount amount={row.contributionsAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.reversedAmount} /></td>
                      <td className="font-mono font-semibold"><CediAmount amount={row.netContributions} /></td>
                      <td className="font-mono"><CediAmount amount={row.allocatedAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.withdrawalAmount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
        {result?.pagination ? (
          <p className="mt-4 text-sm text-slate-500">
            Page {result.pagination.page} of {result.pagination.totalPages} · {result.pagination.total} cycles
          </p>
        ) : null}
      </div>
    </div>
  );
}
