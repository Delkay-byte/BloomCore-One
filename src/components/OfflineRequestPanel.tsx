"use client";

import { useEffect, useState } from "react";
import { Banknote, Landmark, Undo2 } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import {
  addTransaction,
  getCachedCustomers,
  type CachedCustomer,
  type OfflineTransaction,
} from "@/lib/offline/store";
import { OfflineLockedError } from "@/lib/offline/unlock";
import { OfflineStorageError } from "@/lib/errors/friendly";
import { getOfflineScope } from "@/lib/offline/scope";

type RequestKind = "withdrawal" | "remittance";

/**
 * Capture a withdrawal or a cash handover while the device is offline.
 *
 * Neither of these posts money. Each one queues a REQUEST that an administrator
 * authorises online, which is why the panel says so on every screen: the whole
 * point is that a collector never has to keep this work in a notebook.
 */
export default function OfflineRequestPanel({
  deviceId,
  userId,
  collectorId,
  onQueued,
}: {
  deviceId: string;
  userId: string;
  collectorId: string | null;
  onQueued: () => void;
}) {
  const [customers, setCustomers] = useState<CachedCustomer[]>([]);
  const [kind, setKind] = useState<RequestKind>("withdrawal");
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCachedCustomers()
      .then((rows) => {
        if (!cancelled) setCustomers(rows);
      })
      .catch(() => {
        if (!cancelled) setCustomers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function queue() {
    setError("");
    setSuccess("");
    setLocked(false);

    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (kind === "withdrawal" && !accountId) {
      setError("Choose the customer account.");
      return;
    }
    if (kind === "remittance" && !collectorId) {
      setError("Your collector record is not available on this device. Reconnect once, then retry.");
      return;
    }

    setBusy(true);
    try {
      const scope = await getOfflineScope().catch(() => null);
      const payload =
        kind === "withdrawal"
          ? { kind, accountId, amount: amountNum, notes: notes.trim() || undefined }
          : { kind, collectorId, amount: amountNum, notes: notes.trim() || undefined };

      const tx: OfflineTransaction = {
        id: crypto.randomUUID(),
        deviceId,
        tenantId: scope?.tenantId,
        userId,
        type: "offline_request",
        idempotencyKey: crypto.randomUUID(),
        payload: JSON.stringify(payload),
        status: "pending_sync",
        retryCount: 0,
        maxRetries: 5,
        failureReason: null,
        serverResult: null,
        localTimestamp: new Date().toISOString(),
        syncStartedAt: null,
        syncedAt: null,
        createdAt: new Date().toISOString(),
      };
      await addTransaction(tx);
      setSuccess(
        kind === "withdrawal"
          ? "Withdrawal request saved on this device. It is sent for approval when you reconnect, and no money has moved yet."
          : "Cash handover saved on this device. It is sent for approval when you reconnect, and no money has moved yet."
      );
      setAmount("");
      setNotes("");
      setAccountId("");
      onQueued();
    } catch (err) {
      if (err instanceof OfflineLockedError) {
        setLocked(true);
        setError(
          "The offline workspace locked before this could be saved. Unlock it and enter the request again."
        );
      } else if (err instanceof OfflineStorageError && err.code === "storage_full") {
        setError("This device has no space left for offline records. Synchronize, then try again.");
      } else {
        setError("This device could not save the request. Keep the page open and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3 p-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Landmark size={15} aria-hidden /> Request while offline
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          A withdrawal or a cash handover needs an administrator decision, so capturing one offline
          queues a request instead of moving money. Write it here, not in a notebook.
        </p>
      </div>

      {error && <Notice type="error" message={error}>{error}</Notice>}
      {success && <Notice type="success" message={success}>{success}</Notice>}
      {locked && (
        <p className="text-xs text-amber-900">
          Your saved records are not deleted. Unlock the offline workspace to keep capturing.
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { value: "withdrawal" as RequestKind, label: "Customer withdrawal" },
            { value: "remittance" as RequestKind, label: "Cash I am handing in" },
          ]
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setKind(option.value)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              kind === option.value
                ? "bg-brand-700 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {kind === "withdrawal" ? (
        <label className="block text-xs font-medium text-slate-600">
          Customer account
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="input mt-1 block w-full"
          >
            <option value="">
              {customers.length === 0
                ? "No customers saved on this device yet"
                : "Choose the account"}
            </option>
            {customers.map((customer) => (
              <option key={customer.accountId} value={customer.accountId}>
                {customer.customerName} · {customer.accountId}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          This records that you handed cash to the office. The office confirms the amount, so the
          ledger only changes when they authorise it.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-600">
          Amount
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input mt-1 block w-full"
            placeholder="0.00"
          />
          {amount && Number(amount) > 0 && (
            <span className="mt-1 block text-[11px] text-slate-500">
              <CediAmount amount={Number(amount)} />
            </span>
          )}
        </label>
        <label className="text-xs font-medium text-slate-600">
          Note (optional)
          <input
            type="text"
            maxLength={500}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="input mt-1 block w-full"
            placeholder="What was agreed with the customer"
          />
        </label>
      </div>

      <button
        type="button"
        onClick={() => void queue()}
        className="btn btn-primary btn-sm"
        disabled={busy}
        aria-busy={busy}
      >
        <Banknote size={14} aria-hidden />
        {busy ? "Saving…" : "Save request on this device"}
      </button>

      <p className="flex items-start gap-1.5 text-[11px] text-slate-500">
        <Undo2 size={12} className="mt-0.5 shrink-0" aria-hidden />
        To undo a record that already posted, use the reversal request on the record itself. A
        reversal is never applied offline.
      </p>
    </section>
  );
}
