"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import DisputeStatusBadge from "@/components/susu/DisputeStatusBadge";
import {
  getAdminDispute,
  requestDisputeInformation,
  resolveCustomerDispute,
  startDisputeReview,
  type CustomerDisputeView,
} from "@/lib/actions/customer-dispute.actions";
import {
  DISPUTE_CATEGORY_LABELS,
  isOpenDispute,
  type DisputeCategory,
} from "@/lib/customer-disputes";

const EVENT_LABEL: Record<string, string> = {
  opened: "Dispute opened",
  customer_responded: "Customer added information",
  review_started: "Review started",
  information_requested: "Information requested",
  resolved_upheld: "Resolved — upheld",
  resolved_declined: "Resolved — records confirmed",
  cancelled: "Cancelled by customer",
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

export default function AdminDisputeDetailPage() {
  const params = useParams<{ id: string }>();
  const disputeId = params?.id;
  const [dispute, setDispute] = useState<CustomerDisputeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [infoNote, setInfoNote] = useState("");
  const [outcome, setOutcome] = useState<"upheld" | "declined">("upheld");
  const [resolutionNote, setResolutionNote] = useState("");
  const [outcomeReference, setOutcomeReference] = useState("");

  const load = useCallback(async () => {
    if (!disputeId) return;
    setLoading(true);
    setError("");
    try {
      const found = await getAdminDispute(disputeId);
      if (!found) setError("This dispute is not available in your business.");
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

  async function run(fn: () => Promise<{ success: boolean; error?: string }>, message: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await fn();
    if (!result.success) {
      setError(result.error ?? "That action could not be completed.");
    } else {
      setSuccess(message);
      await load();
    }
    setBusy(false);
  }

  if (loading && !dispute) return <p className="text-sm text-slate-500">Loading dispute…</p>;
  if (!dispute) {
    return (
      <div className="space-y-4">
        <Notice type="error">{error || "This dispute is not available."}</Notice>
        <Link href="/susu/admin/disputes" className="btn btn-secondary inline-flex">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Customer disputes
        </Link>
      </div>
    );
  }

  const open = isOpenDispute(dispute.status);
  const canResolve = ["under_review", "awaiting_customer"].includes(dispute.status);

  return (
    <div className="space-y-5">
      <Link
        href="/susu/admin/disputes"
        className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Customer disputes
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dispute {dispute.reference}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {dispute.customerName ?? "Customer"} ({dispute.customerNumber}) ·{" "}
            {dispute.subjectType === "contribution" ? "contribution" : "withdrawal"} of{" "}
            <CediAmount amount={dispute.subjectAmount} />
          </p>
        </div>
        <DisputeStatusBadge status={dispute.status} />
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      <section className="card p-4">
        <h2 className="text-sm font-bold text-slate-900">The customer&apos;s account</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">Transaction reference</dt>
            <dd className="break-all font-mono text-xs text-slate-800">
              {dispute.subjectReference}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Account</dt>
            <dd className="text-slate-800">{dispute.accountNumber ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Category</dt>
            <dd className="text-slate-800">
              {DISPUTE_CATEGORY_LABELS[dispute.category as DisputeCategory] ??
                dispute.category}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Raised</dt>
            <dd className="text-slate-800">{fmt(dispute.createdAt)}</dd>
          </div>
        </dl>
        <div className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
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
        <h2 className="text-sm font-bold text-slate-900">Review history</h2>
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
                  {event.actorType === "customer" && (
                    <span className="ml-1 text-[11px] font-normal text-slate-400">
                      (customer)
                    </span>
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
        <section className="card space-y-4 p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <ShieldCheck className="h-4 w-4 text-brand-600" aria-hidden />
            Review actions
          </h2>

          {dispute.status === "open" && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void run(() => startDisputeReview(dispute.id), "Review started.")
              }
            >
              Start review
            </button>
          )}

          {dispute.status === "under_review" && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="text-xs font-medium text-slate-600">
                Ask the customer for information
                <textarea
                  value={infoNote}
                  onChange={(event) => setInfoNote(event.target.value)}
                  rows={2}
                  maxLength={1000}
                  className="input mt-1 w-full"
                  placeholder="State exactly what is needed."
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary mt-2"
                disabled={busy || infoNote.trim().length < 5}
                onClick={() =>
                  void run(
                    () =>
                      requestDisputeInformation({
                        disputeId: dispute.id,
                        note: infoNote,
                      }),
                    "Information request recorded."
                  )
                }
              >
                Request information
              </button>
            </div>
          )}

          {canResolve && (
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-xs text-slate-500">
                The outcome changes the dispute record only. If upheld, perform the
                correction or reversal through the normal financial control and put
                its reference below.
              </p>
              <label className="mt-2 block text-xs font-medium text-slate-600">
                Outcome
                <select
                  value={outcome}
                  onChange={(event) =>
                    setOutcome(event.target.value as "upheld" | "declined")
                  }
                  className="input mt-1 w-full"
                >
                  <option value="upheld">Upheld — the customer is right</option>
                  <option value="declined">Declined — the records stand</option>
                </select>
              </label>
              <label className="mt-2 block text-xs font-medium text-slate-600">
                What was checked and decided
                <textarea
                  value={resolutionNote}
                  onChange={(event) => setResolutionNote(event.target.value)}
                  rows={3}
                  maxLength={1000}
                  className="input mt-1 w-full"
                />
              </label>
              <label className="mt-2 block text-xs font-medium text-slate-600">
                Correction / reversal reference (only when upheld)
                <input
                  type="text"
                  value={outcomeReference}
                  onChange={(event) => setOutcomeReference(event.target.value)}
                  maxLength={120}
                  className="input mt-1 w-full"
                  placeholder="e.g. REV-C-... / REV-W-..."
                />
              </label>
              <button
                type="button"
                className="btn btn-primary mt-2"
                disabled={busy || resolutionNote.trim().length < 10}
                onClick={() =>
                  void run(
                    () =>
                      resolveCustomerDispute({
                        disputeId: dispute.id,
                        outcome,
                        note: resolutionNote,
                        outcomeReference: outcomeReference || undefined,
                      }),
                    "Outcome recorded."
                  )
                }
              >
                Record outcome
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
