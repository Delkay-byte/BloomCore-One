"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import {
  getAccountLedgerView,
  recordMomoTransaction,
  reverseMomoTransaction,
  enableLedgerMode,
  disableLedgerMode,
  applyOpeningCarryForward,
  type AccountLedgerView,
} from "@/lib/actions/momo-ledger.actions";
import {
  MOMO_NETWORKS,
  MOMO_NETWORK_LABELS,
  MOMO_TRANSACTION_TYPES,
  MOMO_TRANSACTION_DEFINITIONS,
  type LedgerSummary,
} from "@/lib/momo-ledger";

const TYPE_OPTIONS = MOMO_TRANSACTION_TYPES.map((type) => ({
  value: type,
  label: MOMO_TRANSACTION_DEFINITIONS[type].label,
}));

const SOURCE_LABEL: Record<string, string> = {
  carried: "Carried from the last reviewed close",
  manual_adjusted: "Manually adjusted opening",
  manual: "Entered manually",
};

function localDateTimeValue(businessDate: string): string {
  const date = businessDate.slice(0, 10);
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${date}T${hh}:${mm}`;
}

function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function MomoLedgerPanel({
  accountId,
  status,
  onSummaryChange,
  onAccountUpdated,
}: {
  accountId: string;
  status: string;
  onSummaryChange?: (summary: LedgerSummary | null) => void;
  onAccountUpdated?: () => void;
}) {
  const [view, setView] = useState<AccountLedgerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [type, setType] = useState("cash_in");
  const [network, setNetwork] = useState("mtn");
  const [amount, setAmount] = useState("");
  const [commissionAmount, setCommissionAmount] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [reference, setReference] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [note, setNote] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newKey());

  const [reverseFor, setReverseFor] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  const draft = status === "draft";
  const isLedger = view?.ledgerMode === "ledger";

  const load = useCallback(async () => {
    try {
      const loaded = await getAccountLedgerView(accountId);
      setView(loaded);
      onSummaryChange?.(loaded?.summary ?? null);
      if (loaded?.businessDate) {
        setOccurredAt((current) => current || localDateTimeValue(loaded.businessDate));
      }
    } catch {
      setError("The transaction ledger could not be loaded.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const definition = useMemo(
    () => MOMO_TRANSACTION_DEFINITIONS[type as keyof typeof MOMO_TRANSACTION_DEFINITIONS],
    [type]
  );
  const commissionFieldRelevant = type !== "commission";

  async function handleRecord() {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await recordMomoTransaction(accountId, {
        type,
        network,
        amount: Number(amount),
        commissionAmount: commissionFieldRelevant ? Number(commissionAmount || 0) : 0,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : "",
        reference: reference.trim(),
        externalReference: externalReference.trim() || null,
        note: note.trim() || undefined,
        idempotencyKey,
      });
      if (!result.success) {
        setError(result.error ?? "The transaction could not be recorded.");
        return;
      }
      const data = result.data as { duplicate?: boolean } | undefined;
      setSuccess(
        data?.duplicate
          ? "This transaction was already recorded. Nothing was duplicated."
          : "Transaction recorded as a manually captured entry."
      );
      setAmount("");
      setCommissionAmount("");
      setReference("");
      setExternalReference("");
      setNote("");
      setIdempotencyKey(newKey());
      await load();
    } catch {
      setError("The transaction could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReverse() {
    if (!reverseFor || busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await reverseMomoTransaction({
        transactionId: reverseFor,
        reason: reverseReason,
      });
      if (!result.success) {
        setError(result.error ?? "The reversal could not be recorded.");
        return;
      }
      setSuccess("Reversal recorded. The original entry is preserved in history.");
      setReverseFor(null);
      setReverseReason("");
      await load();
    } catch {
      setError("The reversal could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLedgerMode(enable: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = enable ? await enableLedgerMode(accountId) : await disableLedgerMode(accountId);
      if (!result.success) {
        setError(result.error ?? "The day could not be switched.");
        return;
      }
      await load();
      onAccountUpdated?.();
    } catch {
      setError("The day could not be switched.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCarry() {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await applyOpeningCarryForward(accountId);
      if (!result.success) {
        setError(result.error ?? "The opening could not be carried forward.");
        return;
      }
      setSuccess("Opening balances carried from the last reviewed close.");
      await load();
      onAccountUpdated?.();
    } catch {
      setError("The opening could not be carried forward.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        Loading the operational ledger…
      </div>
    );
  }
  if (!view) return null;

  if (!isLedger) {
    if (!draft) return null;
    return (
      <section className="overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-[var(--shadow-card)]">
        <div className="border-b border-sky-100 bg-sky-50 px-4 py-3 sm:px-5">
          <p className="text-[11px] font-bold tracking-[0.14em] text-sky-700">
            OPERATIONAL LEDGER
          </p>
          <h2 className="text-base font-bold text-slate-900">
            Record transactions, not just totals
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Switch this day to the transaction ledger to capture each MoMo
            transaction as it happens. Customer deposits, cash-outs and airtime
            never count as business revenue; only commission, debts collected,
            other approved income and expenses drive the closing figure.
          </p>
        </div>
        <div className="p-4 sm:p-5">
          <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            Cutover is explicit. This day&apos;s current manual figures are empty,
            so nothing is discarded. Historical days and their totals are never
            rewritten or turned into invented transactions.
          </p>
          {error && <Notice type="error" message={error} className="mt-3 text-sm" />}
          <button
            type="button"
            onClick={() => handleLedgerMode(true)}
            disabled={busy}
            className="btn btn-primary mt-3"
          >
            <Link2 size={15} aria-hidden /> Use the transaction ledger for this day
          </button>
        </div>
      </section>
    );
  }

  const summary = view.summary;

  return (
    <section className="overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-sky-100 bg-sky-50 px-4 py-3 sm:px-5">
        <div>
          <p className="text-[11px] font-bold tracking-[0.14em] text-sky-700">
            OPERATIONAL LEDGER
          </p>
          <h2 className="text-base font-bold text-slate-900">Today&apos;s transactions</h2>
          <p className="mt-1 text-sm text-slate-600">
            Manually recorded by the operator. These entries are not
            provider-verified.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-sky-200 bg-white px-2.5 py-1 text-xs font-semibold text-sky-800">
            Source: {SOURCE_LABEL[view.openingBalanceSource] ?? view.openingBalanceSource}
          </span>
          {draft && (
            <button
              type="button"
              onClick={() => handleLedgerMode(false)}
              disabled={busy || summary.entryCount > 0}
              className="btn btn-secondary btn-sm"
              title={
                summary.entryCount > 0
                  ? "Entries exist, so the day stays on the ledger to preserve history."
                  : "Switch back to the manual closing form."
              }
            >
              Use manual form
            </button>
          )}
        </div>
      </div>

      {error && <Notice type="error" message={error} className="m-4 text-sm" />}
      {success && <Notice type="success" message={success} className="m-4 text-sm" />}

      {view.carryForward.available &&
        view.openingBalanceSource !== "carried" &&
        draft &&
        Number(view.projection.openingCash) === 0 &&
        Number(view.projection.openingFloat) === 0 && (
          <div className="mx-4 mt-4 rounded-xl border border-indigo-200 bg-indigo-50/70 px-3 py-2.5 text-sm text-indigo-950 sm:mx-5">
            <p className="font-semibold">A verified opening position is available</p>
            <p className="mt-0.5 text-indigo-900">
              The previous reviewed close was{" "}
              <CediAmount amount={Number(view.carryForward.openingCash ?? 0)} /> cash and{" "}
              <CediAmount amount={Number(view.carryForward.openingMomoFloat ?? 0)} /> E-cash.
            </p>
            <button
              type="button"
              onClick={handleCarry}
              disabled={busy}
              className="btn btn-secondary btn-sm mt-2"
            >
              Carry it forward
            </button>
          </div>
        )}

      <div className="grid gap-2 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
        <Metric label="Principal transactions" value={`${summary.principalCount}`} />
        <Metric label="Cash in / out (principal)" text={`${summary.cashIn.toFixed(2)} / ${summary.cashOut.toFixed(2)}`} />
        <Metric label="Commission" amount={summary.commission} tone="positive" />
        <Metric label="Expenses" amount={summary.expenses} tone="negative" />
        <Metric label="Debts collected" amount={summary.debtsCollected} tone="positive" />
        <Metric label="Other approved income" amount={summary.otherIncome} tone="positive" />
        <Metric label="Projected physical cash" amount={view.projection.projectedCash} />
        <Metric label="Projected E-cash" amount={view.projection.projectedFloat} />
      </div>

      <p className="mx-4 -mt-1 mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:mx-5">
        {view.commissionSourceNote} Projected balances are what the recorded
        entries imply; the counted closing figures you enter remain the
        reconciliation input.
      </p>

      {draft && (
        <div className="border-t border-slate-100 p-4 sm:p-5">
          <h3 className="text-sm font-bold text-slate-900">Record a transaction</h3>
          <p className="mt-0.5 text-xs text-slate-500">{definition?.help}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-700">
              Transaction type
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
                className="mt-1 w-full"
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Network
              <select
                value={network}
                onChange={(event) => setNetwork(event.target.value)}
                className="mt-1 w-full"
              >
                {MOMO_NETWORKS.map((option) => (
                  <option key={option} value={option}>
                    {MOMO_NETWORK_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Amount (GH₵)
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                className="mt-1 w-full"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Commission earned on this transaction (optional)
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={commissionAmount}
                onChange={(event) => setCommissionAmount(event.target.value)}
                placeholder="0.00"
                disabled={!commissionFieldRelevant}
                className="mt-1 w-full"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Time of transaction
              <input
                type="datetime-local"
                value={occurredAt}
                onChange={(event) => setOccurredAt(event.target.value)}
                className="mt-1 w-full"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Business reference (unique)
              <input
                type="text"
                maxLength={64}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="For example MM-0042"
                className="mt-1 w-full"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Provider reference (optional)
              <input
                type="text"
                maxLength={64}
                value={externalReference}
                onChange={(event) => setExternalReference(event.target.value)}
                placeholder="Only if the provider gave you one"
                className="mt-1 w-full"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              Note (optional)
              <input
                type="text"
                maxLength={300}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="mt-1 w-full"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={handleRecord}
            disabled={busy}
            className="btn btn-primary mt-3"
          >
            <Plus size={15} aria-hidden /> {busy ? "Recording…" : "Record transaction"}
          </button>
          {summary.commissionBasis === "per_transaction" && (
            <p className="mt-2 text-xs text-amber-800">
              Commission is currently summed from per-transaction amounts. If you
              later record a day-total commission entry, switch to that one source
              and reverse the per-transaction amounts so nothing is counted twice.
            </p>
          )}
        </div>
      )}

      <div className="border-t border-slate-100 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-slate-900">
            Entries ({view.entries.length})
          </h3>
          <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm">
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
        </div>
        {view.entries.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-500">
            No transactions recorded for this day yet.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Network</th>
                  <th>Amount</th>
                  <th>Commission</th>
                  <th>Reference</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap text-xs">
                      {new Date(entry.occurredAt).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="text-xs font-medium">{entry.typeLabel}</td>
                    <td className="text-xs">{entry.networkLabel}</td>
                    <td className="tnum text-xs">
                      <CediAmount amount={entry.amount} />
                    </td>
                    <td className="tnum text-xs">
                      <CediAmount amount={entry.commissionAmount} />
                    </td>
                    <td className="text-xs">
                      {entry.reference}
                      {entry.correctsTransactionId && (
                        <span className="ml-1 text-[10px] font-semibold text-amber-700">
                          corrected
                        </span>
                      )}
                    </td>
                    <td className="text-xs">
                      <StatusBadge status={entry.status} />
                    </td>
                    <td className="text-right">
                      {draft && entry.status === "recorded" && (
                        <button
                          type="button"
                          onClick={() => {
                            setReverseFor(entry.id);
                            setReverseReason("");
                            setError("");
                          }}
                          className="text-xs font-semibold text-red-700 hover:underline"
                        >
                          Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {reverseFor && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-semibold text-red-900">Reverse this transaction</p>
            <p className="mt-0.5 text-xs text-red-800">
              The original row is preserved and marked reversed. A separate
              reversal entry is added, so history is never overwritten.
            </p>
            <textarea
              rows={2}
              maxLength={500}
              value={reverseReason}
              onChange={(event) => setReverseReason(event.target.value)}
              placeholder="Explain why this transaction is being reversed (at least 10 characters)."
              className="mt-2 w-full"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={handleReverse}
                disabled={busy || reverseReason.trim().length < 10}
                className="btn btn-primary btn-sm"
              >
                <Undo2 size={14} aria-hidden /> Record reversal
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
      </div>

      <p className="flex items-start gap-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-500 sm:px-5">
        <AlertTriangle size={14} className="mt-0.5 flex-none text-amber-600" aria-hidden />
        Principal customer transactions are operational records only. They are
        not revenue, profit or provider-verified balances.
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  text,
  amount,
  tone,
}: {
  label: string;
  value?: string;
  text?: string;
  amount?: number;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
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
        {amount !== undefined ? <CediAmount amount={amount} /> : text ?? value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === "recorded"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "reversal"
        ? "border-slate-300 bg-slate-100 text-slate-700"
        : "border-amber-200 bg-amber-50 text-amber-800";
  const label =
    status === "recorded"
      ? "Recorded"
      : status === "reversed"
        ? "Reversed"
        : status === "corrected"
          ? "Corrected"
          : "Reversal entry";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes}`}>
      {status === "recorded" ? <CheckCircle2 size={11} aria-hidden /> : null}
      {label}
    </span>
  );
}
