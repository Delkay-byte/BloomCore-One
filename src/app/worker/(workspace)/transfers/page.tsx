"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, RefreshCw } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import TransferStatusBadge from "@/components/momo/TransferStatusBadge";
import {
  cancelBranchTransfer,
  completeBranchTransfer,
  createBranchTransfer,
  dispatchBranchTransfer,
  disputeBranchTransfer,
  getTransferLocationOptions,
  getWorkerTransferView,
  receiveBranchTransfer,
  type WorkerTransferView,
} from "@/lib/actions/branch-transfer.actions";
import {
  BRANCH_ASSET_DEFINITIONS,
  BRANCH_ASSET_TYPES,
  type BranchAssetType,
  type BranchTransferStatus,
} from "@/lib/branch-transfers";

function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const SOURCE_LABEL: Record<string, string> = {
  manual_declaration: "Declared by an administrator",
  declaration_plus_transfers: "Declaration + transfers since",
  no_declared_balance: "Not declared",
};

export default function WorkerTransfersPage() {
  const [view, setView] = useState<WorkerTransferView | null>(null);
  const [locations, setLocations] = useState<Array<{ id: string; name: string; code: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [destinationLocationId, setDestinationLocationId] = useState("");
  const [assetType, setAssetType] = useState<BranchAssetType>("cash");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newKey());

  const [active, setActive] = useState<string | null>(null);
  const [actualAmount, setActualAmount] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [workerView, options] = await Promise.all([
        getWorkerTransferView(),
        getTransferLocationOptions(),
      ]);
      setView(workerView);
      setLocations(options.locations);
      setDestinationLocationId(
        (current) =>
          current ||
          options.locations.find((location) => location.id !== workerView.locationId)?.id ||
          ""
      );
    } catch {
      setError("Your branch positions could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!view?.locationId || busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await createBranchTransfer({
        sourceLocationId: view.locationId,
        destinationLocationId,
        assetType,
        amount: Number(amount),
        purpose: purpose.trim() || undefined,
        idempotencyKey,
      });
      if (!result.success) {
        setError(result.error ?? "The transfer request could not be created.");
        return;
      }
      setSuccess("Transfer requested. A different administrator must approve it before dispatch.");
      setAmount("");
      setPurpose("");
      setIdempotencyKey(newKey());
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function runAction(id: string, action: "dispatch" | "complete") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result =
        action === "dispatch"
          ? await dispatchBranchTransfer(id)
          : await completeBranchTransfer(id);
      if (!result.success) {
        setError(result.error ?? "The transfer could not be updated.");
        return;
      }
      setSuccess(action === "dispatch" ? "Dispatch confirmed." : "Transfer completed.");
      setActive(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function runReasonAction(id: string, action: "receive" | "dispute" | "cancel") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result =
        action === "receive"
          ? await receiveBranchTransfer({
              id,
              actualAmountReceived: Number(actualAmount),
              note: reason.trim() || undefined,
            })
          : action === "dispute"
            ? await disputeBranchTransfer({ id, reason })
            : await cancelBranchTransfer({ id, reason });
      if (!result.success) {
        setError(result.error ?? "The transfer could not be updated.");
        return;
      }
      setSuccess(
        action === "receive"
          ? "Receipt recorded. A difference stays open for supervisor investigation."
          : action === "dispute"
            ? "Dispute recorded."
            : "Transfer cancelled."
      );
      setActive(null);
      setReason("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-16">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Cash, float &amp; transfers</h1>
          <p className="mt-1 text-sm text-slate-600">
            {view?.locationName ?? "Your location"} · internal declarations, not
            real-time provider balances.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm">
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </div>

      {error && <Notice type="error" message={error} />}
      {success && <Notice type="success" message={success} />}

      {loading || !view ? (
        <p className="text-sm text-slate-500">Loading your branch positions…</p>
      ) : (
        <>
          <section className="card overflow-hidden">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Your branch position</h2>
              <p className="text-xs text-slate-500">
                Declared balances plus transfers recorded since the declaration.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Declared</th>
                    <th>Adjustment</th>
                    <th>Available internally</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {view.positions.map((position) => (
                    <tr key={position.assetType}>
                      <td className="text-xs font-medium">{position.label}</td>
                      <td className="tnum text-xs">
                        {position.declared === null ? "—" : <CediAmount amount={position.declared} />}
                      </td>
                      <td className="tnum text-xs">
                        <CediAmount amount={position.adjustment} showSign={position.adjustment !== 0} />
                      </td>
                      <td className="tnum text-xs font-semibold">
                        {position.effective === null ? "Not declared" : <CediAmount amount={position.effective} />}
                      </td>
                      <td className="text-xs">{SOURCE_LABEL[position.source]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <ArrowRightLeft size={15} aria-hidden /> Request a transfer from your branch
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-semibold text-slate-700">
                Send to
                <select
                  value={destinationLocationId}
                  onChange={(event) => setDestinationLocationId(event.target.value)}
                  className="mt-1 w-full"
                >
                  {locations
                    .filter((location) => location.id !== view.locationId)
                    .map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name} ({location.code})
                      </option>
                    ))}
                </select>
              </label>
              <label className="block text-xs font-semibold text-slate-700">
                Asset
                <select
                  value={assetType}
                  onChange={(event) => setAssetType(event.target.value as BranchAssetType)}
                  className="mt-1 w-full"
                >
                  {BRANCH_ASSET_TYPES.map((asset) => (
                    <option key={asset} value={asset}>
                      {BRANCH_ASSET_DEFINITIONS[asset].shortLabel}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs font-semibold text-slate-700">
                Amount (GH₵)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  className="mt-1 w-full"
                />
              </label>
              <label className="block text-xs font-semibold text-slate-700">
                Purpose (optional)
                <input
                  type="text"
                  maxLength={200}
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  className="mt-1 w-full"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy || !amount || !destinationLocationId}
              className="btn btn-primary mt-3"
            >
              Request transfer
            </button>
            <p className="mt-2 text-xs text-slate-500">
              A different administrator must approve every transfer. Dispatching
              and receiving are each confirmed separately.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-bold text-slate-900">Your branch transfers</h2>
            {view.transfers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500">
                No transfers for this branch yet.
              </p>
            ) : (
              view.transfers.map((transfer) => {
                const isSource = transfer.sourceLocationId === view.locationId;
                const isDestination = transfer.destinationLocationId === view.locationId;
                const status = transfer.status as BranchTransferStatus;
                return (
                  <div key={transfer.id} className="card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-slate-900">{transfer.reference}</p>
                        <p className="text-xs text-slate-600">
                          {BRANCH_ASSET_DEFINITIONS[transfer.assetType as BranchAssetType]?.shortLabel}{" "}
                          · {transfer.sourceLocationName} → {transfer.destinationLocationName} ·{" "}
                          <CediAmount amount={transfer.amount} />
                        </p>
                      </div>
                      <TransferStatusBadge status={status} label={transfer.statusLabel} />
                    </div>

                    {transfer.variance !== null && transfer.variance !== 0 && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                        Dispatched <CediAmount amount={transfer.amount} />, received{" "}
                        <CediAmount amount={transfer.actualAmountReceived ?? 0} /> — variance{" "}
                        <CediAmount amount={transfer.variance} showSign /> awaiting supervisor
                        investigation.
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {status === "approved" && isSource && (
                        <button
                          type="button"
                          onClick={() => void runAction(transfer.id, "dispatch")}
                          disabled={busy}
                          className="btn btn-primary btn-sm"
                        >
                          Confirm dispatch
                        </button>
                      )}
                      {status === "dispatched" && isDestination && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setActive(`receive:${transfer.id}`);
                              setActualAmount(String(transfer.amount));
                              setReason("");
                            }}
                            className="btn btn-primary btn-sm"
                          >
                            Confirm receipt
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActive(`dispute:${transfer.id}`);
                              setReason("");
                            }}
                            className="btn btn-secondary btn-sm"
                          >
                            Dispute
                          </button>
                        </>
                      )}
                      {status === "received" && isDestination && (
                        <button
                          type="button"
                          onClick={() => void runAction(transfer.id, "complete")}
                          disabled={busy}
                          className="btn btn-primary btn-sm"
                        >
                          Complete transfer
                        </button>
                      )}
                      {["draft", "requested", "approved"].includes(status) &&
                        transfer.initiatedById &&
                        isSource && (
                          <button
                            type="button"
                            onClick={() => {
                              setActive(`cancel:${transfer.id}`);
                              setReason("");
                            }}
                            className="btn btn-secondary btn-sm"
                          >
                            Cancel
                          </button>
                        )}
                    </div>

                    {active?.endsWith(transfer.id) && (
                      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                        {active.startsWith("receive") && (
                          <label className="block text-xs font-semibold text-slate-700">
                            Actual amount received (GH₵)
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={actualAmount}
                              onChange={(event) => setActualAmount(event.target.value)}
                              className="mt-1 w-full"
                            />
                          </label>
                        )}
                        <label className="mt-2 block text-xs font-semibold text-slate-700">
                          {active.startsWith("receive")
                            ? "Note (required if the amount differs)"
                            : "Reason"}
                          <textarea
                            rows={2}
                            maxLength={500}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            className="mt-1 w-full"
                          />
                        </label>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              void runReasonAction(
                                transfer.id,
                                active.startsWith("receive")
                                  ? "receive"
                                  : active.startsWith("dispute")
                                    ? "dispute"
                                    : "cancel"
                              )
                            }
                            disabled={
                              busy ||
                              (active.startsWith("receive")
                                ? Number(actualAmount) !== transfer.amount &&
                                  reason.trim().length < 5
                                : reason.trim().length < 5)
                            }
                            className="btn btn-primary btn-sm"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setActive(null)}
                            className="btn btn-secondary btn-sm"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </div>
  );
}
