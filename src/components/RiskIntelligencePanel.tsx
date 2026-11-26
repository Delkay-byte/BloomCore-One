"use client";

/**
 * Shared risk intelligence console.
 *
 * Three things a business owner can do here, and nothing else: join or leave, ask about
 * someone they already employ, and see or withdraw what they have shared. There is no
 * list of people, no search across the network and no way to mark anybody.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, Users } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  getRiskIntelligenceConsent,
  joinRiskIntelligence,
  listMyRiskSignals,
  querySharedRiskSignals,
  withdrawMyRiskSignal,
  withdrawRiskIntelligence,
  type RiskConsentView,
} from "@/lib/actions/risk-intelligence.actions";
import type { RiskQueryResult } from "@/lib/risk-intelligence/policy";
import { submitSubjectRightsRequest } from "@/lib/actions/risk-governance.actions";
import RiskSignalContribution from "@/components/RiskSignalContribution";

interface StaffOption {
  id: string;
  fullName: string;
  role: string;
}

export default function RiskIntelligencePanel({ staff }: { staff: StaffOption[] }) {
  const [consent, setConsent] = useState<RiskConsentView | null>(null);
  const [signals, setSignals] = useState<
    { id: string; category: string; severity: string; status: string; expiresAt: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const [answer, setAnswer] = useState<{
    result: RiskQueryResult;
    subjectLabel: string;
    explanation: readonly string[];
  } | null>(null);
  const [rightsType, setRightsType] = useState("access");
  const [rightsDetails, setRightsDetails] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("");

  const load = useCallback(async () => {
    const [consentResult, signalResult] = await Promise.all([
      getRiskIntelligenceConsent(),
      listMyRiskSignals(),
    ]);
    if (consentResult.success && consentResult.data) setConsent(consentResult.data);
    if (signalResult.success && signalResult.data) setSignals(signalResult.data.signals);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function run(action: () => Promise<{ success: boolean; error?: string }>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (result.success) {
        setNotice(message);
        await load();
      } else {
        setError(result.error ?? "That did not work.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    setBusy(true);
    setError("");
    setNotice("");
    setAnswer(null);
    try {
      const result = await querySharedRiskSignals({ userId: subject, reason });
      if (result.success && result.data) setAnswer(result.data);
      else setError(result.success ? "That did not work." : (result.error ?? "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  if (!consent) {
    return (
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading shared risk settings…
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm"
      data-testid="risk-intelligence"
    >
      <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
        <Users size={15} aria-hidden /> Shared agent risk intelligence
      </h2>
      <p className="mt-1 max-w-2xl text-xs text-slate-600">
        A prompt to check, shared between businesses that choose to take part. It is never a
        list of flagged people, and nothing here blocks anyone from a job.
      </p>

      {error && <Notice type="error">{error}</Notice>}
      {notice && <Notice type="success">{notice}</Notice>}

      {consent.active ? (
        <div className="mt-3 space-y-3 text-xs">
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
            Joined on {consent.consentedAt ? new Date(consent.consentedAt).toLocaleDateString() : "—"} ·
            policy {consent.policyVersion} ·{" "}
            {consent.scope === "query_only" ? "query only, sharing nothing" : "sharing and receiving signals"} ·{" "}
            {consent.signalCount} signal{consent.signalCount === 1 ? "" : "s"} currently shared
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-700">
              Ask about someone you already employ
              <select
                className="input mt-1 w-full text-sm"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                data-testid="risk-subject"
              >
                <option value="">Choose an employee</option>
                {staff.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Why are you asking? (recorded)
              <input
                className="input mt-1 w-full text-sm"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Considering a cash-handling role"
                data-testid="risk-reason"
              />
            </label>
          </div>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !subject || reason.trim().length < 10}
            onClick={() => void ask()}
            data-testid="risk-ask"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            Check shared signals
          </button>

          {answer && (
            <div className="rounded-lg border border-slate-100 px-3 py-2" data-testid="risk-answer">
              {answer.result.allowed ? (
                <>
                  <p className="font-semibold text-slate-900">{answer.result.headline}</p>
                  {answer.result.signals.length > 0 && (
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-700">
                      {answer.result.signals.map((row) => (
                        <li key={row.category}>
                          {row.label} · reported by {row.contributorBand} · most recent{" "}
                          {new Date(row.mostRecentObservation).toLocaleDateString()} ·{" "}
                          {row.severity} severity
                        </li>
                      ))}
                    </ul>
                  )}
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-500">
                    {answer.result.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <ul
                className="mt-2 list-disc space-y-1 border-t border-slate-100 pt-2 pl-4 text-slate-600"
                data-testid="risk-disclosure-explanation"
              >
                {answer.explanation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {!answer.result.allowed ? (
                <p className="text-slate-700">{answer.result.guidance}</p>
              ) : null}
            </div>
          )}

          {consent.scope === "share_signals" && (
            <RiskSignalContribution key={subject} subject={subject} onContributed={() => void load()} />
          )}

          {signals.length > 0 && (
            <div>
              <p className="font-semibold text-slate-900">What you have shared</p>
              <ul className="mt-1 space-y-1">
                {signals.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 text-slate-700">
                    <span className="font-mono text-[11px]">{row.category}</span>
                    <span>· {row.status}</span>
                    <span>· expires {new Date(row.expiresAt).toLocaleDateString()}</span>
                    {row.status === "open" && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              withdrawMyRiskSignal({
                                id: row.id,
                                reason: "The underlying record was explained and no longer applies.",
                              }),
                            "Signal withdrawn."
                          )
                        }
                      >
                        Withdraw
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-lg border border-slate-100 px-3 py-2" data-testid="risk-rights">
            <p className="font-semibold text-slate-900">Employee rights request</p>
            <p className="mt-1 text-slate-600">
              Access, correction, objection, challenge and complaint/review requests are
              recorded as secure cases. An objection or challenge freezes the subject for every
              key version until a BloomCore privacy administrator decides.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-medium text-slate-700">
                Employee
                <select
                  className="input mt-1 w-full text-sm"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                >
                  <option value="">Choose an employee</option>
                  {staff.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-700">
                Request type
                <select
                  className="input mt-1 w-full text-sm"
                  value={rightsType}
                  onChange={(event) => setRightsType(event.target.value)}
                >
                  <option value="access">Access</option>
                  <option value="correction">Correction</option>
                  <option value="objection">Objection</option>
                  <option value="challenge">Challenge</option>
                  <option value="complaint_review">Complaint / review</option>
                </select>
              </label>
            </div>
            <label className="mt-2 block text-xs font-medium text-slate-700">
              What the employee is asking for
              <input
                className="input mt-1 w-full text-sm"
                value={rightsDetails}
                onChange={(event) => setRightsDetails(event.target.value)}
                placeholder="Record the request without another business's report"
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-xs mt-2"
              disabled={busy || !subject || rightsDetails.trim().length < 10}
              onClick={() =>
                void run(
                  () =>
                    submitSubjectRightsRequest({
                      subjectUserId: subject,
                      type: rightsType,
                      details: rightsDetails,
                    }),
                  "Rights request submitted. The subject stays frozen while it is reviewed."
                )
              }
            >
              Submit rights request
            </button>
          </div>

          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <label className="text-xs font-medium text-slate-700">
              Leave shared risk intelligence
              <input
                className="input mt-1 w-full text-sm"
                value={withdrawReason}
                onChange={(event) => setWithdrawReason(event.target.value)}
                placeholder="Why you are leaving (recorded)"
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-xs mt-2"
              disabled={busy || withdrawReason.trim().length < 10}
              onClick={() =>
                void run(
                  () => withdrawRiskIntelligence({ reason: withdrawReason }),
                  "You have left. Your signals are no longer shared."
                )
              }
            >
              Leave and stop sharing
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-xs">
          {!consent.configured && (
            <Notice type="warning">
              Shared intelligence is not configured on this deployment yet, so joining is
              disabled. Your business is not enrolled.
            </Notice>
          )}
          <ul className="list-disc space-y-1 pl-4 text-slate-700">
            {consent.promises.map((promise) => (
              <li key={promise}>{promise}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !consent.configured}
              onClick={() =>
                void run(
                  () =>
                    joinRiskIntelligence({
                      scope: "share_signals",
                      acceptedPolicyVersion: consent.currentPolicyVersion,
                    }),
                  "Joined. Your business now shares and receives signals."
                )
              }
            >
              <ShieldCheck size={13} aria-hidden /> Join shared intelligence
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || !consent.configured}
              onClick={() =>
                void run(
                  () =>
                    joinRiskIntelligence({
                      scope: "query_only",
                      acceptedPolicyVersion: consent.currentPolicyVersion,
                    }),
                  "Joined in query-only mode. Nothing of yours is shared."
                )
              }
            >
              Receive only, share nothing
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
