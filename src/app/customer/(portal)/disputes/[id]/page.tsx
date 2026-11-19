"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import DisputeStatusBadge from "@/components/susu/DisputeStatusBadge";
import {
  cancelCustomerDispute,
  getCustomerDispute,
  respondToCustomerDispute,
  type CustomerDisputeView,
} from "@/lib/actions/customer-dispute.actions";
import {
  DISPUTE_CATEGORY_LABELS,
  isOpenDispute,
  type DisputeCategory,
} from "@/lib/customer-disputes";

const EVENT_LABEL: Record<string, string> = {
  opened: "Dispute opened",
  customer_responded: "Information added",
  review_started: "Review started",
  information_requested: "More information requested",
  resolved_upheld: "Resolved in your favour",
  resolved_declined: "Records confirmed",
  cancelled: "Dispute cancelled",
};

function fmt(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CustomerDisputeDetailPage() {
  const params = useParams<{ id: string }>();
  const disputeId = params?.id;
  const [dispute, setDispute] = useState<CustomerDisputeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!disputeId) return;
    setLoading(true);
    setError("");
    try {
      const found = await getCustomerDispute(disputeId);
      if (!found) setError("This dispute is not available on your account.");
      setDispute(found);
    } catch {
      setError("The dispute could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [disputeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function respond() {
    if (!dispute) return;
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await respondToCustomerDispute({ disputeId: dispute.id, note });
    if (!result.success) {
      setError(result.error ?? "Your information could not be added.");
    } else {
      setSuccess("Information added. The review will continue.");
      setNote("");
      await load();
    }
    setBusy(false);
  }

  async function cancel() {
    if (!dispute) return;
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await cancelCustomerDispute(dispute.id);
    if (!result.success) {
      setError(result.error ?? "The dispute could not be cancelled.");
    } else {
      setSuccess("Dispute cancelled.");
      await load();
    }
    setBusy(false);
  }

  if (loading && !dispute) return <p className="text-sm text-slate-500">Loading dispute…</p>;
  if (!dispute) {
    return (
      <div className="space-y-4">
        <Notice type="error">{error || "This dispute is not available."}</Notice>
        <Link href="/customer/disputes" className="btn btn-secondary inline-flex">
          <ArrowLeft className="h-4 w-4" aria-hidden /> My disputes
        </Link>
      </div>
    );
  }

  const open = isOpenDispute(dispute.status);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link
        href="/customer/disputes"
        className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> My disputes
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dispute {dispute.reference}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {dispute.subjectType === "contribution" ? "Contribution" : "Withdrawal"} of{" "}
            <CediAmount amount={dispute.subjectAmount} /> · transaction{" "}
            {dispute.subjectReference}
          </p>
        </div>
        <DisputeStatusBadge status={dispute.status} />
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      <section className="card p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">Category</dt>
            <dd className="font-medium text-slate-900">
              {DISPUTE_CATEGORY_LABELS[dispute.category as DisputeCategory] ??
                dispute.category}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Raised</dt>
            <dd className="text-slate-800">{fmt(dispute.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Account</dt>
            <dd className="text-slate-800">{dispute.accountNumber ?? "—"}</dd>
          </div>
          {dispute.resolvedAt && (
            <div>
              <dt className="text-xs text-slate-500">Closed</dt>
              <dd className="text-slate-800">{fmt(dispute.resolvedAt)}</dd>
            </div>
          )}
        </dl>
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <span className="font-semibold">Your explanation: </span>
          {dispute.details}
        </div>
        {dispute.resolutionNote && (
          <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <span className="font-semibold">Outcome: </span>
            {dispute.resolutionNote}
            {dispute.outcomeReference && (
              <span className="mt-1 block text-xs">
                Correction reference: {dispute.outcomeReference}
              </span>
            )}
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-bold text-slate-900">History</h2>
        <ol className="mt-3 space-y-3">
          {dispute.events.map((event) => (
            <li key={event.id} className="flex gap-3">
              <span className="mt-1 h-2 w-2 flex-none rounded-full bg-brand-500" aria-hidden />
              <div>
                <p className="text-sm font-medium text-slate-800">
                  {EVENT_LABEL[event.action] ?? event.action}
                  {event.actorName && (
                    <span className="font-normal text-slate-500"> · {event.actorName}</span>
                  )}
                </p>
                <p className="text-[11px] text-slate-400">{fmt(event.createdAt)}</p>
                {event.note && event.action !== "opened" && (
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600">
                    {event.note}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {open && (
        <section className="card p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <ShieldCheck className="h-4 w-4 text-brand-600" aria-hidden />
            Add information
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Add anything that helps the review: a receipt, the person who handled
            it, or the time it happened.
          </p>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={1000}
            className="input mt-2 w-full"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || note.trim().length < 5}
              onClick={() => void respond()}
            >
              {busy ? "Saving…" : "Send information"}
            </button>
            {dispute.status === "open" && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void cancel()}
              >
                Cancel dispute
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
