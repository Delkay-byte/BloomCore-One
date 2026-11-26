"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudOff, Loader2, Plus, Trash2 } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { getOfflineScope } from "@/lib/offline/scope";
import {
  addTransaction,
  getAllTransactions,
  type OfflineTransaction,
} from "@/lib/offline/store";
import { OfflineLockedError } from "@/lib/offline/unlock";
import { getOrCreateDeviceId } from "@/lib/offline/device";
import { OfflineStorageError } from "@/lib/errors/friendly";
import {
  MOMO_OFFLINE_NETWORKS,
  MOMO_OFFLINE_NETWORK_LABELS,
  type MomoOfflineActivity,
} from "@/lib/offline/momo-draft";
import { getMyMomoDrafts, type MomoDraftView } from "@/lib/actions/momo-offline-draft.actions";

/**
 * Capture a MoMo day while the connection is gone.
 *
 * Two rules drive the whole panel:
 *   1. Nothing here posts money. The capture is stored on the device, then parked on
 *      the server so the day can be completed online through the normal daily account.
 *   2. The figures the agent sees are the figures the agent typed. Totals are shown for
 *      reading only, and a reference or a photo is labelled as what it is — a
 *      reference, not a provider confirmation.
 */

const ACTIVITY_KINDS: { value: MomoOfflineActivity["kind"]; label: string }[] = [
  { value: "cash_in", label: "Cash in (deposit)" },
  { value: "cash_out", label: "Cash out (withdrawal)" },
  { value: "commission", label: "Commission earned" },
  { value: "expense", label: "Expense paid" },
];

interface DraftLine {
  id: string;
  kind: MomoOfflineActivity["kind"];
  network: (typeof MOMO_OFFLINE_NETWORKS)[number];
  amount: string;
  reference: string;
  evidenceRef: string;
}

function newLine(): DraftLine {
  return {
    id: crypto.randomUUID(),
    kind: "cash_out",
    network: "mtn",
    amount: "",
    reference: "",
    evidenceRef: "",
  };
}

function money(value: number): string {
  return `GH₵${value.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function OfflineMomoCapture({
  locationId,
  userId,
}: {
  locationId: string | null;
  userId: string;
}) {
  const [open, setOpen] = useState(false);
  // The device is enrolled only when the agent actually opens a capture, so visiting the
  // dashboard never enrols a browser that will not do offline work.
  const [deviceId, setDeviceId] = useState("");
  const [businessDate, setBusinessDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openingCash, setOpeningCash] = useState("");
  const [openingFloat, setOpeningFloat] = useState("");
  const [closingCash, setClosingCash] = useState("");
  const [closingFloat, setClosingFloat] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [locked, setLocked] = useState(false);
  const [queued, setQueued] = useState<OfflineTransaction[]>([]);
  const [serverDrafts, setServerDrafts] = useState<MomoDraftView[]>([]);

  // The local queue is read on mount because it lives on the device. The server's view of
  // this agent's drafts is only asked for once the panel is opened, so a dashboard visit
  // does not make an unnecessary round trip.
  const refresh = useCallback(async (includeServer = false) => {
    try {
      const local = await getAllTransactions();
      setQueued(
        local.filter((tx) => tx.type === "momo_draft" && tx.status !== "synced")
      );
    } catch {
      // A device without an offline workspace simply shows nothing to resume.
    }
    if (includeServer) {
      const mine = await getMyMomoDrafts().catch(() => null);
      if (mine?.success && mine.data) setServerDrafts(mine.data);
    }
  }, []);

  // Nothing is read until the agent opens the panel: the device queue and the server's
  // view of drafts both cost a round trip, and a collapsed panel needs neither.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void refresh(true);
      if (deviceId) return;
      void getOrCreateDeviceId()
        .then((id) => setDeviceId(id))
        .catch(() => setDeviceId(""));
    }, 0);
    return () => clearTimeout(timer);
  }, [open, deviceId, refresh]);

  function totals() {
    const sum = (kind: MomoOfflineActivity["kind"]) =>
      lines
        .filter((line) => line.kind === kind)
        .reduce((total, line) => total + (Number(line.amount) || 0), 0);
    return {
      cashIn: sum("cash_in"),
      cashOut: sum("cash_out"),
      commission: sum("commission"),
      expense: sum("expense"),
    };
  }

  async function save() {
    setError("");
    setSuccess("");
    setLocked(false);
    if (!locationId) {
      setError("You are not assigned to a branch, so a day cannot be captured.");
      return;
    }
    const required = [openingCash, openingFloat, closingCash, closingFloat];
    if (required.some((value) => value.trim() === "")) {
      setError("Enter the opening and closing cash and float figures.");
      return;
    }

    const activities = lines
      .filter((line) => line.amount.trim() !== "")
      .map((line) => ({
        kind: line.kind,
        network: line.network,
        amount: Number(line.amount),
        reference: line.reference.trim() || null,
        note: null,
        evidenceRef: line.evidenceRef.trim() || null,
      }));

    const payload = {
      businessDate,
      locationId,
      openingCash: Number(openingCash),
      openingFloat: Number(openingFloat),
      closingCash: Number(closingCash),
      closingFloat: Number(closingFloat),
      captureSource: "device" as const,
      note: note.trim() || null,
      activities,
    };

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
        "Saved on this device. It is sent to MaaCash when you reconnect, and no money has been recorded or submitted yet."
      );
      setLines([newLine()]);
      setNote("");
      await refresh(true);
    } catch (err) {
      if (err instanceof OfflineLockedError) {
        setLocked(true);
        setError("The offline workspace locked before this could be saved. Unlock it and try again.");
      } else if (err instanceof OfflineStorageError) {
        setError("This device has no space left for offline records. Synchronize, then try again.");
      } else {
        setError("This device could not save the capture. Keep the page open and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const totals_ = totals();

  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm" data-testid="offline-momo">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <CloudOff size={15} aria-hidden /> Capture a MoMo day offline
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">
            Write the day down here when the network is down. It is stored on this device
            and sent to MaaCash when you reconnect, so you can finish the real daily
            account online. Nothing is posted, submitted or counted as money until you do.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? "Close" : "Capture now"}
        </button>
      </div>

      {queued.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {queued.length} capture{queued.length === 1 ? "" : "s"} waiting on this device.
          It will be sent automatically when the connection returns.
        </p>
      )}

      {serverDrafts.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {serverDrafts.slice(0, 5).map((draft) => (
            <li
              key={draft.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2"
            >
              <span className="font-medium text-slate-800">
                {draft.businessDate} · {draft.locationName}
              </span>
              <span
                className={
                  draft.status === "applied"
                    ? "text-emerald-700"
                    : draft.status === "rejected"
                      ? "text-red-700"
                      : draft.status === "needs_review"
                        ? "text-amber-700"
                        : "text-slate-600"
                }
              >
                {draft.status === "applied"
                  ? "Applied to your daily account"
                  : draft.status === "rejected"
                    ? "Rejected by a reviewer"
                    : draft.status === "needs_review"
                      ? "Needs a reviewer"
                      : "Waiting to be completed"}
              </span>
              {draft.conflictReason ? (
                <span className="w-full text-slate-500">{draft.conflictReason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-4 space-y-3">
          {error && <Notice type="error">{error}</Notice>}
          {success && <Notice type="success">{success}</Notice>}
          {locked && (
            <p className="text-xs text-amber-800">
              Unlock the offline workspace from the banner above, then enter the capture again.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-700">
              Business date
              <input
                type="date"
                className="input mt-1 w-full"
                value={businessDate}
                onChange={(event) => setBusinessDate(event.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              Note for this day (optional)
              <input
                className="input mt-1 w-full"
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. network down from 2pm"
              />
            </label>
            {(
              [
                ["Opening cash", openingCash, setOpeningCash],
                ["Opening float", openingFloat, setOpeningFloat],
                ["Closing cash", closingCash, setClosingCash],
                ["Closing float", closingFloat, setClosingFloat],
              ] as const
            ).map(([label, value, setter]) => (
              <label key={label} className="text-xs font-medium text-slate-700">
                {label}
                <input
                  className="input mt-1 w-full"
                  inputMode="decimal"
                  value={value}
                  onChange={(event) => setter(event.target.value)}
                  placeholder="0.00"
                />
              </label>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-700">Transactions captured</p>
            {lines.map((line, index) => (
              <div key={line.id} className="grid gap-2 rounded-lg border border-slate-100 p-2 sm:grid-cols-5">
                <select
                  aria-label={`Transaction ${index + 1} type`}
                  className="input text-xs"
                  value={line.kind}
                  onChange={(event) =>
                    setLines((rows) =>
                      rows.map((row) =>
                        row.id === line.id
                          ? { ...row, kind: event.target.value as DraftLine["kind"] }
                          : row
                      )
                    )
                  }
                >
                  {ACTIVITY_KINDS.map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Transaction ${index + 1} network`}
                  className="input text-xs"
                  value={line.network}
                  onChange={(event) =>
                    setLines((rows) =>
                      rows.map((row) =>
                        row.id === line.id
                          ? { ...row, network: event.target.value as DraftLine["network"] }
                          : row
                      )
                    )
                  }
                >
                  {MOMO_OFFLINE_NETWORKS.map((network) => (
                    <option key={network} value={network}>
                      {MOMO_OFFLINE_NETWORK_LABELS[network]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Transaction ${index + 1} amount`}
                  className="input text-xs"
                  inputMode="decimal"
                  placeholder="Amount"
                  value={line.amount}
                  onChange={(event) =>
                    setLines((rows) =>
                      rows.map((row) =>
                        row.id === line.id ? { ...row, amount: event.target.value } : row
                      )
                    )
                  }
                />
                <input
                  aria-label={`Transaction ${index + 1} reference`}
                  className="input text-xs"
                  placeholder="Reference (if any)"
                  value={line.reference}
                  onChange={(event) =>
                    setLines((rows) =>
                      rows.map((row) =>
                        row.id === line.id ? { ...row, reference: event.target.value } : row
                      )
                    )
                  }
                />
                <div className="flex gap-1">
                  <input
                    aria-label={`Transaction ${index + 1} evidence reference`}
                    className="input text-xs"
                    placeholder="Photo ref"
                    value={line.evidenceRef}
                    onChange={(event) =>
                      setLines((rows) =>
                        rows.map((row) =>
                          row.id === line.id ? { ...row, evidenceRef: event.target.value } : row
                        )
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label={`Remove transaction ${index + 1}`}
                    className="btn btn-ghost btn-xs"
                    onClick={() => setLines((rows) => rows.filter((row) => row.id !== line.id))}
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => setLines((rows) => [...rows, newLine()])}
            >
              <Plus size={13} aria-hidden /> Add transaction
            </button>
          </div>

          <p className="text-xs text-slate-600">
            Captured totals — for reading only, not a posting: cash in{" "}
            {money(totals_.cashIn)}, cash out {money(totals_.cashOut)}, commission{" "}
            {money(totals_.commission)}, expenses {money(totals_.expense)}.
          </p>
          <p className="text-[11px] text-slate-500">
            A reference or a photo is evidence you kept it. It is not proof that a network
            completed a transaction, and MaaCash will not treat it as one.
          </p>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            Save on this device
          </button>
        </div>
      )}
    </section>
  );
}
