"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";

import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getBranchReport, getSusuReportOptions } from "@/lib/actions/susu-reporting.actions";
import CediAmount from "@/components/CediAmount";

export default function SusuBranchesReportPage() {
  const handleRedirect = useRedirectHandler();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [branchId, setBranchId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [options, setOptions] = useState<{ branches: Array<{ id: string; name: string }> }>({ branches: [] });
  const [result, setResult] = useState<Awaited<ReturnType<typeof getBranchReport>>["data"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const opts = await getSusuReportOptions();
        if (cancelled) return;
        if (!opts.success) {
          if (handleRedirect(new Error("UNAUTHENTICATED"), setError, "Failed to load report")) return;
          return;
        }
        setOptions(opts.data ?? { branches: [] });
        const res = await getBranchReport({
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
  }, [branchId, dateFrom, dateTo]);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Branch Report</h1>
          <p className="text-slate-500 mt-1">Branch-level contribution and remittance position</p>
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
            <select value={branchId} onChange={(e) => { setBranchId(e.target.value); }}>
              <option value="">All branches</option>
              {options.branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Date From</label>
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); }} />
          </div>
          <div className="form-group">
            <label className="form-label">Date To</label>
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); }} />
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={10} />
        ) : result ? (
          result.branches?.length === 0 ? (
            <p className="text-center py-12 text-slate-500">No branch data available for this period.</p>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Contributions</th>
                    <th>Reversed</th>
                    <th>Net</th>
                    <th>Declared</th>
                    <th>Received</th>
                    <th>Outstanding</th>
                    <th>Open Discrepancies</th>
                  </tr>
                </thead>
                <tbody>
                  {result.branches.map((row) => (
                    <tr key={row.branchId}>
                      <td className="text-sm font-medium">{row.branchName}</td>
                      <td className="font-mono"><CediAmount amount={row.contributionAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.reversedAmount} /></td>
                      <td className="font-mono font-semibold"><CediAmount amount={row.netContributionAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.declaredAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.receivedAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.outstandingAmount} /></td>
                      <td className="font-mono">{row.openDiscrepancies}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
        {result?.totals ? (
          <p className="mt-4 text-sm text-slate-500">
            Total contributions <CediAmount amount={result.totals.contributionAmount} /> · Outstanding <CediAmount amount={result.totals.outstandingAmount} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
