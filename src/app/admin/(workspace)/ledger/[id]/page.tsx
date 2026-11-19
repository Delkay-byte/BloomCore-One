"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, History, Save } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import ReauthDialog from "@/components/ReauthDialog";
import {
  correctMomoTransaction,
  getLedgerEntry,
  type LedgerEntryView,
} from "@/lib/actions/momo-ledger.actions";
import { MOMO_NETWORKS, MOMO_NETWORK_LABELS } from "@/lib/momo-ledger";

function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function localInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export default function LedgerEntryPage() {
  const [entry, setEntry] = useState<LedgerEntryView | null>(null);
  const [history, setHistory] = useState<LedgerEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reauthOpen, setReauthOpen] = useState(false);

  const [amount, setAmount] = useState("");
  const [commissionAmount, setCommissionAmount] = useState("");
  const [network, setNetwork] = useState("unassigned");
  const [occurredAt, setOccurredAt] = useState("");
  const [reference, setReference] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newKey());

  const load = useCallback(async () => {
    const id = window.location.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      const result = await getLedgerEntry(id);
      if (!result) {
        setError("Transaction not found.");
        return;
      }
      setEntry(result.entry);
      setHistory(result.history);
      setAmount(String(result.entry.amount));
      setCommissionAmount(String(result.entry.commissionAmount));
      setNetwork(result.entry.network);
      setOccurredAt(localInput(result.entry.occurredAt));
      setReference(`${result.entry.reference}-C`);
      setExternalReference(result.entry.externalReference ?? "");
      setNote(result.entry.note ?? "");
    } catch {
      setError("The transaction could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitCorrection(token: string) {
    if (!entry) return;
    const result = await correctMomoTransaction({
      transactionId: entry.id,
      amount: Number(amount),
      commissionAmount: Number(commissionAmount || 0),
      network,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : "",
      reference: reference.trim(),
      externalReference: externalReference.trim() || null,
      note: note.trim() || undefined,
      reason,
      idempotencyKey,
      stepUpToken: token,
    });
    if (!result.success) {
      setError(result.error ?? "The correction could not be recorded.");
      setReauthOpen(false);
      return;
    }
    setSuccess("Correction recorded. The original row is preserved and marked corrected.");
    setReauthOpen(false);
    setIdempotencyKey(newKey());
    setReason("");
    await load();
  }

  if (loading) return <p className="p-6 text-sm text-slate-500">Loading transaction…</p>;
  if (!entry) {
    return (
      <div className="space-y-3">
        <Link href="/admin/ledger" className="text-sm text-slate-500 hover:underline">
          ← Back to the ledger
        </Link>
        <Notice type="error" message={error || "Transaction not found."} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Link href="/admin/ledger" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} aria-hidden /> Back to the ledger
      </Link>

      <div>
        <h1 className="text-2xl font-bold text-slate-900">Transaction {entry.reference}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Operator-recorded entry. Not provider-verified.
        </p>
      </div>

      {error && <Notice type="error" message={error} />}
      {success && <Notice type="success" message={success} />}

      <div className="card p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Detail label="Type" value={entry.typeLabel} />
          <Detail label="Network" value={entry.networkLabel} />
          <Detail label="Status" value={entry.status} />
          <Detail label="Amount" value={<CediAmount amount={entry.amount} />} />
          <Detail label="Commission" value={<CediAmount amount={entry.commissionAmount} />} />
          <Detail label="Direction" value={entry.direction} />
          <Detail label="Business date" value={entry.businessDate.slice(0, 10)} />
          <Detail
            label="Recorded at"
            value={new Date(entry.occurredAt).toLocaleString("en-GB")}
          />
          <Detail label="Recorded by" value={entry.recordedByName ?? entry.recordedById} />
          <Detail label="Location" value={entry.locationName ?? "—"} />
          <Detail label="Provider reference" value={entry.externalReference ?? "—"} />
          <Detail label="Recording source" value={entry.recordingSource} />
        </div>
        {entry.note && <p className="mt-3 text-sm text-slate-600">Note: {entry.note}</p>}
        {entry.correctionReason && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Reason on record: {entry.correctionReason}
          </p>
        )}
      </div>

      {entry.status === "recorded" && (
        <div className="card p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <Save size={15} aria-hidden /> Correct this transaction
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            A correction appends a new row and marks this one as corrected. Both
            rows stay in history. Give the corrected row a new business reference.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-700">
              Amount (GH₵)
              <input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Commission (GH₵)
              <input type="number" step="0.01" min="0" value={commissionAmount} onChange={(e) => setCommissionAmount(e.target.value)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Network
              <select value={network} onChange={(e) => setNetwork(e.target.value)} className="mt-1 w-full">
                {MOMO_NETWORKS.map((value) => (
                  <option key={value} value={value}>{MOMO_NETWORK_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Transaction time
              <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              New business reference
              <input type="text" maxLength={64} value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Provider reference (optional)
              <input type="text" maxLength={64} value={externalReference} onChange={(e) => setExternalReference(e.target.value)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-700 sm:col-span-2">
              Note
              <input type="text" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-700 sm:col-span-2">
              Correction reason (required)
              <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full" />
            </label>
          </div>
          <button
            type="button"
            onClick={() => setReauthOpen(true)}
            disabled={reason.trim().length < 10}
            className="btn btn-primary mt-3"
          >
            Record correction
          </button>
        </div>
      )}

      <div className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <History size={15} aria-hidden /> Posting history
        </h2>
        <div className="mt-2 overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Reference</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td className="text-xs">{new Date(row.createdAt).toLocaleString("en-GB")}</td>
                  <td className="text-xs">{row.reference}</td>
                  <td className="text-xs">{row.typeLabel}</td>
                  <td className="tnum text-xs"><CediAmount amount={row.amount} /></td>
                  <td className="text-xs capitalize">{row.status}</td>
                  <td className="text-xs">
                    {row.correctsTransactionId ? "correction of original" : row.reversesTransactionId ? "reversal entry" : "original"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ReauthDialog
        open={reauthOpen}
        onClose={() => setReauthOpen(false)}
        onConfirmed={(token) => void submitCorrection(token)}
        title="Confirm the correction"
        description="Enter your administrator password to authorise this financial correction."
        actionLabel="Record correction"
        module="admin"
        purpose="finance.momo_transaction.reverse"
        targetType="momoTransaction"
        targetId={entry.id}
        context={{ amountMinor: Math.round(entry.amount * 100) }}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold capitalize text-slate-900">{value}</p>
    </div>
  );
}
