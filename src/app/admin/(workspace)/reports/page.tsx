"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";
import { ClipboardList } from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { getDailyAccounts } from "@/lib/actions/daily-account.actions";
import { getLocations } from "@/lib/actions/location.actions";
import { formatDate } from "@/lib/utils";
import Link from "next/link";
import CediAmount from "@/components/CediAmount";
import { resolveStoredDifference } from "@/lib/momo-reconciliation";

interface Account {
  id: string; businessDate: Date; status: string; submittedAt?: Date | null;
  openingMomoFloat: number; openingCash: number;
  additionalCashReceived: number; additionalMomoFloat: number;
  totalCashIn: number; totalCashOut: number; totalAirtimeSold: number;
  commission: number; totalExpenses: number;
  closingMomoFloat: number; closingCash: number;
  calculatedDifference: number; differenceStatus: string;
  calculatedMomoVariance?: number; calculatedCashVariance?: number;
  location: { id: string; name: string; code: string };
  worker: { id: string; fullName: string; email: string };
}
interface Pagination { page: number; limit: number; total: number; totalPages: number; }
interface Location { id: string; name: string; code: string; }

export default function ReportsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [locationId, setLocationId] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const handleRedirect = useRedirectHandler();

  async function loadLocations() {
    try {
      const data = await getLocations();
      setLocations((data as Array<{ id: string; name: string; code: string }>).map((l) => ({ id: l.id, name: l.name, code: l.code })));
    } catch (err) { if (handleRedirect(err, () => {}, "")) return; }
  }

  async function loadAccounts() {
    setLoading(true);
    try {
      const result = await getDailyAccounts({ page, limit: 15, locationId: locationId || undefined, status: status || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
      setAccounts(result.accounts as unknown as Account[]); setPagination(result.pagination);
    } catch (err) { if (handleRedirect(err, () => {}, "")) return; } finally { setLoading(false); }
  }

  useEffect(() => { loadLocations(); }, []);
  useEffect(() => { loadAccounts(); }, [locationId, status, dateFrom, dateTo, page]);

  function handleExportCSV() {
    if (accounts.length === 0) return;
    // Approved business terminology. "Cash paid out" is retired: Cash out is
    // the single record of cash paid to customers.
    const headers = ["Date","Location","Worker","Status","Opening MoMo","Opening Cash","Customer deposit","Cash out","Airtime sold","Additional cash","Additional float","Commission","Expenses","Closing MoMo","Closing Cash","Difference","Difference status"];
    const rows = accounts.map((a) => {
      const stored = resolveStoredDifference(a);
      return [a.businessDate, a.location.name, a.worker.fullName, a.status, a.openingMomoFloat, a.openingCash, a.totalCashIn, a.totalCashOut, a.totalAirtimeSold, a.additionalCashReceived, a.additionalMomoFloat, a.commission, a.totalExpenses, a.closingMomoFloat, a.closingCash, stored.difference, stored.status];
    });
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `maacash-momo-reports-${new Date().toISOString().split("T")[0]}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div><h1 className="text-2xl font-bold text-slate-900">Reports</h1><p className="text-slate-500 mt-1">Daily closing accountability for every MoMo location</p></div>
        <button onClick={handleExportCSV} className="btn btn-secondary btn-sm" disabled={accounts.length === 0}>📥 Export CSV</button>
      </div>

      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="form-group"><label className="form-label">Location</label><select value={locationId} onChange={(e) => { setLocationId(e.target.value); setPage(1); }}><option value="">All Locations</option>{locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></div>
          <div className="form-group"><label className="form-label">Status</label><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All Statuses</option><option value="draft">Draft</option><option value="submitted">Submitted</option><option value="reviewed">Reviewed</option></select></div>
          <div className="form-group"><label className="form-label">Date From</label><input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} /></div>
          <div className="form-group"><label className="form-label">Date To</label><input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} /></div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={5} />
        ) : accounts.length === 0 ? (
          <div className="text-center py-12 text-slate-500"><p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><ClipboardList size={36} /></p><p className="font-medium">No reports found</p><p className="text-sm mt-1">Try adjusting your filters.</p></div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead><tr><th>Date</th><th>Location</th><th>Worker</th><th>Status</th><th className="text-right">Customer deposit</th><th className="text-right">Cash out</th><th className="text-right">Airtime sold</th><th className="text-right">Difference</th><th></th></tr></thead>
                <tbody>
                  {accounts.map((account) => {
                    const stored = resolveStoredDifference(account);
                    return (
                    <tr key={account.id}>
                      <td className="font-medium">{formatDate(account.businessDate)}</td>
                      <td><div>{account.location.name}</div><div className="text-xs text-slate-500">{account.location.code}</div></td>
                      <td>{account.worker.fullName}</td>
                      <td><span className={`badge ${account.status === "submitted" ? "badge-green" : account.status === "reviewed" ? "badge-blue" : account.status === "draft" ? "badge-yellow" : "badge-gray"}`}>{account.status === "draft" ? "Draft Saved" : account.status === "submitted" ? "Submitted" : account.status === "reviewed" ? "Reviewed" : account.status}</span></td>
                      <td className="text-right font-mono text-sm"><CediAmount amount={account.totalCashIn} /></td>
                      <td className="text-right font-mono text-sm"><CediAmount amount={account.totalCashOut} /></td>
                      <td className="text-right font-mono text-sm"><CediAmount amount={account.totalAirtimeSold} /></td>
                      <td className="text-right font-mono text-sm">
                        <span className={stored.status === "shortage" ? "text-red-600" : "text-green-600"}>
                          <CediAmount amount={stored.difference} showSign />
                        </span>
                      </td>
                      <td><Link href={`/admin/reports/${account.id}`} className="text-sm text-blue-600 hover:text-blue-800">View</Link></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <p className="text-sm text-slate-500">Showing {(pagination.page - 1) * pagination.limit + 1} to {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}</p>
                <div className="flex gap-2">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn btn-secondary btn-sm">Previous</button>
                  <button onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))} disabled={page === pagination.totalPages} className="btn btn-secondary btn-sm">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
