"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";

import { useEffect, useState, useCallback } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import {
  getFinancialHistory,
  searchCollectors,
  type HistoryTransaction,
  type HistorySummary,
} from "@/lib/actions/susu-history.actions";
import { searchCustomers as searchCustomersRaw, searchStaff } from "@/lib/actions/susu-customer.actions";
import { formatCedi, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import { ClipboardList, X } from "lucide-react";
import SmartSearch from "@/components/SmartSearch";

async function searchCustomersAdapter(query: string) {
  const results = await searchCustomersRaw(query);
  return (results as unknown as Array<{ id: string; customerId: string; fullName: string }>).map((c) => ({
    id: c.id,
    label: c.fullName,
    subLabel: c.customerId,
  }));
}

type TransactionType = "" | "contributions" | "withdrawals" | "remittances";
type DatePreset = "" | "today" | "yesterday" | "24h" | "48h" | "7d" | "30d" | "custom";

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: "", label: "All Time" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "24h", label: "Last 24 Hours" },
  { value: "48h", label: "Last 48 Hours" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "custom", label: "Custom Range" },
];

const TYPE_OPTIONS: { value: TransactionType; label: string }[] = [
  { value: "", label: "All Types" },
  { value: "contributions", label: "Contributions" },
  { value: "withdrawals", label: "Withdrawals" },
  { value: "remittances", label: "Money Handed In" },
];

const CHANNEL_OPTIONS = [
  { value: "", label: "All Channels" },
  { value: "collector", label: "Collector" },
  { value: "direct_office", label: "Direct Office" },
];

export default function MoneyTransactionHistoryPage() {
  const handleRedirect = useRedirectHandler();

  // Filters
  const [datePreset, setDatePreset] = useState<DatePreset>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [transactionType, setTransactionType] = useState<TransactionType>("");
  const [channel, setChannel] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [staffId, setStaffId] = useState("");
  const [staffName, setStaffName] = useState("");
  const [collectorId, setCollectorId] = useState("");
  const [collectorName, setCollectorName] = useState("");
  const [status, setStatus] = useState("");

  // Data
  const [transactions, setTransactions] = useState<HistoryTransaction[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [pagination, setPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getFinancialHistory({
        datePreset: datePreset || undefined,
        dateFrom: datePreset === "custom" ? dateFrom : undefined,
        dateTo: datePreset === "custom" ? dateTo : undefined,
        transactionType: transactionType || undefined,
        channel: transactionType === "contributions" || !transactionType ? channel : undefined,
        customerId: customerId || undefined,
        staffId: staffId || undefined,
        collectorId: collectorId || undefined,
        status: status || undefined,
        page,
        limit: 50,
      });
      setTransactions(result.transactions);
      setSummary(result.summary);
      setPagination(result.pagination);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load financial history")) return;
      setError("Failed to load financial history");
    } finally {
      setLoading(false);
    }
  }, [datePreset, dateFrom, dateTo, transactionType, channel, customerId, staffId, collectorId, status, page, handleRedirect]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function resetFilters() {
    setDatePreset("");
    setDateFrom("");
    setDateTo("");
    setTransactionType("");
    setChannel("");
    setCustomerId("");
    setCustomerName("");
    setStaffId("");
    setStaffName("");
    setCollectorId("");
    setCollectorName("");
    setStatus("");
    setPage(1);
  }

  function handleExportCSV() {
    if (transactions.length === 0) return;
    const headers = [
      "Date & Time",
      "Type",
      "Customer",
      "Customer ID",
      "Amount",
      "Channel",
      "Received By",
      "Recorded By",
      "Collector",
      "Status",
      "Notes",
    ];
    const rows = transactions.map((t) => [
      formatDateTime(t.date),
      t.type === "contribution" ? "Contribution" : t.type === "withdrawal" ? "Withdrawal" : "Money Handed In",
      t.customerName,
      t.customerId,
      String(t.amount),
      t.channel === "collector" ? "Collector" : t.channel === "direct_office" ? "Direct Office" : "—",
      t.receivedByName || "Not recorded",
      t.recordedByName || "Not recorded",
      t.collectorName || "—",
      t.status || "—",
      t.notes || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `maacash-money-history-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getTransactionTypeLabel(type: string) {
    switch (type) {
      case "contribution": return <span className="badge badge-green">Contribution</span>;
      case "withdrawal": return <span className="badge badge-red">Withdrawal</span>;
      case "remittance": return <span className="badge badge-blue">Money Handed In</span>;
      default: return <span className="badge badge-gray">{type}</span>;
    }
  }

  function getChannelBadge(channel?: string) {
    if (!channel) return <span className="text-slate-400">—</span>;
    return (
      <span className={`badge ${channel === "collector" ? "badge-yellow" : "badge-green"}`}>
        {channel === "collector" ? "Collector" : "Direct Office"}
      </span>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Money &amp; Transaction History</h1>
          <p className="text-slate-500 mt-1">View all financial transactions across dates</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExportCSV} className="btn btn-secondary btn-sm" disabled={transactions.length === 0}>
            Export CSV
          </button>
          <button onClick={resetFilters} className="btn btn-secondary btn-sm">
            Reset Filters
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <div className="card bg-green-50 text-center">
            <div className="text-xs text-slate-600 mb-1">Total Contributions</div>
            <div className="text-lg font-bold"><CediAmount amount={summary.totalContributions} /></div>
          </div>
          <div className="card bg-emerald-50 text-center">
            <div className="text-xs text-slate-600 mb-1">Office Contributions</div>
            <div className="text-lg font-bold"><CediAmount amount={summary.totalOfficeContributions} /></div>
          </div>
          <div className="card bg-yellow-50 text-center">
            <div className="text-xs text-slate-600 mb-1">Collector Contributions</div>
            <div className="text-lg font-bold"><CediAmount amount={summary.totalCollectorContributions} /></div>
          </div>
          <div className="card bg-orange-50 text-center">
            <div className="text-xs text-slate-600 mb-1">Total Withdrawals</div>
            <div className="text-lg font-bold"><CediAmount amount={summary.totalWithdrawals} /></div>
          </div>
          <div className="card bg-blue-50 text-center">
            <div className="text-xs text-slate-600 mb-1">Money Handed In</div>
            <div className="text-lg font-bold"><CediAmount amount={summary.totalRemittances} /></div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {/* Date Preset */}
          <div className="form-group">
            <label className="form-label">Date Range</label>
            <select
              value={datePreset}
              onChange={(e) => {
                setDatePreset(e.target.value as DatePreset);
                setPage(1);
              }}
            >
              {DATE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* Transaction Type */}
          <div className="form-group">
            <label className="form-label">Transaction Type</label>
            <select
              value={transactionType}
              onChange={(e) => {
                setTransactionType(e.target.value as TransactionType);
                setPage(1);
              }}
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Channel (only for contributions) */}
          {(transactionType === "contributions" || !transactionType) && (
            <div className="form-group">
              <label className="form-label">Channel</label>
              <select
                value={channel}
                onChange={(e) => {
                  setChannel(e.target.value);
                  setPage(1);
                }}
              >
                {CHANNEL_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Custom Date Range */}
        {datePreset === "custom" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="form-group">
              <label className="form-label">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
              />
            </div>
          </div>
        )}

        {/* Smart Search Filters */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="form-group">
            <SmartSearch
              label="Customer"
              placeholder="Search by name, ID, or phone..."
              searchFn={searchCustomersAdapter}
              onSelect={(opt) => { setCustomerId(opt.id); setCustomerName(opt.label); setPage(1); }}
              onClear={() => { setCustomerId(""); setCustomerName(""); setPage(1); }}
              selectedOption={customerId ? { id: customerId, label: customerName } : null}
              minQueryLength={2}
              debounceMs={200}
            />
          </div>
          <div className="form-group">
            <SmartSearch
              label="Staff"
              placeholder="Search staff by name or email..."
              searchFn={searchStaff}
              onSelect={(opt) => { setStaffId(opt.id); setStaffName(opt.label); setPage(1); }}
              onClear={() => { setStaffId(""); setStaffName(""); setPage(1); }}
              selectedOption={staffId ? { id: staffId, label: staffName } : null}
              minQueryLength={2}
              debounceMs={200}
            />
          </div>
          <div className="form-group">
            <SmartSearch
              label="Collector"
              placeholder="Search collector by name..."
              searchFn={searchCollectors}
              onSelect={(opt) => { setCollectorId(opt.id); setCollectorName(opt.label); setPage(1); }}
              onClear={() => { setCollectorId(""); setCollectorName(""); setPage(1); }}
              selectedOption={collectorId ? { id: collectorId, label: collectorName } : null}
              minQueryLength={2}
              debounceMs={200}
            />
          </div>
        </div>

        {/* Status filter */}
        {(transactionType === "withdrawals" || transactionType === "remittances") && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            <div className="form-group">
              <label className="form-label">Status</label>
              <select
                value={status}
                onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              >
                <option value="">All Statuses</option>
                <option value="completed">Completed</option>
                <option value="pending">Pending</option>
                <option value="reconciled">Reconciled</option>
                <option value="discrepancy">Discrepancy</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Transaction List */}
      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={6} />
        ) : transactions.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <ClipboardList className="mx-auto text-brand-300 mb-2" size={36} aria-hidden />
            <p className="font-medium">No transactions found</p>
            <p className="text-sm mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date &amp; Time</th>
                    <th>Type</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Channel</th>
                    <th>Received By</th>
                    <th>Recorded By</th>
                    <th>Collector</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={`${t.type}-${t.id}`}>
                      <td className="text-sm whitespace-nowrap">{formatDateTime(t.date)}</td>
                      <td>{getTransactionTypeLabel(t.type)}</td>
                      <td>
                        <div className="font-medium text-sm">{t.customerName}</div>
                        {t.customerId !== "—" && (
                          <div className="text-xs text-slate-500">{t.customerId}</div>
                        )}
                      </td>
                      <td className="font-mono font-semibold"><CediAmount amount={t.amount} /></td>
                      <td>{getChannelBadge(t.channel)}</td>
                      <td className="text-sm">
                        {t.type === "contribution"
                          ? (t.receivedByName || "Not recorded")
                          : "—"}
                      </td>
                      <td className="text-sm">
                        {t.type === "contribution"
                          ? (t.recordedByName || "Not recorded")
                          : "—"}
                      </td>
                      <td className="text-sm">
                        {t.collectorName || "—"}
                      </td>
                      <td>
                        <span className={`badge ${
                          t.status === "completed" || t.status === "reconciled" ? "badge-green" :
                          t.status === "pending" ? "badge-yellow" :
                          t.status === "discrepancy" ? "badge-red" : "badge-gray"
                        }`}>
                          {t.status || "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <p className="text-sm text-slate-500">
                  Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="btn btn-secondary btn-sm"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                    disabled={page === pagination.totalPages}
                    className="btn btn-secondary btn-sm"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
