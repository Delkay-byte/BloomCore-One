"use client";

/**
 * "How do we know this?" for one transaction.
 *
 * An owner investigating a finding needs to see what the record actually rests on
 * before they accuse anybody. This panel shows the provenance levels reached, the
 * timeline of events, and the honest note that no network has confirmed anything.
 */

import { useState } from "react";
import { Loader2, ShieldQuestion } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  getTransactionProvenance,
  type TransactionProvenance,
} from "@/lib/actions/evidence-provenance.actions";

export default function EvidenceProvenancePanel() {
  const [transactionId, setTransactionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<TransactionProvenance | null>(null);

  async function load() {
    setError("");
    setData(null);
    if (!transactionId.trim()) {
      setError("Enter the transaction reference you are checking.");
      return;
    }
    setBusy(true);
    try {
      const result = await getTransactionProvenance(transactionId.trim());
      if (result.success) setData(result.data);
      else setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm"
      data-testid="evidence-provenance"
    >
      <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
        <ShieldQuestion size={15} aria-hidden /> What a record rests on
      </h2>
      <p className="mt-1 max-w-2xl text-xs text-slate-600">
        Check how one transaction is known before you act on a finding. A record typed by
        an employee, a device capture, attached evidence and an imported statement match
        are each listed for what they are.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs font-medium text-slate-700">
          Transaction id or reference
          <input
            className="input mt-1 w-72 text-sm"
            value={transactionId}
            onChange={(event) => setTransactionId(event.target.value)}
            placeholder="Paste the transaction id"
            data-testid="provenance-input"
          />
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => void load()}
          data-testid="provenance-check"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          Check
        </button>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      {data && (
        <div className="mt-3 space-y-3 text-xs" data-testid="provenance-result">
          <p className="font-semibold text-slate-900">
            {data.provenance.level ? data.provenance.explanation : "Not in your records."}
          </p>

          <ol className="flex flex-wrap gap-1">
            {data.provenance.labels.map((level, index) => (
              <li
                key={level}
                className={
                  index === data.provenance.labels.length - 1
                    ? "rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white"
                    : "rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700"
                }
              >
                {level.replace(/_/g, " ")}
              </li>
            ))}
          </ol>

          {data.timeline.length > 0 && (
            <ul className="space-y-1">
              {data.timeline.map((row, index) => (
                <li key={`${row.label}-${index}`} className="flex flex-wrap gap-1 text-slate-700">
                  <span className="text-slate-400">
                    {row.at ? new Date(row.at).toLocaleString() : "undated"}
                  </span>
                  <span className="font-medium">{row.label}</span>
                  {row.detail ? <span className="text-slate-500">· {row.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}

          {data.provenance.notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-4 text-slate-600">
              {data.provenance.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}

          {data.provenance.nextStep && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-700">
              Next step: {data.provenance.nextStep}
            </p>
          )}

          {!data.providerIntegrationAvailable && (
            <p className="text-[11px] text-slate-500">
              No live provider integration is connected for this business yet, so nothing
              here can be marked confirmed by a network.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
