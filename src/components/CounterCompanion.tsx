"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Smartphone } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { getOfflineScope } from "@/lib/offline/scope";
import { addTransaction, getAllTransactions, type OfflineTransaction } from "@/lib/offline/store";
import { OfflineLockedError } from "@/lib/offline/unlock";
import {
  COUNTER_FLOWS,
  COUNTER_STATUS_LABELS,
  buildCounterCapture,
  counterConfirmationLine,
  type CounterCapture,
} from "@/lib/counter-companion";
import { MOMO_OFFLINE_NETWORKS, MOMO_OFFLINE_NETWORK_LABELS } from "@/lib/offline/momo-draft";

/**
 * Counter Companion: one transaction, four taps, no false claims.
 *
 * A companion entry is stored on the device as a MoMo activity and travels the same
 * path as any other offline capture: it is sent to the business record when the
 * connection returns, reviewed where it conflicts, and matched against an imported
 * provider statement when one exists. The panel never asks for a PIN, never reads a
 * message, and never says the network confirmed anything.
 */
export default function CounterCompanion({
  userId,
  deviceId,
  locationId,
  onCaptured,
}: {
  userId: string;
  deviceId: string;
  locationId: string | null;
  onCaptured?: () => void;
}) {
  const [flow, setFlow] = useState<string>("cash_in");
  const [network, setNetwork] = useState<string>("mtn");
  const [customerNumber, setCustomerNumber] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recent, setRecent] = useState<CounterCapture[]>([]);
  const [pending, setPending] = useState(0);

  const refreshPending = useCallback(async () => {
    try {
      const rows = await getAllTransactions();
      setPending(rows.filter((row) => row.type === "momo_draft" && row.status !== "synced").length);
    } catch {
      setPending(0);
    }
  }, []);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  async function save() {
    setError("");
    setNotice("");
    if (!locationId) {
      setError("You are not assigned to a branch, so a counter entry cannot be saved.");
      return;
    }
    const built = buildCounterCapture({
      flow,
      network,
      customerNumber: customerNumber || null,
      customerNumberConfirmed: confirmed,
      amount: Number(amount),
      reference: reference || null,
      evidenceRef: evidenceRef || null,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }

    setBusy(true);
    try {
      const scope = await getOfflineScope().catch(() => null);
      const tx: OfflineTransaction = {
        id: crypto.randomUUID(),
        deviceId,
        tenantId: scope?.tenantId,
        userId,
        type: "momo_draft",
        idempotencyKey: crypto.randomUUID(),
        payload: JSON.stringify({
          // A companion entry is one activity of the day. It is sent as an activity
          // capture, not as a daily account, and the figures stay empty until the
          // agent completes the day.
          businessDate: new Date().toISOString().slice(0, 10),
          locationId,
          openingCash: 0,
          openingFloat: 0,
          closingCash: 0,
          closingFloat: 0,
          captureSource: "device",
          note: "Activity captured with Counter Companion; the day's opening and closing figures have not been captured yet.",
          activities: [
            {
              kind: built.capture.flow,
              network: built.capture.network,
              amount: built.capture.amountMinor / 100,
              reference: built.capture.reference,
              note: null,
              evidenceRef: built.capture.evidenceRef,
            },
          ],
        }),
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
      setNotice(counterConfirmationLine(built.capture));
      setRecent((rows) => [built.capture, ...rows].slice(0, 5));
      setAmount("");
      setReference("");
      setEvidenceRef("");
      setCustomerNumber("");
      setConfirmed(false);
      await refreshPending();
      onCaptured?.();
    } catch (err) {
      if (err instanceof OfflineLockedError) {
        setError("The offline workspace is locked. Unlock it above, then capture again.");
      } else {
        setError("This device could not save the entry. Keep the page open and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const needsCustomer = flow === "cash_in" || flow === "cash_out";

  return (
    <section
      className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm"
      data-testid="counter-companion"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <Smartphone size={15} aria-hidden /> Counter Companion
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">
            Record one counter transaction in a few taps. It is saved on this device,
            sent to your business record when you reconnect, and matched when a provider
            statement is imported.
          </p>
        </div>
        {pending > 0 ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
            {pending} waiting to send
          </span>
        ) : null}
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {notice && <Notice type="success">{notice}</Notice>}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-700">
          What are you recording?
          <select
            className="input mt-1 w-full text-sm"
            value={flow}
            onChange={(event) => setFlow(event.target.value)}
            data-testid="counter-flow"
          >
            {COUNTER_FLOWS.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Network
          <select
            className="input mt-1 w-full text-sm"
            value={network}
            onChange={(event) => setNetwork(event.target.value)}
            data-testid="counter-network"
          >
            {MOMO_OFFLINE_NETWORKS.map((row) => (
              <option key={row} value={row}>
                {MOMO_OFFLINE_NETWORK_LABELS[row]}
              </option>
            ))}
          </select>
        </label>

        {needsCustomer && (
          <>
            <label className="text-xs font-medium text-slate-700">
              Customer number
              <input
                className="input mt-1 w-full text-sm"
                inputMode="tel"
                placeholder="0XXXXXXXXX"
                value={customerNumber}
                onChange={(event) => {
                  setCustomerNumber(event.target.value);
                  setConfirmed(false);
                }}
                data-testid="counter-customer"
              />
            </label>
            <label className="flex items-start gap-2 self-end rounded-lg bg-slate-50 px-2 py-2 text-xs text-slate-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                data-testid="counter-confirm"
              />
              <span>I read the number back to the customer and it is correct.</span>
            </label>
          </>
        )}

        <label className="text-xs font-medium text-slate-700">
          Amount (GH₵)
          <input
            className="input mt-1 w-full text-sm"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            data-testid="counter-amount"
          />
        </label>
        <label className="text-xs font-medium text-slate-700">
          Network reference (optional)
          <input
            className="input mt-1 w-full text-sm"
            placeholder="From the network's own confirmation"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            data-testid="counter-reference"
          />
        </label>
        <label className="text-xs font-medium text-slate-700">
          Evidence reference (optional)
          <input
            className="input mt-1 w-full text-sm"
            placeholder="Photo or note kept on this device"
            value={evidenceRef}
            onChange={(event) => setEvidenceRef(event.target.value)}
          />
        </label>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-sm mt-3"
        disabled={busy}
        onClick={() => void save()}
        data-testid="counter-save"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        Save entry
      </button>

      <p className="mt-2 text-[11px] text-slate-500">
        MaaCash never needs a MoMo PIN. Do not type one here: the field refuses it.
        Nothing on this screen contacts a network on your behalf.
      </p>

      {recent.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" data-testid="counter-recent">
          {recent.map((capture, index) => (
            <li
              key={`${capture.network}-${index}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2"
            >
              <span className="text-slate-700">
                GH₵{(capture.amountMinor / 100).toFixed(2)} ·{" "}
                {capture.network === "at_money" ? "AT Money" : capture.network.toUpperCase()}
                {capture.customerNumberMasked ? ` · ${capture.customerNumberMasked}` : ""}
              </span>
              <span className="text-slate-500">{COUNTER_STATUS_LABELS[capture.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
