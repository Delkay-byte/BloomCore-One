"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Download,
  RefreshCw,
  Undo2,
  BookText,
} from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import ReauthDialog from "@/components/ReauthDialog";
import {
  getAdminLedgerView,
  reverseMomoTransaction,
  type LedgerEntryView,
} from "@/lib/actions/momo-ledger.actions";
import {
  MOMO_NETWORKS,
  MOMO_NETWORK_LABELS,
  MOMO_TRANSACTION_TYPES,
  MOMO_TRANSACTION_DEFINITIONS,
  type LedgerSummary,
} from "@/lib/momo-ledger";

interface FilterOptions {
  locations: Array<{ id: string; name: string; code: string }>;
  workers: Array<{ id: string; fullName: string; role: string }>;
}

export default function AdminLedgerPage() {
  const [entries, setEntries] = useState<LedgerEntryView[]>([]);
  const [summary, setSummary] = useState<LedgerSummary | null>(null);
  const [options, setOptions] = useState<FilterOptions>({ locations: [], workers: [] });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [locationId, setLocationId] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [type, setType] = useState("");
  const [network, setNetwork] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [reverseFor, setReverseFor] = useState<LedgerEntryView | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reauthOpen, setReauthOpen] = useState(false);

  const filters = useMemo(
    () => ({
      locationId: locationId || undefined,
      workerId: workerId || undefined,
      type: type || undefined,
      network: network || undefined,
      status: status || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      page,
      limit,
    }),
    [locationId, workerId, type, network, status, dateFrom, dateTo, page, limit]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getAdminLedgerView(filters);
      setEntries(result.entries);
      setSummary(result.summary);
      setOptions(result.filters);
      setTotal(result.total);
    } catch {
      setError("The ledger could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  async function submitReversal(token: string) {
    if (!reverseFor) return;
    const result = await reverseMomoTransaction({
      transactionId: reverseFor.id,
      reason: reverseReason,
      stepUpToken: token,
    });
    if (!result.success) {
      setError(result.error ?? "The reversal could not be recorded.");
      return;
    }
    setSuccess("Reversal recorded. The original entry is preserved.");
    setReverseFor(null);
    setReverseReason("");
    setReauthOpen(false);
    await load();
  }

  const exportQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (key === "page" || key === "limit") continue;
      if (value != null && value !== "") params.set(key, String(value));
    }
    return params.toString();
  }, [filters]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">MoMo transaction ledger</h1>
          <p className="mt-1 text-sm text-slate-600">
            Operator-recorded operational entries. These records are manually
            captured and are not provider-verified statements.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/history" className="btn btn-secondary">
            <BookText size={15} aria-hidden /> Money &amp; History
          </Link>
          <a
            href={`/api/admin/ledger/export${exportQuery ? `?${exportQuery}` : ""}`}
            className="btn btn-secondary"
          >
            <Download size={15} aria-hidden /> Export CSV
          </a>
        </div>
      </div>

      {error && <Notice type="error" message={error} />}
      {success && <Notice type="success" message={success} />}

      <div className="card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Filter label="Location">
            <select value={locationId} onChange={(e) => { setPage(1); setLocationId(e.target.value); }}>
              <option value="">All locations</option>
              {options.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} ({location.code})
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Employee">
            <select value={workerId} onChange={(e) => { setPage(1); setWorkerId(e.target.value); }}>
              <option value="">All employees</option>
              {options.workers.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.fullName} ({worker.role})
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Transaction type">
            <select value={type} onChange={(e) => { setPage(1); setType(e.target.value); }}>
              <option value="">All types</option>
              {MOMO_TRANSACTION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {MOMO_TRANSACTION_DEFINITIONS[value].shortLabel}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Network">
            <select value={network} onChange={(e) => { setPage(1); setNetwork(e.target.value); }}>
              <option value="">All networks</option>
              {MOMO_NETWORKS.map((value) => (
                <option key={value} value={value}>
                  {MOMO_NETWORK_LABELS[value]}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Status">
            <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
              <option value="">All statuses</option>
              <option value="recorded">Recorded</option>
              <option value="reversed">Reversed</option>
              <option value="corrected">Corrected</option>
              <option value="reversal">Reversal entries</option>
            </select>
          </Filter>
          <Filter label="From">
            <input type="date" value={dateFrom} onChange={(e) => { setPage(1); setDateFrom(e.target.value); }} />
          </Filter>
          <Filter label="To">
            <input type="date" value={dateTo} onChange={(e) => { setPage(1); setDateTo(e.target.value); }} />
          </Filter>
          <div className="flex items-end">
            <button type="button" onClick={() => void load()} className="btn btn-secondary w-full">
              <RefreshCw size={15} aria-hidden /> Refresh
            </button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Commission (income)" amount={summary.commission} tone="positive" />
          <Metric label="Debts collected" amount={summary.debtsCollected} tone="positive" />
          <Metric label="Other income" amount={summary.otherIncome} tone="positive" />
          <Metric label="Expenses" amount={summary.expenses} tone="negative" />
          <Metric label="Cash movement" amount={summary.cashMovement} />
          <Metric label="Float movement" amount={summary.floatMovement} />
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-semibold text-slate-800">
            {total} transaction{total === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-slate-500">
            Commission is income. Deposits, cash-outs and airtime are operational
            movements, never revenue.
          </p>
        </div>
        {loading ? (
          <p className="p-6 text-sm text-slate-500">Loading transactions…</p>
        ) : entries.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            No transactions match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Location</th>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Network</th>
                  <th>Amount</th>
                  <th>Commission</th>
                  <th>Reference</th>
                  <th>Verification</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap text-xs">
                      {entry.businessDate.slice(0, 10)}
                      <span className="block text-slate-500">
                        {new Date(entry.occurredAt).toLocaleTimeString("en-GB", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </td>
                    <td className="text-xs">{entry.locationName}</td>
                    <td className="text-xs">{entry.workerName}</td>
                    <td className="text-xs font-medium">{entry.typeLabel}</td>
                    <td className="text-xs">{entry.networkLabel}</td>
                    <td className="tnum text-xs"><CediAmount amount={entry.amount} /></td>
                    <td className="tnum text-xs"><CediAmount amount={entry.commissionAmount} /></td>
                    <td className="text-xs">
                      <Link href={`/admin/ledger/${entry.id}`} className="font-semibold text-brand-700 hover:underline">
                        {entry.reference}
                      </Link>
                      {entry.correctsTransactionId && (
                        <span className="ml-1 text-[10px] text-amber-700">corrected</span>
                      )}
                    </td>
                    <td className="text-xs">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          entry.verificationStatus === "provider_confirmed"
                            ? "bg-emerald-100 text-emerald-800"
                            : entry.verificationStatus === "disputed"
                              ? "bg-red-100 text-red-800"
                              : entry.verificationStatus === "statement_imported"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {entry.verificationLabel}
                      </span>
                      {entry.supportingEvidence && (
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Evidence: {entry.supportingEvidence}
                        </span>
                      )}
                    </td>
                    <td className="text-xs capitalize">{entry.status}</td>
                    <td className="text-right">
                      {entry.status === "recorded" && (
                        <button
                          type="button"
                          onClick={() => {
                            setReverseFor(entry);
                            setReverseReason("");
                            setError("");
                          }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:underline"
                        >
                          <Undo2 size={13} aria-hidden /> Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1}
            className="btn btn-secondary btn-sm"
          >
            Previous
          </button>
          <p className="text-xs text-slate-500">
            Page {page} of {totalPages}
          </p>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages}
            className="btn btn-secondary btn-sm"
          >
            Next
          </button>
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
        <AlertTriangle size={14} className="mt-0.5 flex-none" aria-hidden />
        Manual records. No telco or aggregator connection is configured, so this
        ledger never claims a real-time provider balance or confirmation.
      </p>

      {reverseFor && (
        <div className="card border-red-200 p-4">
          <h2 className="text-sm font-bold text-red-900">
            Reverse {reverseFor.reference}
          </h2>
          <p className="mt-1 text-xs text-red-800">
            The original row stays in history and is marked reversed. A separate
            reversal entry is appended. This cannot silently rewrite the posting.
          </p>
          <textarea
            rows={3}
            maxLength={500}
            value={reverseReason}
            onChange={(event) => setReverseReason(event.target.value)}
            placeholder="Explain why this transaction is being reversed (at least 10 characters)."
            className="mt-2 w-full"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setReauthOpen(true)}
              disabled={reverseReason.trim().length < 10}
              className="btn btn-primary btn-sm"
            >
              Confirm reversal
            </button>
            <button
              type="button"
              onClick={() => setReverseFor(null)}
              className="btn btn-secondary btn-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ReauthDialog
        open={reauthOpen}
        onClose={() => setReauthOpen(false)}
        onConfirmed={(token) => void submitReversal(token)}
        title="Confirm the reversal"
        description="Enter your administrator password to authorise this financial correction."
        actionLabel="Reverse transaction"
        module="admin"
        purpose="finance.momo_transaction.reverse"
        targetType="momoTransaction"
        targetId={reverseFor?.id}
        context={
          reverseFor
            ? { amountMinor: Math.round(reverseFor.amount * 100) }
            : undefined
        }
      />
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-slate-700">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Metric({
  label,
  amount,
  tone,
}: {
  label: string;
  amount: number;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p
        className={`mt-1 text-base font-bold tnum ${
          tone === "positive"
            ? "text-emerald-800"
            : tone === "negative"
              ? "text-red-700"
              : "text-slate-900"
        }`}
      >
        <CediAmount amount={amount} />
      </p>
    </div>
  );
}
