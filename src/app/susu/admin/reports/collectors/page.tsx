"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";

import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getCollectorPerformanceReport, getSusuReportOptions } from "@/lib/actions/susu-reporting.actions";
import ExportReportButton from "../_components/ExportReportButton";
import CediAmount from "@/components/CediAmount";

export default function SusuCollectorsReportPage() {
  const handleRedirect = useRedirectHandler();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [branchId, setBranchId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [options, setOptions] = useState<{ branches: Array<{ id: string; name: string }>; collectors: Array<{ id: string; fullName: string; branchId: string | null }> }>({ branches: [], collectors: [] });
  const [result, setResult] = useState<Awaited<ReturnType<typeof getCollectorPerformanceReport>>["data"] | null>(null);

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
        setOptions(opts.data ?? { branches: [], collectors: [] });
        const res = await getCollectorPerformanceReport({
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
          <h1 className="text-2xl font-bold text-slate-900">Susu Collector Performance</h1>
          <p className="text-slate-500 mt-1">Reversal-aware contribution and remittance performance</p>
        </div>
        <ExportReportButton
          report="collectors"
          filters={{
            branchId: branchId || undefined,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
          }}
        />
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
          <SkeletonTable rows={8} columns={8} />
        ) : result ? (
          result.collectors?.length === 0 ? (
            <p className="text-center py-12 text-slate-500">No collector data available for this period.</p>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Collector</th>
                    <th>Contributions</th>
                    <th>Reversed</th>
                    <th>Net</th>
                    <th>Declared</th>
                    <th>Received</th>
                    <th>Verified</th>
                    <th>Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {result.collectors.map((row) => (
                    <tr key={row.id}>
                      <td className="text-sm font-medium">{row.fullName}</td>
                      <td className="font-mono"><CediAmount amount={row.contributionAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.reversedContributionAmount} /></td>
                      <td className="font-mono font-semibold"><CediAmount amount={row.contributionAmount - row.reversedContributionAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.declaredAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.receivedAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.verifiedAmount} /></td>
                      <td className="font-mono"><CediAmount amount={row.outstandingAmount} /></td>
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
