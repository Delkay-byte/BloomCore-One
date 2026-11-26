"use client";

import { useCallback, useEffect, useState } from "react";
import { Banknote, RefreshCw } from "lucide-react";
import Notice from "@/components/ui/Notice";
import ReauthDialog from "@/components/ReauthDialog";
import CediAmount from "@/components/CediAmount";
import {
  approveWithdrawalRequest,
  getWithdrawalRequests,
  rejectWithdrawalRequest,
  type WithdrawalRequestView,
} from "@/lib/actions/withdrawal-request.actions";

type QueueStatus = "open" | "requested" | "paid" | "rejected" | "cancelled" | "all";

const FILTERS: Array<{ value: QueueStatus; label: string }> = [
  { value: "open", label: "Waiting" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Declined" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

/**
 * Customer withdrawal requests for the office.
 *
 * Approving runs the ordinary withdrawal action with the operator's step-up
 * grant, so the commission rule, balance check and receipt all behave exactly
 * as they do when staff record a withdrawal at the counter.
 */
export default function WithdrawalRequestsPage() {
  const [status, setStatus] = useState<QueueStatus>("open");
  const [requests, setRequests] = useState<WithdrawalRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [approving, setApproving] = useState<WithdrawalRequestView | null>(null);
  const [declining, setDeclining] = useState<WithdrawalRequestView | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getWithdrawalRequests({ status });
      if (!result.success) setError(result.error ?? "The queue could not be loaded.");
      setRequests(result.requests ?? []);
    } catch {
      setError("The queue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(request: WithdrawalRequestView, stepUpToken: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await approveWithdrawalRequest({ id: request.id, stepUpToken });
    if (!result.success) {
      setError(result.error ?? "The withdrawal was refused.");
    } else {
      setSuccess(
        `${request.reference} approved and recorded as a withdrawal of ${request.amountLabel}.`
      );
      setApproving(null);
      await load();
    }
    setBusy(false);
  }

  async function decline() {
    if (!declining) return;
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await rejectWithdrawalRequest({ id: declining.id, note });
    if (!result.success) {
      setError(result.error ?? "The request could not be declined.");
    } else {
      setSuccess(`${declining.reference} declined.`);
      setDeclining(null);
      setNote("");
      await load();
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Withdrawal requests</h1>
          <p className="mt-1 text-sm text-slate-600">
            A customer asked to withdraw. Approving uses the same withdrawal rule as the
            counter: commission on a first withdrawal, the balance check, and a receipt.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm">
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </header>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter requests">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            role="tab"
            aria-selected={status === filter.value}
            onClick={() => setStatus(filter.value)}
            className={`btn btn-xs ${status === filter.value ? "btn-primary" : "btn-secondary"}`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading requests…</p>
      ) : requests.length === 0 ? (
        <p className="card p-4 text-sm text-slate-500">
          Nothing is waiting in this view.
        </p>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => (
            <article key={request.id} className="card space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-xs text-slate-500">{request.reference}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">
                    <CediAmount amount={request.amountPesewa / 100} />
                  </p>
                  <p className="text-xs text-slate-600">
                    Account {request.accountReference} · asked{" "}
                    {new Date(request.createdAt).toLocaleString("en-GB")}
                  </p>
                </div>
                <span className="badge badge-blue">{request.statusLabel}</span>
              </div>
              <p className="rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
                &ldquo;{request.reason}&rdquo;
              </p>
              {request.decisionNote && (
                <p className="text-xs text-slate-500">Decision: {request.decisionNote}</p>
              )}
              {(request.status === "requested" || request.status === "needs_review") && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setApproving(request)}
                    disabled={busy}
                    className="btn btn-primary btn-sm"
                  >
                    <Banknote size={14} aria-hidden /> Approve and record
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeclining(request);
                      setNote("");
                    }}
                    disabled={busy}
                    className="btn btn-secondary btn-sm"
                  >
                    Decline
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {approving && (
        <ReauthDialog
          open={Boolean(approving)}
          onClose={() => setApproving(null)}
          onConfirmed={(token) => void approve(approving, token)}
          module="admin"
          title="Confirm the withdrawal"
          description={`Record ${approving.amountLabel} for ${approving.reference}. This posts a withdrawal and sends a receipt.`}
          actionLabel="Approve and record"
          purpose="susu.withdrawal"
          targetType="susuAccount"
          targetId={approving.accountId}
          context={{ amountMinor: approving.amountPesewa }}
        />
      )}

      {declining && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Decline withdrawal request"
        >
          <div className="card w-full max-w-md space-y-3 p-4">
            <h2 className="text-base font-semibold text-slate-900">
              Decline {declining.reference}
            </h2>
            <p className="text-xs text-slate-600">
              The customer sees this reason. No money moves.
            </p>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className="input w-full"
              placeholder="Explain why this request is declined."
              aria-label="Reason for declining"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeclining(null)}
                className="btn btn-secondary btn-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void decline()}
                disabled={busy || note.trim().length < 10}
                className="btn btn-primary btn-sm"
              >
                {busy ? "Saving…" : "Decline request"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
