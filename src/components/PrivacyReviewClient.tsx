"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Notice from "@/components/ui/Notice";
import RiskOrganisationSettingsForm from "@/components/RiskOrganisationSettingsForm";
import type { RiskOrganisationSettings } from "@/lib/risk-intelligence/organisation-profile";
import {
  acknowledgeRightsRequest,
  activateParticipationAgreement,
  assignRightsReviewer,
  countersignParticipationAgreement,
  escalateBadFaithReport,
  expelBusinessFromSharedRegister,
  extendLegalHold,
  extendRightsDeadline,
  freezeRiskSignal,
  freezeRiskSubject,
  placeLegalHold,
  recordKeyRotation,
  recordRightsCommunication,
  reinstateBusinessParticipation,
  retireKeyVersion,
  reinstateExpelledBusiness,
  releaseLegalHold,
  releaseRiskSignalFreeze,
  resolveRiskSubjectFreeze,
  resolveRightsRequest,
  runRiskRetentionSweep,
  setGlobalRiskControl,
  setParticipationVerification,
  setPrivacyAccess,
  suspendBusinessParticipation,
  verifyRightsIdentity,
} from "@/lib/actions/risk-governance.actions";

type Result = { success: boolean; error?: string };

interface CountersignRow {
  id: string; businessName: string; type: string; version: string; documentSha256: string;
  acceptedAt: string | null; signatoryName: string; signatoryRole: string;
}
interface ActivationRow {
  id: string; businessName: string; type: string; version: string; countersignedAt: string | null;
}
interface CaseRow {
  caseRef: string; type: string; status: string; ackDeadline: string; resolutionDeadline: string;
  effectiveDeadline: string; reviewerId: string | null; identityVerified: boolean;
  decision: string | null; receivedAt: string;
}
interface ReviewerRow { userId: string; fullName: string; email: string; role: string }
interface GrantRow { userId: string; fullName: string; email: string; role: string; reason: string; createdAt: string }
interface CandidateRow { userId: string; fullName: string; email: string }
interface ParticipantRow {
  tenantId: string; businessName: string; scope: string; suspendedAt: string | null;
  expelledAt: string | null; eligibilityVerified: boolean; controllerRegistrationChecked: boolean;
}
interface FreezeRow {
  id: string; subjectKey: string; caseRef: string | null; reason: string; frozenAt: string;
}
interface SignalRow {
  id: string; businessName: string; category: string; status: string; frozenAt: string | null;
}
interface HoldRow {
  id: string; scopeType: string; scopeId: string; businessName: string; reason: string;
  reviewDate: string; extensionUntil: string | null;
}
interface KeyRow { version: number; status: string; activatedAt: string; retiredAt: string | null }

function fmt(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "—";
}
function daysUntil(value: string) {
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
}

export default function PrivacyReviewClient({
  role, currentUserId, globalEnabled, globalReason, cases, awaitingCountersignature,
  awaitingActivation, reviewerOptions, grants, adminCandidates, participants, freezes,
  frozenSignals, holds, keys, organisationSettings,
}: {
  role: string; currentUserId: string | null; globalEnabled: boolean | null; globalReason: string | null;
  cases: CaseRow[]; awaitingCountersignature: CountersignRow[]; awaitingActivation: ActivationRow[];
  reviewerOptions: ReviewerRow[]; grants: GrantRow[]; adminCandidates: CandidateRow[];
  participants: ParticipantRow[]; freezes: FreezeRow[]; frozenSignals: SignalRow[];
  holds: HoldRow[]; keys: KeyRow[]; organisationSettings: RiskOrganisationSettings;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [caseRef, setCaseRef] = useState(cases[0]?.caseRef ?? "");
  const [caseMessage, setCaseMessage] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [identityEvidence, setIdentityEvidence] = useState("");
  const [identityVerified, setIdentityVerified] = useState(false);
  const [decision, setDecision] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [closeCase, setCloseCase] = useState(true);
  const [freezeOutcome, setFreezeOutcome] = useState("");
  const [freezeName, setFreezeName] = useState("");
  const [freezePhone, setFreezePhone] = useState("");
  const [freezeDecision, setFreezeDecision] = useState<"upheld" | "rejected" | "restored">("restored");
  const [freezeReason, setFreezeReason] = useState("");
  const [signalId, setSignalId] = useState("");
  const [signalReason, setSignalReason] = useState("");
  const [badFaithReason, setBadFaithReason] = useState("");
  const [badFaithEvidence, setBadFaithEvidence] = useState("");
  const [holdScopeType, setHoldScopeType] = useState<"signal" | "subject" | "request">("signal");
  const [holdScopeId, setHoldScopeId] = useState("");
  const [holdReference, setHoldReference] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [selectedHold, setSelectedHold] = useState("");
  const [extensionDate, setExtensionDate] = useState("");
  const [businessTenantId, setBusinessTenantId] = useState(participants[0]?.tenantId ?? "");
  const [businessReason, setBusinessReason] = useState("");
  const [businessEvidence, setBusinessEvidence] = useState("");
  const [verificationReason, setVerificationReason] = useState("");
  const [eligibility, setEligibility] = useState(true);
  const [registrationChecked, setRegistrationChecked] = useState(true);
  const [keyNew, setKeyNew] = useState(String((keys[0]?.version ?? 0) + 1));
  const [keyPrevious, setKeyPrevious] = useState(String(keys[0]?.version ?? 1));
  const [keyReason, setKeyReason] = useState("");
  const [grantUserId, setGrantUserId] = useState("");
  const [grantRole, setGrantRole] = useState<"privacy_admin" | "privacy_reviewer">("privacy_reviewer");
  // The retired dpo alias is historical only and grants no current authority.
  const isPrivacyAdmin = role === "privacy_admin";
  const [grantReason, setGrantReason] = useState("");

  const selectedCase = useMemo(() => cases.find((row) => row.caseRef === caseRef) ?? null, [cases, caseRef]);
  const caseFreezes = useMemo(() => freezes.filter((row) => row.caseRef === caseRef), [freezes, caseRef]);
  const selectedHoldRow = holds.find((row) => row.id === selectedHold) ?? null;

  async function run(action: () => Promise<Result>, success: string) {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await action();
      if (!result.success) { setError(result.error ?? "That action did not work."); return; }
      setMessage(success); router.refresh();
    } finally { setBusy(false); }
  }

  async function refreshRetention() {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await runRiskRetentionSweep();
      if (!result.success || !result.data) { setError(result.error ?? "The sweep did not run."); return; }
      setMessage(`Sweep complete: ${result.data.expired} expired, ${result.data.scrubbed} scrubbed, ${result.data.audited} disclosures audited.`);
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-4" data-testid="privacy-review">
      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h1 className="text-base font-bold text-slate-900">Privacy review</h1>
        <p className="mt-1 text-xs text-slate-600">
          Signed in as {role}. Every action is recorded. No contributing business report is shown here.
        </p>
        {message && <Notice type="success">{message}</Notice>}
        {error && <Notice type="error">{error}</Notice>}
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Global Risk Intelligence:{" "}
          <strong>{globalEnabled === null ? "following deployment configuration" : globalEnabled ? "enabled" : "disabled"}</strong>
          {globalReason ? ` · ${globalReason}` : ""}
        </div>
        <label className="mt-3 block text-xs font-medium text-slate-700">
          Reason for global or business-level control (recorded)
          <textarea className="input mt-1 w-full text-sm" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || reason.trim().length < 10}
            onClick={() => void run(() => setGlobalRiskControl({ enabled: false, reason }), "Global Risk Intelligence disabled. Queries now return an explicit unavailable response.")}>
            Disable globally
          </button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || reason.trim().length < 10}
            onClick={() => void run(() => setGlobalRiskControl({ enabled: true, reason }), "Global Risk Intelligence reinstated.")}>
            Reinstate globally
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Subject rights adjudication</h2>
        <p className="mt-1 text-xs text-slate-600">Acknowledge within 3 business days, resolve within 21 calendar days, one reasoned 14-day extension before the deadline. Frozen signals stay frozen until the case decision settles them.</p>
        {cases.length === 0 ? <p className="mt-3 text-xs text-slate-500">No subject rights cases have been received.</p> : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500"><tr><th className="py-1 pr-2">Case</th><th className="py-1 pr-2">Type</th><th className="py-1 pr-2">Status</th><th className="py-1 pr-2">Acknowledge by</th><th className="py-1 pr-2">Resolve by</th><th className="py-1 pr-2">Identity</th><th className="py-1" /></tr></thead>
                <tbody>{cases.map((row) => (
                  <tr key={row.caseRef} className="border-t border-slate-100">
                    <td className="py-1 pr-2 font-mono text-[11px]">{row.caseRef}</td>
                    <td className="py-1 pr-2">{row.type}</td>
                    <td className="py-1 pr-2">{row.status}</td>
                    <td className={`py-1 pr-2 ${daysUntil(row.ackDeadline) < 0 ? "font-semibold text-red-700" : ""}`}>{fmt(row.ackDeadline)}</td>
                    <td className={`py-1 pr-2 ${daysUntil(row.effectiveDeadline) < 0 ? "font-semibold text-red-700" : ""}`}>{fmt(row.effectiveDeadline)}</td>
                    <td className="py-1 pr-2">{row.identityVerified ? "verified" : "not verified"}</td>
                    <td className="py-1"><button type="button" className="btn btn-secondary btn-xs" onClick={() => { setCaseRef(row.caseRef); setCaseMessage(""); }}>Select</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {selectedCase && (
              <div className="mt-4 space-y-2 rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-semibold text-slate-900">Selected {selectedCase.caseRef} · {selectedCase.type} · {selectedCase.status}</p>
                {caseFreezes.length > 0 && <p className="text-xs text-amber-800">{caseFreezes.length} linked subject freeze(s) must be settled when this case closes.</p>}
                <label className="block text-xs font-medium text-slate-700">Acknowledgement or case communication
                  <textarea className="input mt-1 w-full text-sm" rows={2} value={caseMessage} onChange={(event) => setCaseMessage(event.target.value)} /></label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-secondary btn-xs" disabled={busy || caseMessage.trim().length < 10}
                    onClick={() => void run(() => acknowledgeRightsRequest({ caseRef, message: caseMessage }), "Case acknowledged and the communication recorded.")}>Acknowledge</button>
                  <button type="button" className="btn btn-secondary btn-xs" disabled={busy || caseMessage.trim().length < 10}
                    onClick={() => void run(() => recordRightsCommunication({ caseRef, message: caseMessage }), "Outbound communication recorded.")}>Record communication</button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs font-medium text-slate-700">Assign authorised reviewer
                    <select className="input mt-1 w-full text-sm" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}>
                      <option value="">Choose a reviewer</option>
                      {reviewerOptions.map((row) => <option key={row.userId} value={row.userId}>{row.fullName} · {row.role}</option>)}
                    </select></label>
                  <button type="button" className="btn btn-secondary btn-xs self-end" disabled={busy || !reviewerId}
                    onClick={() => void run(() => assignRightsReviewer({ caseRef, reviewerId }), "Reviewer assigned.")}>Assign</button>
                </div>
                <label className="block text-xs font-medium text-slate-700">Identity evidence (what was checked; never a document copy)
                  <textarea className="input mt-1 w-full text-sm" rows={2} value={identityEvidence} onChange={(event) => setIdentityEvidence(event.target.value)} /></label>
                <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={identityVerified} onChange={(event) => setIdentityVerified(event.target.checked)} /> Identity verified by a permitted method</label>
                <button type="button" className="btn btn-secondary btn-xs" disabled={busy || identityEvidence.trim().length < 10}
                  onClick={() => void run(() => verifyRightsIdentity({ caseRef, evidenceMetadata: identityEvidence, verified: identityVerified }), "Identity verification recorded.")}>Record identity check</button>
                <label className="block text-xs font-medium text-slate-700">One 14-day extension reason (only before the original deadline)
                  <textarea className="input mt-1 w-full text-sm" rows={2} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} /></label>
                <button type="button" className="btn btn-secondary btn-xs" disabled={busy || decisionReason.trim().length < 20}
                  onClick={() => void run(() => extendRightsDeadline({ caseRef, writtenReason: decisionReason }), "One 14-day extension recorded and communicated as required.")}>Extend deadline</button>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs font-medium text-slate-700">Decision<select className="input mt-1 w-full text-sm" value={decision} onChange={(event) => setDecision(event.target.value)}>
                    <option value="">Choose a decision</option><option value="upheld">Upheld</option><option value="rejected">Rejected</option><option value="partly_upheld">Partly upheld</option><option value="no_data_held">No data held</option></select></label>
                  <label className="text-xs font-medium text-slate-700">Linked freeze outcome<select className="input mt-1 w-full text-sm" value={freezeOutcome} onChange={(event) => setFreezeOutcome(event.target.value)}>
                    <option value="">Choose if a freeze is linked</option><option value="upheld">Upheld — withdraw frozen signals</option><option value="rejected">Rejected — restore frozen signals</option></select></label>
                </div>
                <label className="block text-xs font-medium text-slate-700">Decision reason (recorded)
                  <textarea className="input mt-1 w-full text-sm" rows={2} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} /></label>
                <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={closeCase} onChange={(event) => setCloseCase(event.target.checked)} /> Close the case after this decision</label>
                <button type="button" className="btn btn-primary btn-xs" disabled={busy || decision.trim().length < 3 || decisionReason.trim().length < 20 || (caseFreezes.length > 0 && !freezeOutcome)}
                  onClick={() => void run(() => resolveRightsRequest({ caseRef, decision, reason: decisionReason, closeCase, freezeOutcome: freezeOutcome || undefined }), "Decision recorded and any linked freeze settled in the same transaction.")}>Resolve case</button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Subject freezes</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <input className="input text-sm" placeholder="Full name as recorded" value={freezeName} onChange={(event) => setFreezeName(event.target.value)} />
          <input className="input text-sm" placeholder="Phone number as recorded" value={freezePhone} onChange={(event) => setFreezePhone(event.target.value)} />
          <input className="input text-sm" placeholder="Reason (min 10)" value={freezeReason} onChange={(event) => setFreezeReason(event.target.value)} />
        </div>
        <button type="button" className="btn btn-secondary btn-xs mt-2" disabled={busy || freezeName.trim().length < 3 || freezePhone.trim().length < 9 || freezeReason.trim().length < 10}
          onClick={() => void run(() => freezeRiskSubject({ fullName: freezeName, phone: freezePhone, reason: freezeReason }), "Matching subject keys frozen.")}>Freeze subject</button>
        <div className="mt-3 space-y-2">
          {freezes.length === 0 ? <p className="text-xs text-slate-500">No active subject freezes.</p> : freezes.map((row) => (
            <div key={row.id} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
              <p className="font-mono text-[11px]">{row.subjectKey.slice(0, 18)}… · {row.caseRef ?? "no case"}</p>
              <p className="text-slate-600">{row.reason} · frozen {fmt(row.frozenAt)}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select className="input text-xs" value={freezeDecision} onChange={(event) => setFreezeDecision(event.target.value as typeof freezeDecision)}>
                  <option value="upheld">Upheld</option><option value="rejected">Rejected</option><option value="restored">Restored</option>
                </select>
                <input className="input text-xs" placeholder="Decision reason" value={freezeReason} onChange={(event) => setFreezeReason(event.target.value)} />
                <button type="button" className="btn btn-secondary btn-xs" disabled={busy || freezeReason.trim().length < 10}
                  onClick={() => void run(() => resolveRiskSubjectFreeze({ freezeId: row.id, decision: freezeDecision, reason: freezeReason }), "Freeze decision recorded; matching signals updated.")}>Resolve</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Signal freezes and bad-faith escalation</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <input className="input text-sm" placeholder="Signal id" value={signalId} onChange={(event) => setSignalId(event.target.value)} />
          <input className="input text-sm" placeholder="Reason (min 10)" value={signalReason} onChange={(event) => setSignalReason(event.target.value)} />
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !signalId || signalReason.trim().length < 10}
            onClick={() => void run(() => freezeRiskSignal({ signalId, reason: signalReason }), "Signal frozen.")}>Freeze signal</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !signalId || signalReason.trim().length < 10}
            onClick={() => void run(() => releaseRiskSignalFreeze({ signalId, reason: signalReason }), "Signal freeze released.")}>Release signal</button>
        </div>
        {frozenSignals.length > 0 && (
          <div className="mt-3 space-y-1 text-xs">
            {frozenSignals.map((row) => (
              <button key={row.id} type="button" className="block w-full rounded border border-slate-200 px-2 py-1 text-left hover:border-slate-300" onClick={() => { setSignalId(row.id); setSignalReason(""); }}>
                <span className="font-mono text-[11px]">{row.id}</span> · {row.category} · {row.status} · {row.businessName}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <input className="input text-sm" placeholder="Evidence reference (min 5)" value={badFaithEvidence} onChange={(event) => setBadFaithEvidence(event.target.value)} />
          <input className="input text-sm" placeholder="Bad-faith escalation reason (min 30)" value={badFaithReason} onChange={(event) => setBadFaithReason(event.target.value)} />
        </div>
        <button type="button" className="btn btn-secondary btn-xs mt-2" disabled={busy || !signalId || badFaithReason.trim().length < 30 || badFaithEvidence.trim().length < 5}
          onClick={() => void run(() => escalateBadFaithReport({ signalId, reason: badFaithReason, evidenceReference: badFaithEvidence }), "Bad-faith escalation recorded; the contributing business is suspended pending review.")}>Escalate bad faith</button>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Scoped legal holds</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <select className="input text-sm" value={holdScopeType} onChange={(event) => setHoldScopeType(event.target.value as typeof holdScopeType)}>
            <option value="signal">Signal</option><option value="subject">Subject key</option><option value="request">Rights case</option>
          </select>
          <input className="input text-sm" placeholder="Scope id" value={holdScopeId} onChange={(event) => setHoldScopeId(event.target.value)} />
          <input className="input text-sm" placeholder="Hold reference" value={holdReference} onChange={(event) => setHoldReference(event.target.value)} />
          <input className="input text-sm sm:col-span-2" placeholder="Reason (min 10)" value={holdReason} onChange={(event) => setHoldReason(event.target.value)} />
        </div>
        <button type="button" className="btn btn-secondary btn-xs mt-2" disabled={busy || !holdScopeId || !holdReference || holdReason.trim().length < 10}
          onClick={() => void run(() => placeLegalHold({ scopeType: holdScopeType, scopeId: holdScopeId, reference: holdReference, reason: holdReason }), "Legal hold placed with a 14-day review date.")}>Place hold</button>
        <div className="mt-3 space-y-1 text-xs">
          {holds.length === 0 ? <p className="text-slate-500">No active legal holds.</p> : holds.map((row) => (
            <button key={row.id} type="button" className={`block w-full rounded border px-2 py-1 text-left ${selectedHold === row.id ? "border-brand-500 bg-brand-50" : "border-slate-200"}`} onClick={() => { setSelectedHold(row.id); setExtensionDate(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)); }}>
              {row.scopeType} · {row.scopeId} · {row.businessName} · review {fmt(row.reviewDate)}
              {row.extensionUntil ? ` · extended to ${fmt(row.extensionUntil)}` : ""}
            </button>
          ))}
        </div>
        {selectedHoldRow && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input type="date" className="input text-xs" value={extensionDate} onChange={(event) => setExtensionDate(event.target.value)} />
            <input className="input text-xs" placeholder="Hold reason" value={holdReason} onChange={(event) => setHoldReason(event.target.value)} />
            <button type="button" className="btn btn-secondary btn-xs" disabled={busy || holdReason.trim().length < 10 || !extensionDate}
              onClick={() => void run(() => extendLegalHold({ holdId: selectedHoldRow.id, extensionUntil: new Date(extensionDate + "T23:59:59.000Z").toISOString(), reason: holdReason }), "Hold extension recorded.")}>Extend</button>
            <button type="button" className="btn btn-secondary btn-xs" disabled={busy || holdReason.trim().length < 10}
              onClick={() => void run(() => releaseLegalHold({ holdId: selectedHoldRow.id, reason: holdReason }), "Legal hold released.")}>Release</button>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Business participation</h2>
        {participants.length === 0 ? <p className="mt-2 text-xs text-slate-500">No active participating businesses.</p> : (
          <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-slate-500"><tr><th className="py-1 pr-2">Business</th><th className="py-1 pr-2">Scope</th><th className="py-1 pr-2">Eligibility</th><th className="py-1 pr-2">Controller register</th><th className="py-1 pr-2">State</th><th className="py-1" /></tr></thead><tbody>
            {participants.map((row) => (
              <tr key={row.tenantId} className="border-t border-slate-100"><td className="py-1 pr-2">{row.businessName}</td><td className="py-1 pr-2">{row.scope}</td><td className="py-1 pr-2">{row.eligibilityVerified ? "verified" : "unverified"}</td><td className="py-1 pr-2">{row.controllerRegistrationChecked ? "checked" : "unchecked"}</td><td className="py-1 pr-2">{row.expelledAt ? "expelled" : row.suspendedAt ? "suspended" : "active"}</td><td className="py-1"><button type="button" className="btn btn-secondary btn-xs" onClick={() => { setBusinessTenantId(row.tenantId); setReason(""); }}>Select</button></td></tr>
            ))}</tbody></table></div>
        )}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <select className="input text-sm" value={businessTenantId} onChange={(event) => setBusinessTenantId(event.target.value)}>
            <option value="">Choose business</option>{participants.map((row) => <option key={row.tenantId} value={row.tenantId}>{row.businessName}</option>)}
          </select>
          <input className="input text-sm" placeholder="Evidence reference for expulsion (min 5)" value={businessEvidence} onChange={(event) => setBusinessEvidence(event.target.value)} />
          <input className="input text-sm sm:col-span-2" placeholder="Business control reason (min 10; expulsion needs 30)" value={businessReason} onChange={(event) => setBusinessReason(event.target.value)} />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !businessTenantId || businessReason.trim().length < 10}
            onClick={() => void run(() => suspendBusinessParticipation({ tenantId: businessTenantId, reason: businessReason }), "Business participation suspended.")}>Suspend</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !businessTenantId || businessReason.trim().length < 10}
            onClick={() => void run(() => reinstateBusinessParticipation({ tenantId: businessTenantId, reason: businessReason }), "Business participation reinstated.")}>Reinstate</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !businessTenantId || businessReason.trim().length < 30 || businessEvidence.trim().length < 5}
            onClick={() => void run(() => expelBusinessFromSharedRegister({ tenantId: businessTenantId, reason: businessReason, evidenceReference: businessEvidence }), "Business expelled from the shared register.")}>Expel</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !businessTenantId || businessReason.trim().length < 10}
            onClick={() => void run(() => reinstateExpelledBusiness({ tenantId: businessTenantId, reason: businessReason }), "Expelled business reinstated.")}>Reinstate expulsion</button>
        </div>
        <div className="mt-4 border-t border-slate-100 pt-3">
          <p className="text-xs font-semibold text-slate-900">Participation verification</p>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-700">
            <label className="flex items-center gap-1"><input type="checkbox" checked={eligibility} onChange={(event) => setEligibility(event.target.checked)} /> Eligible business</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={registrationChecked} onChange={(event) => setRegistrationChecked(event.target.checked)} /> Controller registration checked</label>
            <input className="input text-xs" placeholder="Verification reason" value={verificationReason} onChange={(event) => setVerificationReason(event.target.value)} />
            <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !businessTenantId || verificationReason.trim().length < 10}
              onClick={() => void run(() => setParticipationVerification({ tenantId: businessTenantId, eligibilityVerified: eligibility, controllerRegistrationChecked: registrationChecked, reason: verificationReason }), "Participation verification recorded.")}>Record verification</button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Agreements awaiting countersignature and activation</h2>
        {awaitingCountersignature.length === 0 && awaitingActivation.length === 0 ? <p className="mt-2 text-xs text-slate-500">Nothing is awaiting BloomCore execution.</p> : null}
        <div className="mt-2 space-y-2">
          {awaitingCountersignature.map((row) => (
            <div key={row.id} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
              <p className="font-semibold text-slate-900">{row.businessName} · {row.type} v{row.version} · accepted {fmt(row.acceptedAt)}</p>
              <p className="text-slate-600">Business signatory: {row.signatoryName} ({row.signatoryRole}) · SHA-256 {row.documentSha256.slice(0, 16)}…</p>
              <button type="button" className="btn btn-secondary btn-xs mt-1" disabled={busy}
                onClick={() => void run(() => countersignParticipationAgreement({ agreementId: row.id }), "Agreement countersigned with the configured BloomCore signatory.")}>Countersign</button>
            </div>
          ))}
          {awaitingActivation.map((row) => (
            <div key={row.id} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
              <p className="font-semibold text-slate-900">{row.businessName} · {row.type} v{row.version} · countersigned {fmt(row.countersignedAt)}</p>
              <button type="button" className="btn btn-secondary btn-xs mt-1" disabled={busy}
                onClick={() => void run(() => activateParticipationAgreement({ agreementId: row.id }), "Agreement activated for live participation.")}>Activate</button>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Key rotation and retention</h2>
        <p className="mt-1 text-xs text-slate-600">Key metadata only. The actual salt is supplied by the managed secret provider and never entered here.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <input className="input text-sm" inputMode="numeric" placeholder="New version" value={keyNew} onChange={(event) => setKeyNew(event.target.value)} />
          <input className="input text-sm" inputMode="numeric" placeholder="Previous version" value={keyPrevious} onChange={(event) => setKeyPrevious(event.target.value)} />
          <input className="input text-sm sm:col-span-2" placeholder="Rotation reason (min 10)" value={keyReason} onChange={(event) => setKeyReason(event.target.value)} />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || keyReason.trim().length < 10}
            onClick={() => void run(() => recordKeyRotation({ newVersion: Number(keyNew), previousVersion: Number(keyPrevious), reason: keyReason }), "Key rotation metadata recorded.")}>Record rotation</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || keyReason.trim().length < 10}
            onClick={() => void run(() => retireKeyVersion({ version: Number(keyPrevious), reason: keyReason }), "Non-active key version retired. The active key cannot be retired.")}>Retire previous version</button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void refreshRetention()}>Run retention sweep</button>
        </div>
        <div className="mt-2 space-y-1 text-xs text-slate-700">
          {keys.length === 0 ? <p className="text-slate-500">No key metadata recorded.</p> : keys.map((row) => <p key={row.version}>v{row.version} · {row.status} · activated {fmt(row.activatedAt)}{row.retiredAt ? ` · retired ${fmt(row.retiredAt)}` : ""}</p>)}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">BloomCore legal identity and hosting</h2>
        <p className="mt-1 text-xs text-slate-600">These facts populate the controlled instruments and the public privacy addendum. Do not enter invented details. TIN is never displayed publicly.</p>
        <div className="mt-3"><RiskOrganisationSettingsForm settings={organisationSettings} canEdit={isPrivacyAdmin} /></div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">Privacy access grants</h2>
        <p className="mt-1 text-xs text-slate-600">A privacy administrator can grant or revoke access. Every change is a control event. No DPO appointment is required.</p>
        <div className="mt-2 space-y-1 text-xs">
          {grants.map((row) => (
            <div key={row.userId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-2 py-1">
              <span>{row.fullName} · {row.role} · {row.email || row.userId}{row.userId === currentUserId ? " · you" : ""}</span>
              {isPrivacyAdmin && <button type="button" className="btn btn-secondary btn-xs" disabled={busy || grantReason.trim().length < 10}
                onClick={() => void run(() => setPrivacyAccess({ userId: row.userId, role: row.role as "privacy_admin" | "privacy_reviewer", active: false, reason: grantReason }), "Privacy access revoked.")}>Revoke</button>}
            </div>
          ))}
        </div>
        {isPrivacyAdmin && (
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <select className="input text-sm" value={grantUserId} onChange={(event) => setGrantUserId(event.target.value)}>
              <option value="">Choose administrator</option>{adminCandidates.map((row) => <option key={row.userId} value={row.userId}>{row.fullName} · {row.email}</option>)}
            </select>
            <select className="input text-sm" value={grantRole} onChange={(event) => setGrantRole(event.target.value as typeof grantRole)}><option value="privacy_reviewer">Privacy reviewer</option><option value="privacy_admin">Privacy administrator</option></select>
            <input className="input text-sm sm:col-span-2" placeholder="Grant reason (min 10)" value={grantReason} onChange={(event) => setGrantReason(event.target.value)} />
            <button type="button" className="btn btn-secondary btn-xs sm:col-span-4" disabled={busy || !grantUserId || grantReason.trim().length < 10}
              onClick={() => void run(() => setPrivacyAccess({ userId: grantUserId, role: grantRole, active: true, reason: grantReason }), "Privacy access granted.")}>Grant access</button>
          </div>
        )}
      </div>
    </section>
  );
}
