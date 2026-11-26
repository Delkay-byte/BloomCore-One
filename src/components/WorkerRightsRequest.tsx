"use client";

import { useState } from "react";
import { submitMySubjectRightsRequest } from "@/lib/actions/risk-governance.actions";

const TYPES = [
  { value: "access", label: "Access my shared-risk record" },
  { value: "correction", label: "Correct inaccurate information" },
  { value: "objection", label: "Object to processing and freeze matching signals" },
  { value: "challenge", label: "Challenge a shared signal and freeze matching signals" },
  { value: "complaint_review", label: "Complaint or human review" },
] as const;

/** Employee/agent self-service rights intake. Identity is resolved from the session server-side. */
export default function WorkerRightsRequest() {
  const [type, setType] = useState<(typeof TYPES)[number]["value"]>("access");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [caseRef, setCaseRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCaseRef(null);
    try {
      const result = await submitMySubjectRightsRequest({ type, details });
      if (!result.success) {
        setError(result.error ?? "The request could not be recorded.");
        return;
      }
      setCaseRef(result.data?.caseRef ?? null);
      setDetails("");
    } catch {
      setError("The request could not be recorded. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h2 className="text-sm font-bold text-slate-900">Exercise your data protection rights</h2>
      <p className="mt-1 text-xs text-slate-600">
        Submit a request directly to the privacy team. Objection, challenge and complaint requests
        freeze matching shared signals while the case is reviewed. Acknowledgement is due within 3
        business days (excluding weekends and gazetted Ghana public holidays) and resolution within
        21 calendar days, with at most one reasoned 14-day extension. Exercising a right never
        automatically affects your employment.
      </p>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <label className="block text-xs font-medium text-slate-700">
          Request type
          <select
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={type}
            onChange={(event) => setType(event.target.value as (typeof TYPES)[number]["value"])}
            disabled={busy}
          >
            {TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-slate-700">
          What should the privacy team review?
          <textarea
            className="mt-1 min-h-24 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            minLength={10}
            maxLength={2000}
            required
            disabled={busy}
            placeholder="Give enough detail for the privacy team to identify and answer your request."
          />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || details.trim().length < 10}>
          {busy ? "Submitting…" : "Submit request"}
        </button>
      </form>
      <div aria-live="polite" className="mt-3 text-xs">
        {caseRef && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
            Recorded. Your case reference is <strong>{caseRef}</strong>. Keep it for correspondence.
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">{error}</p>
        )}
      </div>
    </section>
  );
}
