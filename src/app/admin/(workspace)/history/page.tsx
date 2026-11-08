"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import {
  getMoMoHistory,
  searchLocations,
  searchWorkers,
  type MoMoHistoryRecord,
  type MoMoHistorySummary,
} from "@/lib/actions/momo-history.actions";
import { formatCedi, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import SmartSearch from "@/components/SmartSearch";
import FilterChips from "@/components/ui/FilterChips";
import { NoResults, PageHeader } from "@/components/ui/DataDisplay";
import { Download, X } from "lucide-react";

type TransactionType = "" | "debts_collected" | "cash_in" | "cash_out" | "airtime" | "additional_funding" | "momo_added" | "momo_paid" | "commission" | "expenses" | "reconciliation";
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
  { value: "debts_collected", label: "Debts Collected" },
  { value: "cash_in", label: "Customer deposit (Cash in) — historical" },
  { value: "cash_out", label: "Cash out" },
  { value: "airtime", label: "Airtime sold" },
  { value: "additional_funding", label: "Additional funding" },
  { value: "momo_added", label: "MoMo float increase" },
  { value: "momo_paid", label: "MoMo float decrease" },
  { value: "commission", label: "Commission earned" },
  { value: "expenses", label: "Business expenses" },
  { value: "reconciliation", label: "Reconciliation records" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "reviewed", label: "Reviewed" },
];

export default function MoMoHistoryPage() {
  const handleRedirect = useRedirectHandler();

  // Filters
  const [datePreset, setDatePreset] = useState<DatePreset>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [transactionType, setTransactionType] = useState<TransactionType>("");
  const [locationId, setLocationId] = useState("");
  const [locationName, setLocationName] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [status, setStatus] = useState("");

  // Data
  const [records, setRecords] = useState<MoMoHistoryRecord[]>([]);
  const [summary, setSummary] = useState<MoMoHistorySummary | null>(null);
  const [pagination, setPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getMoMoHistory({
        datePreset: datePreset || undefined,
        dateFrom: datePreset === "custom" ? dateFrom : undefined,
        dateTo: datePreset === "custom" ? dateTo : undefined,
        transactionType: transactionType || undefined,
        locationId: locationId || undefined,
        workerId: workerId || undefined,
        status: status || undefined,
        page,
        limit: 50,
      });
      setRecords(result.records);
      setSummary(result.summary);
      setPagination(result.pagination);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load MoMo history")) return;
      setError("Failed to load MoMo history");
    } finally {
      setLoading(false);
    }
  }, [datePreset, dateFrom, dateTo, transactionType, locationId, workerId, status, page, handleRedirect]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function resetFilters() {
    setDatePreset("");
    setDateFrom("");
    setDateTo("");
    setTransactionType("");
    setLocationId("");
    setLocationName("");
    setWorkerId("");
    setWorkerName("");
    setStatus("");
    setPage(1);
  }

  function handleExportCSV() {
    if (records.length === 0) return;
    const headers = [
      "Date & Time",
      "Business Date",
      "Location",
      "Worker",
      "Type",
      "Amount",
      "Status",
      "Notes",
    ];
    const rows = records.map((r) => [
      formatDateTime(r.date),
      formatDateTime(r.businessDate),
      r.locationName,
      r.workerName,
      r.type,
      String(r.amount),
      r.status,
      r.notes,
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `maacash-momo-history-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getTypeBadge(type: string) {
    switch (type) {
      case "Debts Collected": return <span className="badge badge-green">Debts Collected</span>;
      case "Customer deposit": return <span className="badge badge-green">Customer deposit</span>;
      case "Cash out": return <span className="badge badge-red">Cash out</span>;
      case "Airtime sold": return <span className="badge badge-blue">Airtime sold</span>;
      case "Additional cash received": return <span className="badge badge-brand">Additional cash</span>;
      case "Additional MoMo float received": return <span className="badge badge-brand">Additional float</span>;
      case "MoMo float increase": return <span className="badge badge-blue">Float increase</span>;
      case "MoMo float decrease": return <span className="badge badge-yellow">Float decrease</span>;
      case "Commission Earned": return <span className="badge badge-gold">Commission</span>;
      case "Business Expense": return <span className="badge badge-red">Expense</span>;
      case "Reconciliation Record": return <span className="badge badge-gray">Reconciliation</span>;
      default: return <span className="badge badge-gray">{type}</span>;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="MoMo Money & History"
        description="Debts collected, commission, expenses and reconciliation records across dates. Historical customer transaction totals remain readable."
        actions={
          <button onClick={handleExportCSV} className="btn btn-secondary" disabled={records.length === 0}>
            <Download size={15} aria-hidden /> Export CSV
          </button>
        }
      />

      {error && (
        <div role="alert" className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}

      {/* Summary - reconciles exactly with the filtered records */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard label="Debts Collected" amount={summary.totalDebtsCollected} tone="text-emerald-700" />
          <SummaryCard label="Commission" amount={summary.totalCommission} tone="text-emerald-700" />
          <SummaryCard label="Expenses" amount={summary.totalExpenses} tone="text-red-700" />
          <SummaryCard label="Historical customer deposits" amount={summary.totalCashIn} />
          <SummaryCard label="Historical cash out" amount={summary.totalCashOut} />
          <SummaryCard label="Historical airtime" amount={summary.totalAirtimeSold} />
          <SummaryCard
            label="Combined difference"
            amount={summary.totalDifference}
            tone={summary.totalDifference < 0 ? "text-red-700" : "text-emerald-700"}
          />
          <SummaryCard label="Shortage reports" count={summary.shortageCount} tone={summary.shortageCount > 0 ? "text-red-700" : "text-emerald-700"} />
          <SummaryCard label="Total reports" count={summary.recordCount} />
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

          {/* Status */}
          <div className="form-group">
            <label className="form-label">Account Status</label>
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="form-group">
            <SmartSearch
              label="Location"
              placeholder="Search by location name or code..."
              searchFn={searchLocations}
              onSelect={(opt) => { setLocationId(opt.id); setLocationName(opt.label); setPage(1); }}
              onClear={() => { setLocationId(""); setLocationName(""); setPage(1); }}
              selectedOption={locationId ? { id: locationId, label: locationName } : null}
              minQueryLength={2}
              debounceMs={200}
            />
          </div>
          <div className="form-group">
            <SmartSearch
              label="Worker"
              placeholder="Search worker by name or email..."
              searchFn={searchWorkers}
              onSelect={(opt) => { setWorkerId(opt.id); setWorkerName(opt.label); setPage(1); }}
              onClear={() => { setWorkerId(""); setWorkerName(""); setPage(1); }}
              selectedOption={workerId ? { id: workerId, label: workerName } : null}
              minQueryLength={2}
              debounceMs={200}
            />
          </div>
        </div>
      </div>

      <FilterChips
        chips={[
          ...(datePreset ? [{ key: "date", label: "Period", value: DATE_PRESETS.find((p) => p.value === datePreset)?.label ?? datePreset }] : []),
          ...(transactionType ? [{ key: "type", label: "Type", value: TYPE_OPTIONS.find((t) => t.value === transactionType)?.label ?? transactionType }] : []),
          ...(status ? [{ key: "status", label: "Status", value: status }] : []),
          ...(locationId ? [{ key: "location", label: "Location", value: locationName }] : []),
          ...(workerId ? [{ key: "worker", label: "Worker", value: workerName }] : []),
        ]}
        onRemove={(key) => {
          if (key === "date") { setDatePreset(""); setDateFrom(""); setDateTo(""); }
          if (key === "type") setTransactionType("");
          if (key === "status") setStatus("");
          if (key === "location") { setLocationId(""); setLocationName(""); }
          if (key === "worker") { setWorkerId(""); setWorkerName(""); }
          setPage(1);
        }}
        onReset={resetFilters}
      />

      {/* Records List */}
      <div className="card !p-0 overflow-hidden">
        {loading ? (
          <div className="p-4" role="status" aria-label="Loading records">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-9 w-full mb-3" />
            ))}
          </div>
        ) : records.length === 0 ? (
          <NoResults hint="No MoMo records match the active filters. Adjust or clear them to see more." />
        ) : (
          <>
            <div className="table-container">
              <table>
                <caption className="sr-only">MoMo transaction history</caption>
                <thead>
                  <tr>
                    <th scope="col">Date &amp; Time</th>
                    <th scope="col">Location</th>
                    <th scope="col">Worker</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col">Notes</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td className="text-sm whitespace-nowrap">{formatDateTime(r.date)}</td>
                      <td className="text-sm">{r.locationName}</td>
                      <td className="text-sm">{r.workerName}</td>
                      <td>{getTypeBadge(r.type)}</td>
                      <td className="num font-semibold">
                        {r.amount !== 0 ? (
                          <CediAmount amount={r.amount} showSign={r.type === "Reconciliation Record"} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${
                          r.status === "reviewed" ? "badge-green" :
                          r.status === "submitted" ? "badge-blue" :
                          r.status === "draft" ? "badge-yellow" : "badge-gray"
                        }`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="text-sm text-slate-600 max-w-xs truncate">{r.notes}</td>
                      <td className="text-sm whitespace-nowrap">
                        {(r.status === "submitted" || r.status === "reviewed") && (
                          <Link
                            href={`/admin/history/${r.dailyAccountId}/correct`}
                            className="text-brand-700 underline underline-offset-2 hover:text-brand-900"
                          >
                            Correct
                          </Link>
                        )}
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

function SummaryCard({ label, amount, count, tone = "text-slate-900" }: { label: string; amount?: number; count?: number; tone?: string }) {
  return (
    <div className="card !p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={"text-base font-bold mt-0.5 tnum " + tone}>
        {count != null ? count : <CediAmount amount={amount ?? 0} />}
      </p>
    </div>
  );
}
