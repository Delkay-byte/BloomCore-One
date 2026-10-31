"use client";

import { ClipboardList, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getContributions } from "@/lib/actions/susu-contribution.actions";
import { getWithdrawals } from "@/lib/actions/susu-withdrawal.actions";
import { formatDate, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";

type Tab = "contributions" | "withdrawals";

export default function SusuReportsPage() {
  const handleRedirect = useRedirectHandler();
  const [tab, setTab] = useState<Tab>("contributions");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [contributions, setContributions] = useState<Array<{
    id: string;
    amount: number;
    collectionDate: Date;
    channel: string;
    account: { accountId: string; customer: { customerId: string; fullName: string } };
    allocations: Array<{ cycleDay: number; amount: number }>;
  }>>([]);
  const [withdrawals, setWithdrawals] = useState<Array<{
    id: string;
    requestedAmount: number;
    commissionAmount: number;
    netAmount: number;
    remainingBalance: number;
    createdAt: Date;
    account: { accountId: string; customer: { customerId: string; fullName: string } };
    cycle: { cycleNumber: number };
  }>>([]);
  const [pagination, setPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [error, setError] = useState("");

  async function loadData() {
    setLoading(true);
    try {
      if (tab === "contributions") {
        const result = await getContributions({
          page,
          limit: 20,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        });
        setContributions(result.contributions as unknown as typeof contributions);
        setPagination(result.pagination);
      } else {
        const result = await getWithdrawals({
          page,
          limit: 20,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        });
        setWithdrawals(result.withdrawals as unknown as typeof withdrawals);
        setPagination(result.pagination);
      }
    } catch (err) { if (handleRedirect(err, setError, "Failed to load data")) return;
      /* ignore */    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [tab, page, dateFrom, dateTo]);



  function handleExportCSV() {
    if (tab === "contributions" && contributions.length > 0) {
      const headers = ["Date", "Customer", "Customer ID", "Account", "Amount", "Days Covered", "Channel"];
      const rows = contributions.map((c) => [
        formatDate(c.collectionDate),
        c.account.customer.fullName,
        c.account.customer.customerId,
        c.account.accountId,
        String(c.amount),
        String(c.allocations.length),
        c.channel,
      ]);
      const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `susu-contributions-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (tab === "withdrawals" && withdrawals.length > 0) {
      const headers = ["Date", "Customer", "Customer ID", "Requested", "Commission", "Net Paid", "Balance", "Cycle"];
      const rows = withdrawals.map((w) => [
        formatDate(w.createdAt),
        w.account.customer.fullName,
        w.account.customer.customerId,
        String(w.requestedAmount),
        String(w.commissionAmount),
        String(w.netAmount),
        String(w.remainingBalance),
        String(w.cycle.cycleNumber),
      ]);
      const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `susu-withdrawals-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Reports</h1>
          <p className="text-slate-500 mt-1">View contribution and withdrawal reports</p>
        </div>
        <button onClick={handleExportCSV} className="btn btn-secondary btn-sm">
          📥 Export CSV
        </button>
      </div>

      {error && (
        <div className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(["contributions", "withdrawals"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setPage(1); }}
            className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-secondary"}`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="form-group">
            <label className="form-label">Date From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Date To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            />
          </div>
        </div>
      </div>

      {/* Data Table */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="spinner"></div>
          </div>
        ) : tab === "contributions" ? (
          contributions.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><ClipboardList size={36} /></p>
              <p>No contribution records found</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Days</th>
                    <th>Channel</th>
                  </tr>
                </thead>
                <tbody>
                  {contributions.map((c) => (
                    <tr key={c.id}>
                      <td className="text-sm">{formatDateTime(c.collectionDate)}</td>
                      <td>
                        <div className="font-medium text-sm">{c.account.customer.fullName}</div>
                        <div className="text-xs text-slate-500">{c.account.customer.customerId}</div>
                      </td>
                      <td className="font-mono font-semibold"><CediAmount amount={c.amount} /></td>
                      <td><span className="badge badge-blue">{c.allocations.length}</span></td>
                      <td><span className={`badge ${c.channel === "collector" ? "badge-yellow" : "badge-green"}`}>{c.channel}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          withdrawals.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><ClipboardList size={36} /></p>
              <p>No withdrawal records found</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Requested</th>
                    <th>Commission</th>
                    <th>Net Paid</th>
                    <th>Cycle</th>
                  </tr>
                </thead>
                <tbody>
                  {withdrawals.map((w) => (
                    <tr key={w.id}>
                      <td className="text-sm">{formatDateTime(w.createdAt)}</td>
                      <td>
                        <div className="font-medium text-sm">{w.account.customer.fullName}</div>
                        <div className="text-xs text-slate-500">{w.account.customer.customerId}</div>
                      </td>
                      <td className="font-mono text-sm"><CediAmount amount={w.requestedAmount} /></td>
                      <td className="font-mono text-sm">
                        {w.commissionAmount > 0 ? <CediAmount amount={w.commissionAmount} /> : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="font-mono text-sm font-semibold"><CediAmount amount={w.netAmount} /></td>
                      <td><span className="badge badge-blue">Cycle {w.cycle.cycleNumber}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
            <p className="text-sm text-slate-500">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn btn-secondary btn-sm">Previous</button>
              <button onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))} disabled={page === pagination.totalPages} className="btn btn-secondary btn-sm">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
