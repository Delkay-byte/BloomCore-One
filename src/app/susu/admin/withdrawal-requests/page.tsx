"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Banknote, CreditCard, RefreshCw } from "lucide-react";
import Notice from "@/components/ui/Notice";
import ReauthDialog from "@/components/ReauthDialog";
import CediAmount from "@/components/CediAmount";
import {
  approveWithdrawalRequest,
  payWithdrawalRequest,
} from "@/lib/actions/withdrawal-control.actions";
import {
  getWithdrawalRequests,
  rejectWithdrawalRequest,
  type WithdrawalRequestView,
} from "@/lib/actions/withdrawal-request.actions";

type QueueStatus =
  | "open"
  | "requested"
  | "needs_review"
  | "approved"
  | "awaiting_payment"
  | "paid"
  | "rejected"
  | "disputed"
  | "reversed"
  | "cancelled"
  | "all";

type RequestView = WithdrawalRequestView & {
  highValue?: boolean;
  approvalCount?: number;
  requiredApprovals?: number;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  evidenceRef?: string | null;
  paidAt?: string | null;
};

const FILTERS: Array<{ value: QueueStatus; label: string }> = [
  { value: "open", label: "Waiting" },
  { value: "awaiting_payment", label: "Awaiting payment" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Declined" },
  { value: "disputed", label: "Disputed" },
  { value: "reversed", label: "Reversed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

const STATUS_INFO: Record<string, { label: string; badge: string }> = {
  requested: { label: "Requested", badge: "badge-blue" },
  needs_review: { label: "Needs review", badge: "badge-yellow" },
  approved: { label: "Approved", badge: "badge-yellow" },
  awaiting_payment: { label: "Awaiting payment", badge: "badge-yellow" },
  paid: { label: "Paid", badge: "badge-green" },
  rejected: { label: "Rejected", badge: "badge-red" },
  disputed: { label: "Disputed", badge: "badge-red" },
  reversed: { label: "Reversed", badge: "badge-red" },
  cancelled: { label: "Cancelled", badge: "badge-gray" },
};

function statusInfo(status: string) {
  return STATUS_INFO[status] ?? {
    label: status.replace(/_/g, " "),
    badge: "badge-gray",
  };
}

/**
 * Customer withdrawal requests for the office.
 *
 * Approval and payment are separate steps. An approval records a decision and
 * never moves money; payment is the irreversible act and always asks for
 * step-up reauthentication. Legacy requests still go through the single-action
 * path because the server action keeps that behaviour for tenants without a
 * staged policy.
 */
export default function WithdrawalRequestsPage() {
  const [status, setStatus] = useState<QueueStatus>("open");
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [success, setSuccess] = useState("");
  const [approving, setApproving] = useState<RequestView | null>(null);
  const [declining, setDeclining] = useState<RequestView | null>(null);
  const [note, setNote] = useState("");
  const [paying, setPaying] = useState<RequestView | null>(null);
  const [payConfirm, setPayConfirm] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [reasonCode, setReasonCode] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setRetry(null);
    try {
      const result = await getWithdrawalRequests({
        status: status as NonNullable<Parameters<typeof getWithdrawalRequests>[0]>["status"],
      });
      if (!result.success) {
        setError(result.error ?? "The queue could not be loaded.");
        setRetry(() => () => void load());
      }
      setRequests((result.requests ?? []) as RequestView[]);
    } catch {
      setError("The queue could not be loaded.");
      setRetry(() => () => void load());
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(message: string, retryFn?: () => void) {
    setError(message);
    setRetry(retryFn ?? null);
    setSuccess("");
  }

  async function approve(request: RequestView, stepUpToken: string) {
    setBusy(true);
    setError("");
    setRetry(null);
    setSuccess("");
    try {
      const result = await approveWithdrawalRequest({ id: request.id, stepUpToken });
      if (!result.success) {
        fail(result.error ?? "The approval was refused.", () => setApproving(request));
        return;
      }
      const done = (request.approvalCount ?? 0) + 1;
      const needed = request.requiredApprovals ?? 0;
      setSuccess(
        needed === 0
          ? `${request.reference} approved and recorded as a withdrawal.`
          : needed > done
            ? `${request.reference} approved. ${done} of ${needed} approvals recorded.`
            : `${request.reference} approved. Payment can now be recorded.`
      );
      setApproving(null);
      await load();
    } catch {
      fail("The approval could not be saved.", () => setApproving(request));
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (!declining) return;
    setBusy(true);
    setError("");
    setRetry(null);
    setSuccess("");
    try {
      const result = await rejectWithdrawalRequest({ id: declining.id, note });
      if (!result.success) {
        fail(result.error ?? "The request could not be rejected.", () => setDeclining(declining));
        return;
      }
      setSuccess(`${declining.reference} declined.`);
      setDeclining(null);
      setNote("");
      await load();
    } catch {
      fail("The request could not be rejected.", () => setDeclining(declining));
    } finally {
      setBusy(false);
    }
  }

  function openPay(request: RequestView) {
    setPaying(request);
    setPayConfirm(false);
    setPaymentMethod("");
    setPaymentReference("");
    setEvidenceRef("");
    setReasonCode("");
    setError("");
    setRetry(null);
    setSuccess("");
  }

  function startPay(event: FormEvent) {
    event.preventDefault();
    if (!paymentMethod.trim() || !paymentReference.trim()) {
      fail("Enter the payment method and reference before you continue.");
      return;
    }
    setError("");
    setRetry(null);
    setPayConfirm(true);
  }

  async function pay(request: RequestView, stepUpToken: string) {
    setBusy(true);
    setError("");
    setRetry(null);
    setSuccess("");
    try {
      const result = await payWithdrawalRequest({
        id: request.id,
        stepUpToken,
        paymentMethod: paymentMethod.trim(),
        paymentReference: paymentReference.trim(),
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
        ...(reasonCode.trim() ? { reasonCode: reasonCode.trim() } : {}),
      });
      if (!result.success) {
        fail(result.error ?? "The payment could not be recorded.", () => setPayConfirm(true));
        return;
      }
      setSuccess(`${request.reference} recorded as paid.`);
      setPaying(null);
      setPayConfirm(false);
      await load();
    } catch {
      fail("The payment could not be recorded.", () => setPayConfirm(true));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Withdrawal requests</h1>
          <p className="mt-1 text-sm text-slate-600">
            A customer asked to withdraw. Approval records a decision; payment moves the
            money and cannot be undone here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="btn btn-secondary btn-sm"
        >
          <RefreshCw size={14} aria-hidden /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Notice type="error" message={error}>{error}</Notice>
          {retry && (
            <button
              type="button"
              onClick={() => {
                const fn = retry;
                setRetry(null);
                fn();
              }}
              className="btn btn-secondary btn-sm"
            >
              Retry
            </button>
          )}
        </div>
      )}
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
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true" aria-label="Loading withdrawal requests">
          {[0, 1, 2].map((key) => (
            <div key={key} className="card space-y-2 p-4">
              <div className="skeleton h-3 w-28" />
              <div className="skeleton h-6 w-32" />
              <div className="skeleton h-3 w-56" />
            </div>
          ))}
        </div>
      ) : requests.length === 0 ? (
        <p className="card p-4 text-sm text-slate-500">Nothing is waiting in this view.</p>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => {
            const info = statusInfo(String(request.status));
            const done = request.approvalCount ?? 0;
            const needed = request.requiredApprovals ?? 0;
            const stage = String(request.status);
            const canApprove = stage === "requested" || stage === "needs_review";
            const canPay = stage === "awaiting_payment" || stage === "approved";

            return (
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
                  <div className="flex flex-wrap gap-1">
                    {request.highValue && <span className="badge badge-yellow">High value</span>}
                    <span className={`badge ${info.badge}`}>{info.label}</span>
                  </div>
                </div>

                {needed > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-slate-600">
                      <span>Approvals</span>
                      <span>{done} of {needed} recorded</span>
                    </div>
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
                      role="progressbar"
                      aria-label={`Approvals for ${request.reference}`}
                      aria-valuenow={done}
                      aria-valuemin={0}
                      aria-valuemax={needed}
                    >
                      <div
                        className="h-full bg-brand-700"
                        style={{ width: `${Math.min(100, (done / needed) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}

                <p className="rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
                  &ldquo;{request.reason}&rdquo;
                </p>
                {request.decisionNote && (
                  <p className="text-xs text-slate-500">Decision: {request.decisionNote}</p>
                )}
                {(request.paymentMethod || request.paymentReference || request.paidAt) && (
                  <p className="text-xs text-slate-600">
                    Payment: {request.paymentMethod ?? "recorded"}
                    {request.paymentReference ? ` · ${request.paymentReference}` : ""}
                    {request.paidAt
                      ? ` · ${new Date(request.paidAt).toLocaleString("en-GB")}`
                      : ""}
                  </p>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  {canApprove && (
                    <button
                      type="button"
                      onClick={() => setApproving(request)}
                      disabled={busy}
                      className="btn btn-primary btn-sm"
                    >
                      <Banknote size={14} aria-hidden /> Approve
                    </button>
                  )}
                  {canPay && (
                    <button
                      type="button"
                      onClick={() => openPay(request)}
                      disabled={busy}
                      className="btn btn-primary btn-sm"
                    >
                      <CreditCard size={14} aria-hidden /> Record payment
                    </button>
                  )}
                  {canApprove && (
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
                  )}
                </div>

                {paying?.id === request.id && (
                  <form
                    onSubmit={startPay}
                    className="card space-y-3 border border-line bg-slate-50 p-3"
                    aria-busy={busy}
                  >
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">
                        Record payment for {paying.reference}
                      </h3>
                      <p className="mt-1 text-xs text-brand-900">
                        Mark this paid only after the money has left the till or account.
                        Payment cannot be undone here. Check the amount and the customer
                        before you continue.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-xs font-medium text-slate-700">
                        Payment method
                        <input
                          value={paymentMethod}
                          onChange={(event) => setPaymentMethod(event.target.value)}
                          className="input mt-1 block w-full"
                          placeholder="Cash, bank transfer, MoMo"
                          aria-label="Payment method"
                        />
                      </label>
                      <label className="block text-xs font-medium text-slate-700">
                        Payment reference
                        <input
                          value={paymentReference}
                          onChange={(event) => setPaymentReference(event.target.value)}
                          className="input mt-1 block w-full"
                          placeholder="Receipt or transaction reference"
                          aria-label="Payment reference"
                        />
                      </label>
                      <label className="block text-xs font-medium text-slate-700">
                        Evidence reference (optional)
                        <input
                          value={evidenceRef}
                          onChange={(event) => setEvidenceRef(event.target.value)}
                          className="input mt-1 block w-full"
                          placeholder="Where the proof is stored"
                          aria-label="Evidence reference"
                        />
                      </label>
                      <label className="block text-xs font-medium text-slate-700">
                        Reason code (optional)
                        <input
                          value={reasonCode}
                          onChange={(event) => setReasonCode(event.target.value)}
                          className="input mt-1 block w-full"
                          placeholder="For example: cash paid"
                          aria-label="Reason code"
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPaying(null);
                          setPayConfirm(false);
                        }}
                        className="btn btn-secondary btn-sm"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={busy || !paymentMethod.trim() || !paymentReference.trim()}
                        className="btn btn-primary btn-sm"
                      >
                        Confirm payment details
                      </button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      )}

      {approving && (
        <ReauthDialog
          open={Boolean(approving)}
          onClose={() => setApproving(null)}
          onConfirmed={(token) => void approve(approving, token)}
          module="admin"
          title="Confirm the approval"
          description={`Record approval for ${approving.reference} (${approving.amountLabel}). No money moves at this step.`}
          actionLabel="Approve request"
          purpose="withdrawal.approve"
          targetType="customerWithdrawalRequest"
          targetId={approving.id}
          context={{
            amountMinor: String(approving.amountPesewa),
            currency: "GHS",
          }}
        />
      )}

      {paying && payConfirm && (
        <ReauthDialog
          open={payConfirm}
          onClose={() => setPayConfirm(false)}
          onConfirmed={(token) => void pay(paying, token)}
          module="admin"
          title="Confirm payment"
          description={`Mark ${paying.reference} (${paying.amountLabel}) as paid using ${paymentReference}. This cannot be undone here.`}
          actionLabel="Confirm payment"
          purpose="withdrawal.pay"
          targetType="susuAccount"
          targetId={paying.accountId}
          context={{
            amountMinor: String(paying.amountPesewa),
            currency: "GHS",
          }}
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
              Reject {declining.reference}
            </h2>
            <p className="text-xs text-slate-600">
              The customer sees this reason. No money moves.
            </p>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className="input w-full"
              placeholder="Explain why this request is rejected."
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
