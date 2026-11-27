"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";

import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getContributionReport } from "@/lib/actions/susu-reporting.actions";
import ExportReportButton from "../_components/ExportReportButton";
import { formatDateTime, formatCedi } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import { PromptDialog } from "@/components/ui/Modal";

export default function SusuContributionsReportPage() {
  const handleRedirect = useRedirectHandler();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [channel, setChannel] = useState("");
  const [reversalStatus, setReversalStatus] = useState<"all" | "reversed" | "notReversed">("all");
  const [result, setResult] = useState<Awaited<ReturnType<typeof getContributionReport>>["data"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getContributionReport({
          page,
          limit,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          channel: channel || undefined,
          reversalStatus,
        });
        if (cancelled) return;
        if (!res.success) {
          if (handleRedirect(new Error("UNAUTHENTICATED"), setError, "Failed to load report")) return;
          return;
        }
        setResult(res.data);
      } catch {
        if (!cancelled) setError("Failed to load report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, limit, dateFrom, dateTo, channel, reversalStatus]);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Contribution Report</h1>
          <p className="text-slate-500 mt-1">Reversal-aware contribution reporting</p>
        </div>
        <ExportReportButton
          report="contributions"
          filters={{
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
            channel: channel || undefined,
            reversalStatus: reversalStatus === "all" ? undefined : reversalStatus,
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
            <label className="form-label">Date From</label>
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          </div>
          <div className="form-group">
            <label className="form-label">Date To</label>
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </div>
          <div className="form-group">
            <label className="form-label">Channel</label>
            <select value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }}>
              <option value="">All</option>
              <option value="collector">Collector</option>
              <option value="direct_office">Direct office</option>
              <option value="reversal">Reversal</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Reversal Status</label>
            <select value={reversalStatus} onChange={(e) => { setReversalStatus(e.target.value as "all" | "reversed" | "notReversed"); setPage(1); }}>
              <option value="all">All</option>
              <option value="reversed">Reversed</option>
              <option value="notReversed">Not reversed</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={7} />
        ) : result ? (
          result.contributions?.length === 0 ? (
            <p className="text-center py-12 text-slate-500">No contribution records found</p>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.contributions?.map((row) => (
                    <tr key={row.id}>
                      <td className="text-sm">{row.collectionDate ? formatDateTime(new Date(row.collectionDate)) : ""}</td>
                      <td className="text-sm">{row.account?.fullName ?? ""}</td>
                      <td className="font-mono font-semibold"><CediAmount amount={row.amount} /></td>
                      <td><span className={`badge ${row.status === "reversed" ? "badge-yellow" : "badge-green"}`}>{row.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
        {result?.totals ? (
          <p className="mt-4 text-sm text-slate-500">
            Gross <CediAmount amount={result.totals.grossRecorded} /> · Reversed <CediAmount amount={result.totals.reversedAmount} /> · Net <CediAmount amount={result.totals.netAmount} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
