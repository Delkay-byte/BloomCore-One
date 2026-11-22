"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, ShieldCheck } from "lucide-react";
import {
  generateInvestigationDraft,
  getInvestigationAi,
  reviewInvestigationDraft,
  type AiInvestigationState,
  type DraftView,
} from "@/lib/actions/zeli-investigation.actions";
import type { InvestigationEvidence } from "@/lib/zeli/investigation/evidence";

/**
 * AI explanation desk.
 *
 * The draft is shown section by section with its citations, next to the evidence it
 * was written from. A person accepts or rejects it with a reason, and the screen says
 * plainly that neither decision changes a finding or a financial record.
 */
export function InvestigationAiPanel({ anomalyId }: { anomalyId: string }) {
  const [evidence, setEvidence] = useState<InvestigationEvidence | null>(null);
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  const [access, setAccess] = useState<AiInvestigationState["access"] | null>(null);
  const [state, setState] = useState<AiInvestigationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const result = await getInvestigationAi(anomalyId);
    if (!result.success || !result.data) {
      setError(result.error ?? "The evidence could not be assembled.");
      return;
    }
    setEvidence(result.data.evidence);
    setDrafts(result.data.drafts);
    setAccess(result.data.state.access);
    setState(result.data.state);
  }, [anomalyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<{ success: boolean; error?: string }>, message: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await action();
      if (!result.success) {
        setError(result.error ?? "That did not work.");
        return;
      }
      setSuccess(message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  return (
    <section className="mt-4 rounded-xl border border-slate-200 p-3" data-testid="ai-investigation">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-bold text-slate-900">
            <Bot size={14} aria-hidden /> Explanation draft
          </h3>
          <p className="mt-1 max-w-2xl text-[11px] text-slate-500">
            A draft explains the evidence above. Accepting it records a review of the
            wording, not a decision about money: it cannot close the finding, change a
            transaction or approve anything.
          </p>
        </div>
        <div className="text-right text-[11px] text-slate-500">
          <div>
            Prompt {state.promptVersion} · schema {state.schemaVersion}
          </div>
          <div>
            {state.externalApproved
              ? "External model available for activated packages"
              : "External model unavailable in this runtime; rules-only drafts"}
          </div>
        </div>
      </div>

      {state.disabled ? (
        <p className="notice notice-danger mt-2 text-[11px]">
          AI investigation is switched off for this deployment.
        </p>
      ) : null}
      {error ? <p className="notice notice-danger mt-2 text-[11px]">{error}</p> : null}
      {success ? <p className="notice mt-2 text-[11px]">{success}</p> : null}

      {access && !access.allowed ? (
        <div
          className={`mt-2 rounded-lg px-3 py-2 text-[11px] ${
            access.state === "payment_pending"
              ? "bg-amber-50 text-amber-900"
              : "bg-slate-50 text-slate-700"
          }`}
          data-testid="ai-eligibility"
        >
          <p className="font-semibold">AI Investigation is not active for this business</p>
          <p className="mt-0.5">{access.guidance}</p>
          <ul className="mt-1 list-disc pl-4">
            <li>
              Package purchase: {access.planName ?? "not purchased"}
              {access.paymentConfirmed
                ? ` · payment confirmed${access.paymentEndsAt ? `, period ends ${new Date(access.paymentEndsAt).toLocaleDateString()}` : ""}`
                : ""}
            </li>
            <li>
              Super Admin activation:{" "}
              {access.activationStatus === "active"
                ? `active${access.expiresAt ? ` until ${new Date(access.expiresAt).toLocaleDateString()}` : ""}`
                : access.activationStatus === "revoked"
                  ? "revoked"
                  : "required"}
            </li>
            {access.allowance !== null ? (
              <li>
                Usage this month: {access.used} of {access.allowance}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          data-testid="ai-generate"
          disabled={busy || state.disabled || !access?.allowed}
          onClick={() => run(() => generateInvestigationDraft(anomalyId), "A draft was generated.")}
        >
          Generate draft
        </button>
        {evidence ? (
          <span className="text-[11px] text-slate-500">
            Evidence {evidence.packHash.slice(0, 16)} · {evidence.sources.length} sources ·{" "}
            {evidence.missingEvidence.length} gaps
          </span>
        ) : null}
        {access?.allowed && access.allowance !== null ? (
          <span className="text-[11px] text-slate-500" data-testid="ai-usage">
            {access.remaining} of {access.allowance} left this month
          </span>
        ) : null}
      </div>

      {drafts.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">No explanation has been generated yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {drafts.map((draft) => (
            <li key={draft.id} className="rounded-lg bg-slate-50 p-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                <span className="font-semibold text-slate-900">{draft.statusLabel}</span>
                <span>{new Date(draft.createdAt).toLocaleString()}</span>
                <span>· {draft.source} ({draft.model})</span>
                <span>· evidence {draft.evidenceHash.slice(0, 12)}</span>
                {!draft.payloadValid ? (
                  <span className="text-red-600">· stored payload no longer validates</span>
                ) : null}
              </div>

              <div className="mt-2 grid gap-2 text-[11px] text-slate-700 sm:grid-cols-2">
                <div>
                  <div className="font-semibold text-slate-900">Facts</div>
                  <ul className="list-disc pl-4">
                    {draft.payload.facts?.map((fact, index) => (
                      <li key={`fact-${index}`}>
                        {fact.text}
                        <span className="block font-mono text-[10px] text-slate-400">
                          {fact.sourceRef}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {draft.payload.hypotheses?.length ? (
                    <>
                      <div className="mt-1 font-semibold text-slate-900">
                        Hypotheses (not findings)
                      </div>
                      <ul className="list-disc pl-4">
                        {draft.payload.hypotheses.map((row, index) => (
                          <li key={`hyp-${index}`}>
                            {row.text} <span className="text-slate-400">({row.confidence})</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
                <div>
                  <div className="font-semibold text-slate-900">Missing evidence</div>
                  <ul className="list-disc pl-4">
                    {draft.payload.missingEvidence?.length ? (
                      draft.payload.missingEvidence.map((row, index) => (
                        <li key={`miss-${index}`}>{row}</li>
                      ))
                    ) : (
                      <li className="text-slate-400">None recorded.</li>
                    )}
                  </ul>
                  <div className="mt-1 font-semibold text-slate-900">Limitations</div>
                  <ul className="list-disc pl-4">
                    {draft.payload.limitations?.map((row, index) => (
                      <li key={`lim-${index}`}>{row}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {draft.status === "draft" || draft.status === "reviewed" ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="input text-[11px]"
                    placeholder="What you checked before deciding"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          reviewInvestigationDraft({
                            draftId: draft.id,
                            decision: "accept",
                            reason,
                          }),
                        "Draft accepted. The finding is unchanged."
                      )
                    }
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          reviewInvestigationDraft({
                            draftId: draft.id,
                            decision: "reject",
                            reason,
                          }),
                        "Draft rejected."
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-500">
                  <ShieldCheck size={12} aria-hidden />
                  Reviewed by {draft.reviewedByName ?? "a reviewer"}
                  {draft.reviewReason ? `: ${draft.reviewReason}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default InvestigationAiPanel;
