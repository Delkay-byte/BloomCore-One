"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  History,
  Send,
  Truck,
  Undo2,
  XCircle,
} from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import ReauthDialog from "@/components/ReauthDialog";
import TransferStatusBadge from "@/components/momo/TransferStatusBadge";
import {
  approveBranchTransfer,
  cancelBranchTransfer,
  completeBranchTransfer,
  dispatchBranchTransfer,
  disputeBranchTransfer,
  getBranchTransferDetail,
  receiveBranchTransfer,
  rejectBranchTransfer,
  resolveBranchTransfer,
  type BranchTransferView,
} from "@/lib/actions/branch-transfer.actions";
import {
  BRANCH_ASSET_DEFINITIONS,
  type BranchAssetType,
  type BranchTransferStatus,
} from "@/lib/branch-transfers";

type PendingAction =
  | "approve"
  | "reject"
  | "dispatch"
  | "receive"
  | "complete"
  | "cancel"
  | "dispute"
  | "resolve_completed"
  | "resolve_disputed";

export default function BranchTransferDetailPage() {
  const [transfer, setTransfer] = useState<BranchTransferView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reason, setReason] = useState("");
  const [actualAmount, setActualAmount] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);

  const load = useCallback(async () => {
    const id = window.location.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      const result = await getBranchTransferDetail(id);
      if (!result) {
        setError("Transfer not found.");
        return;
      }
      setTransfer(result);
      setActualAmount(
        result.actualAmountReceived !== null ? String(result.actualAmountReceived) : String(result.amount)
      );
    } catch {
      setError("The transfer could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: PendingAction) {
    if (!transfer || busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      let result;
      switch (action) {
        case "approve":
          result = await approveBranchTransfer({ id: transfer.id, stepUpToken: undefined });
          break;
        case "reject":
          result = await rejectBranchTransfer({ id: transfer.id, reason });
          break;
        case "dispatch":
          result = await dispatchBranchTransfer(transfer.id);
          break;
        case "receive":
          result = await receiveBranchTransfer({
            id: transfer.id,
            actualAmountReceived: Number(actualAmount),
            note: reason.trim() || undefined,
          });
          break;
        case "complete":
          result = await completeBranchTransfer(transfer.id);
          break;
        case "cancel":
          result = await cancelBranchTransfer({ id: transfer.id, reason });
          break;
        case "dispute":
          result = await disputeBranchTransfer({ id: transfer.id, reason });
          break;
        case "resolve_completed":
        case "resolve_disputed":
          result = await resolveBranchTransfer({
            id: transfer.id,
            resolution: action === "resolve_completed" ? "completed" : "disputed",
            note: reason,
            stepUpToken: undefined,
          });
          break;
      }
      if (result && !result.success) {
        setError(result.error ?? "The action could not be completed.");
        setReauthOpen(false);
        return;
      }
      if (result?.success) {
        setSuccess("Transfer updated.");
        setPending(null);
        setReason("");
        setReauthOpen(false);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function runWithToken(action: PendingAction, token: string) {
    if (!transfer || busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result =
        action === "approve"
          ? await approveBranchTransfer({ id: transfer.id, stepUpToken: token })
          : await resolveBranchTransfer({
              id: transfer.id,
              resolution: action === "resolve_completed" ? "completed" : "disputed",
              note: reason,
              stepUpToken: token,
            });
      if (!result.success) {
        setError(result.error ?? "The action could not be completed.");
        setReauthOpen(false);
        return;
      }
      setSuccess("Transfer updated.");
      setPending(null);
      setReason("");
      setReauthOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="p-6 text-sm text-slate-500">Loading transfer…</p>;
  if (!transfer) {
    return (
      <div className="space-y-3">
        <Link href="/admin/transfers" className="text-sm text-slate-500 hover:underline">
          ← Back to cash &amp; float
        </Link>
        <Notice type="error" message={error || "Transfer not found."} />
      </div>
    );
  }

  const status = transfer.status as BranchTransferStatus;
  const needsReauth = status === "requested" || status === "variance_investigation" || status === "disputed";

  return (
    <div className="space-y-5">
      <Link href="/admin/transfers" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} aria-hidden /> Back to cash &amp; float
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Transfer {transfer.reference}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {BRANCH_ASSET_DEFINITIONS[transfer.assetType as BranchAssetType]?.label ?? transfer.assetType}{" "}
            · {transfer.sourceLocationName} → {transfer.destinationLocationName}
          </p>
        </div>
        <TransferStatusBadge status={status} label={transfer.statusLabel} />
      </div>

      {error && <Notice type="error" message={error} />}
      {success && <Notice type="success" message={success} />}

      <div className="card grid gap-3 p-4 sm:grid-cols-3">
        <Detail label="Amount dispatched" value={<CediAmount amount={transfer.amount} />} />
        <Detail
          label="Actual amount received"
          value={
            transfer.actualAmountReceived === null ? (
              "Awaiting receipt"
            ) : (
              <CediAmount amount={transfer.actualAmountReceived} />
            )
          }
        />
        <Detail
          label="Variance"
          value={
            transfer.variance === null ? (
              "—"
            ) : (
              <CediAmount amount={transfer.variance} showSign={transfer.variance !== 0} />
            )
          }
        />
        <Detail label="Requested by" value={transfer.initiatedByName ?? "—"} />
        <Detail label="Approved by" value={transfer.approvedByName ?? "—"} />
        <Detail label="Dispatched by" value={transfer.dispatchedByName ?? "—"} />
        <Detail label="Received by" value={transfer.receivedByName ?? "—"} />
        <Detail label="Purpose" value={transfer.purpose ?? "—"} />
        <Detail label="Created" value={new Date(transfer.createdAt).toLocaleString("en-GB")} />
        {transfer.varianceReason && (
          <div className="sm:col-span-3">
            <p className="text-[11px] font-medium text-slate-500">Variance / dispute reason</p>
            <p className="mt-0.5 text-sm text-slate-800">{transfer.varianceReason}</p>
          </div>
        )}
        {transfer.resolutionNote && (
          <div className="sm:col-span-3">
            <p className="text-[11px] font-medium text-slate-500">Investigation conclusion</p>
            <p className="mt-0.5 text-sm text-slate-800">{transfer.resolutionNote}</p>
          </div>
        )}
      </div>

      <div className="card flex flex-wrap gap-2 p-4">
        {status === "requested" && (
          <>
            <button
              type="button"
              onClick={() => {
                setPending("approve");
                setReauthOpen(true);
              }}
              disabled={busy}
              className="btn btn-primary btn-sm"
            >
              <CheckCircle2 size={14} aria-hidden /> Approve
            </button>
            <button type="button" onClick={() => setPending("reject")} disabled={busy} className="btn btn-secondary btn-sm">
              <XCircle size={14} aria-hidden /> Reject
            </button>
          </>
        )}
        {status === "approved" && (
          <button type="button" onClick={() => setPending("dispatch")} disabled={busy} className="btn btn-primary btn-sm">
            <Send size={14} aria-hidden /> Confirm dispatch
          </button>
        )}
        {status === "dispatched" && (
          <>
            <button type="button" onClick={() => setPending("receive")} disabled={busy} className="btn btn-primary btn-sm">
              <Truck size={14} aria-hidden /> Confirm receipt
            </button>
            <button type="button" onClick={() => setPending("dispute")} disabled={busy} className="btn btn-secondary btn-sm">
              Raise a dispute
            </button>
          </>
        )}
        {status === "received" && (
          <button type="button" onClick={() => setPending("complete")} disabled={busy} className="btn btn-primary btn-sm">
            Complete transfer
          </button>
        )}
        {(status === "variance_investigation" || status === "disputed") && (
          <>
            <button type="button" onClick={() => setPending("resolve_completed")} disabled={busy} className="btn btn-primary btn-sm">
              Resolve as completed
            </button>
            <button type="button" onClick={() => setPending("resolve_disputed")} disabled={busy} className="btn btn-secondary btn-sm">
              Keep disputed
            </button>
          </>
        )}
        {["draft", "requested", "approved"].includes(status) && (
          <button type="button" onClick={() => setPending("cancel")} disabled={busy} className="btn btn-secondary btn-sm">
            <Undo2 size={14} aria-hidden /> Cancel transfer
          </button>
        )}
        {status === "disputed" && (
          <button type="button" onClick={() => setPending("cancel")} disabled={busy} className="btn btn-secondary btn-sm">
            Cancel transfer
          </button>
        )}
      </div>

      {pending && !["approve", "dispatch", "complete"].includes(pending) && (
        <div className="card p-4">
          <h2 className="text-sm font-bold text-slate-900">
            {pending === "receive"
              ? "Confirm receipt"
              : pending === "reject"
                ? "Reject the transfer"
                : pending === "cancel"
                  ? "Cancel the transfer"
                  : pending === "dispute"
                    ? "Record a dispute"
                    : "Investigation conclusion"}
          </h2>
          {pending === "receive" && (
            <label className="mt-2 block text-xs font-semibold text-slate-700">
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
            {pending === "receive" ? "Note (required if there is a difference)" : "Reason / conclusion"}
            <textarea
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (needsReauth && (pending === "resolve_completed" || pending === "resolve_disputed")) {
                  setReauthOpen(true);
                } else {
                  void run(pending);
                }
              }}
              disabled={busy || reason.trim().length < (pending === "receive" ? 0 : 5)}
              className="btn btn-primary btn-sm"
            >
              Confirm
            </button>
            <button type="button" onClick={() => setPending(null)} className="btn btn-secondary btn-sm">
              Cancel
            </button>
          </div>
          {pending === "receive" && Number(actualAmount) !== transfer.amount && (
            <p className="mt-2 text-xs text-amber-800">
              A difference will be preserved as a variance and the transfer will
              need supervisor investigation before completion.
            </p>
          )}
        </div>
      )}

      <div className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <History size={15} aria-hidden /> Transfer history
        </h2>
        <div className="mt-2 overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {transfer.events.map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap text-xs">
                    {new Date(event.createdAt).toLocaleString("en-GB")}
                  </td>
                  <td className="text-xs capitalize">{event.action.replace(/_/g, " ")}</td>
                  <td className="text-xs">{event.actorName ?? event.actorId}</td>
                  <td className="text-xs">{event.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs text-slate-500">
          <AlertTriangle size={13} className="mt-0.5 flex-none text-amber-600" aria-hidden />
          This history is append-only. A transfer transition never rewrites an
          earlier event.
        </p>
      </div>

      <ReauthDialog
        open={reauthOpen}
        onClose={() => setReauthOpen(false)}
        onConfirmed={(token) => {
          if (pending) void runWithToken(pending, token);
        }}
        title={pending?.startsWith("resolve") ? "Confirm the investigation outcome" : "Approve this transfer"}
        description="Enter your administrator password to authorise this financial control step."
        actionLabel={pending?.startsWith("resolve") ? "Record outcome" : "Approve transfer"}
        module="admin"
        purpose={
          pending?.startsWith("resolve")
            ? "finance.branch_transfer.resolve"
            : "finance.branch_transfer.approve"
        }
        targetType="branchTransfer"
        targetId={transfer.id}
        context={{ amountMinor: Math.round(transfer.amount * 100) }}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
