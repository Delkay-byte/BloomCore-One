"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, MessageSquareWarning } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import {
  getCustomerDisputeSubject,
  openCustomerDispute,
  type DisputeSubjectView,
} from "@/lib/actions/customer-dispute.actions";
import {
  DISPUTE_CATEGORIES,
  DISPUTE_CATEGORY_LABELS,
  type DisputeCategory,
} from "@/lib/customer-disputes";

function NewDisputeForm() {
  const router = useRouter();
  const params = useSearchParams();
  const type = params.get("type") ?? "";
  const id = params.get("id") ?? "";
  const [subject, setSubject] = useState<DisputeSubjectView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [category, setCategory] = useState<DisputeCategory>("not_received");
  const [details, setDetails] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const found = await getCustomerDisputeSubject(type, id);
      if (!found) {
        setError("That transaction is not on your account.");
        setSubject(null);
      } else {
        setSubject(found);
      }
    } catch {
      setError("The transaction could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [type, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!subject) return;
    setSaving(true);
    setError("");
    const result = await openCustomerDispute({
      subjectType: subject.type,
      subjectId: subject.id,
      category,
      details,
    });
    if (!result.success) {
      setError(result.error ?? "The dispute could not be opened.");
      setSaving(false);
      return;
    }
    const data = result.data as { disputeId: string };
    router.push(`/customer/disputes/${data.disputeId}`);
  }

  if (loading) return <p className="text-sm text-slate-500">Loading the transaction…</p>;

  if (!subject) {
    return (
      <div className="space-y-4">
        <Notice type="error">{error || "That transaction is not available."}</Notice>
        <Link href="/customer/statement" className="btn btn-secondary inline-flex">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to statement
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link
        href="/customer/statement"
        className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> My statement
      </Link>

      <div>
        <h1 className="text-2xl font-bold text-slate-900">Raise a dispute</h1>
        <p className="mt-1 text-sm text-slate-600">
          Tell us what does not match your record. The transaction is not changed
          while the dispute is reviewed.
        </p>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      <section className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <MessageSquareWarning className="h-4 w-4 text-amber-600" aria-hidden />
          Recorded {subject.description.toLowerCase()}
        </h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">Amount</dt>
            <dd className="font-semibold text-slate-900">
              <CediAmount amount={subject.amount} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Date</dt>
            <dd className="text-slate-800">
              {new Date(subject.occurredAt).toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Reference</dt>
            <dd className="break-all font-mono text-xs text-slate-800">
              {subject.reference}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Account / cycle</dt>
            <dd className="text-slate-800">
              {subject.accountNumber} · cycle {subject.cycleNumber}
            </dd>
          </div>
        </dl>

        {subject.existingDispute ? (
          <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            A dispute already exists for this transaction.{" "}
            <Link
              href={`/customer/disputes/${subject.existingDispute.id}`}
              className="font-semibold underline"
            >
              Open {subject.existingDispute.reference}
            </Link>
            .
          </div>
        ) : (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <label className="block text-xs font-medium text-slate-600">
              What is wrong?
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as DisputeCategory)}
                className="input mt-1 w-full"
              >
                {DISPUTE_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {DISPUTE_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-600">
              What happened?
              <textarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                rows={4}
                maxLength={1000}
                className="input mt-1 w-full"
                placeholder="Include what you paid or received, when, and who handled it."
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                {details.trim().length}/1000 · at least 10 characters
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || details.trim().length < 10}
              onClick={() => void submit()}
            >
              {saving ? "Opening dispute…" : "Open dispute"}
            </button>
            <p className="text-[11px] text-slate-500">
              Your balance stays unchanged. If the review finds an error, the
              correction is recorded separately and its reference appears in the
              outcome.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

export default function NewCustomerDisputePage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <NewDisputeForm />
    </Suspense>
  );
}
