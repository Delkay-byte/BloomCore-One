"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, Clock3, FileText, History, ShieldCheck } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { SkeletonTable } from "@/components/ui/Skeletons";
import ConfirmDialog from "../../_components/ConfirmDialog";
import { formatCedi, formatDateTime } from "@/lib/utils";
import {
  addExceptionCaseNote,
  approveCaseResolution,
  assignExceptionCase,
  escalateExceptionCase,
  extendExceptionCaseDueDate,
  getExceptionCase,
  getExceptionCaseOwnerOptions,
  linkCaseRecord,
  proposeCaseResolution,
  reassignExceptionCase,
  rejectExceptionCase,
  rejectResolutionProposal,
  reopenExceptionCase,
  resolveExceptionCase,
  type ExceptionCaseView,
} from "@/lib/actions/susu-exception-cases.actions";
import {
  CASE_CATEGORY_LABELS,
  CASE_STATUS_LABELS,
} from "@/lib/reconciliation-policy";

const RESOLUTION_TYPES = [
  ["correction_posted", "Correction posted"],
  ["contribution_reversal", "Contribution reversal"],
  ["remittance_reversal", "Remittance reversal"],
  ["withdrawal_adjustment", "Withdrawal adjustment"],
  ["cash_recovered", "Cash recovered"],
  ["no_action", "No action required"],
  ["other", "Other"],
] as const;

const LINK_TYPES = [
  "contribution",
  "collector_remittance",
  "remittance_discrepancy",
  "daily_closing",
  "susu_reconciliation",
  "susu_account",
  "collector",
  "withdrawal",
  "customer_withdrawal_request",
  "provider_statement_row",
  "branch_liquidity_line",
  "shift",
  "other",
] as const;

interface OwnerOption { id: string; name: string; role: string; branchId: string | null }

type ConfirmKind = "approve" | "resolve" | "reject" | "reopen" | null;

function severityTone(severity: string) {
  return severity === "high" ? "bg-red-100 text-red-800" : severity === "medium" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700";
}

export default function ExceptionCasePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [entry, setEntry] = useState<ExceptionCaseView | null>(null);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [assignOwner, setAssignOwner] = useState("");
  const [assignReason, setAssignReason] = useState("");
  const [assignDue, setAssignDue] = useState("");
  const [note, setNote] = useState("");
  const [noteEvidence, setNoteEvidence] = useState("");
  const [extendDue, setExtendDue] = useState("");
  const [extendReason, setExtendReason] = useState("");
  const [escalateReason, setEscalateReason] = useState("");
  const [resolutionType, setResolutionType] = useState("correction_posted");
  const [resolutionNote, setResolutionNote] = useState("");
  const [resolutionEvidence, setResolutionEvidence] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [proposalRejectReason, setProposalRejectReason] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [reopenEvidence, setReopenEvidence] = useState("");
  const [linkType, setLinkType] = useState("contribution");
  const [linkId, setLinkId] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const result = await getExceptionCase(id);
      if (!result?.success || !result.data) {
        setError(result?.error ?? "That exception case was not found.");
        return;
      }
      setEntry(result.data);
      // Only offer owners who can actually be validated for this case's branch.
      const ownerResult = await getExceptionCaseOwnerOptions({ branchId: result.data.branchId });
      if (ownerResult.success) setOwners(ownerResult.data ?? []);
      setAssignOwner((current) => current || result.data!.ownerId || "");
    } catch {
      setError("The exception case could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function perform(work: () => Promise<{ success: boolean; error?: string }>, message: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await work();
      if (!result.success) {
        setError(result.error ?? "The action could not be completed.");
        return false;
      }
      setSuccess(message);
      setConfirmKind(null);
      setNote("");
      setNoteEvidence("");
      setAssignReason("");
      setExtendReason("");
      setEscalateReason("");
      setResolutionNote("");
      setResolutionEvidence("");
      setRejectReason("");
      setProposalRejectReason("");
      setReopenReason("");
      setReopenEvidence("");
      setLinkId("");
      setLinkNote("");
      await load();
      return true;
    } catch {
      setError("The action could not be completed. No financial record was changed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveAssignment() {
    if (!entry || !assignOwner) {
      setError("Choose the person who will own this case.");
      return;
    }
    if (!entry.branchId) {
      setError("Assign this case to a branch before choosing an owner.");
      return;
    }
    if (entry.ownerId) {
      if (entry.ownerId === assignOwner) {
        setError("That person already owns this case.");
        return;
      }
      if (assignReason.trim().length < 5) {
        setError("Record a reassignment reason of at least 5 characters.");
        return;
      }
      void perform(
        () => reassignExceptionCase({ caseId: entry.id, ownerId: assignOwner, reason: assignReason.trim() }),
        "Case reassigned. The reason is in the timeline."
      );
    } else {
      void perform(
        () => assignExceptionCase({ caseId: entry.id, ownerId: assignOwner, dueAt: assignDue || null, note: assignReason.trim() || undefined }),
        "Case assigned with a due date."
      );
    }
  }

  function saveNote() {
    if (!entry) return;
    if (note.trim().length < 3) {
      setError("Write a note of at least 3 characters.");
      return;
    }
    void perform(
      () => addExceptionCaseNote({ caseId: entry.id, note: note.trim(), evidenceRef: noteEvidence.trim() || null }),
      "Note added. Supplying evidence moves an awaiting-evidence case back to review."
    );
  }

  function saveExtension() {
    if (!entry) return;
    if (!extendDue) {
      setError("Choose the new due date.");
      return;
    }
    if (extendReason.trim().length < 5) {
      setError("Record why the due date is being extended.");
      return;
    }
    void perform(
      () => extendExceptionCaseDueDate({ caseId: entry.id, dueAt: new Date(`${extendDue}T23:59:59.999Z`).toISOString(), reason: extendReason.trim() }),
      "Due date extended. The previous date remains in the timeline."
    );
  }

  function saveEscalation() {
    if (!entry) return;
    if (escalateReason.trim().length < 5) {
      setError("Record why the case is being escalated.");
      return;
    }
    void perform(
      () => escalateExceptionCase({ caseId: entry.id, reason: escalateReason.trim() }),
      "Case escalated to the next operational level."
    );
  }

  function saveProposal() {
    if (!entry) return;
    if (resolutionNote.trim().length < 10) {
      setError("Record the proposed resolution (10+ characters).");
      return;
    }
    if (entry.requiresEvidence && !resolutionEvidence.trim() && !entry.evidence) {
      setError("This case needs an evidence reference before a resolution is proposed.");
      return;
    }
    void perform(
      () => proposeCaseResolution({ caseId: entry.id, resolutionType, resolutionNote: resolutionNote.trim(), evidenceRef: resolutionEvidence.trim() || null }),
      "Resolution proposed. A different authorised person must approve it where policy requires independence."
    );
  }

  function saveDirectResolution() {
    if (!entry) return;
    if (resolutionNote.trim().length < 10) {
      setError("Record the resolution (10+ characters).");
      return;
    }
    setConfirmKind("resolve");
  }

  function saveLink() {
    if (!entry) return;
    if (!linkId.trim()) {
      setError("Enter the record id to link.");
      return;
    }
    void perform(
      () => linkCaseRecord({ caseId: entry.id, entityType: linkType, entityId: linkId.trim(), note: linkNote.trim() || undefined }),
      "Record linked. The target was re-checked against this tenant and branch."
    );
  }

  function confirmAction(kind: Exclude<ConfirmKind, null>) {
    if (!entry) return;
    if (kind === "approve") {
      void perform(() => approveCaseResolution({ caseId: entry.id }), "Resolution approved and case resolved.");
    } else if (kind === "resolve") {
      void perform(
        () => resolveExceptionCase({ caseId: entry.id, resolutionType, resolutionNote: resolutionNote.trim(), evidenceRef: resolutionEvidence.trim() || null }),
        "Case resolved. The resolution and author are recorded."
      );
    } else if (kind === "reject") {
      if (rejectReason.trim().length < 5) {
        setConfirmKind(null);
        setError("Record why the case is being rejected.");
        return;
      }
      void perform(() => rejectExceptionCase({ caseId: entry.id, reason: rejectReason.trim() }), "Case rejected with a recorded reason.");
    } else if (kind === "reopen") {
      if (reopenReason.trim().length < 5 || !reopenEvidence.trim()) {
        setConfirmKind(null);
        setError("Reopening needs a reason and a new evidence reference.");
        return;
      }
      void perform(
        () => reopenExceptionCase({ caseId: entry.id, reason: reopenReason.trim(), evidenceRef: reopenEvidence.trim() }),
        "Case reopened. The reopen count and new evidence are recorded."
      );
    }
  }

  if (!id) return <Notice type="error" message="Missing case">Missing case</Notice>;

  return (
    <div className="space-y-5">
      <Link href="/susu/admin/reconciliation/exceptions" className="inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline">
        <ArrowLeft size={14} aria-hidden /> Exception queue
      </Link>

      {error ? <Notice type="error" message={error}>{error}</Notice> : null}
      {success ? <Notice type="success" message={success}>{success}</Notice> : null}

      {loading && !entry ? (
        <SkeletonTable rows={7} columns={4} />
      ) : !entry ? (
        <div className="card"><p className="text-sm text-muted">That case was not found in your scope.</p></div>
      ) : (
        <>
          <header className="card space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{entry.caseNumber}</p>
                <h1 className="mt-1 text-2xl font-bold tracking-tight">{entry.title}</h1>
                <p className="mt-1 text-sm text-muted">{CASE_CATEGORY_LABELS[entry.category] ?? entry.categoryLabel} · {entry.branchName ?? "No branch"} · {entry.collectorName ?? "No collector"}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${severityTone(entry.severity)}`}>{entry.severity}</span>
                <span className="badge">{CASE_STATUS_LABELS[entry.status] ?? entry.statusLabel}</span>
                {entry.overdue ? <span className="badge bg-red-100 text-red-800">Overdue</span> : null}
              </div>
            </div>
            {entry.description ? <p className="text-sm text-ink">{entry.description}</p> : null}
            <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div><dt className="text-xs text-muted">Amount at stake</dt><dd className="font-semibold tabular-nums">{formatCedi(entry.amountAtStake ?? 0)}</dd></div>
              <div><dt className="text-xs text-muted">Owner</dt><dd className="font-semibold">{entry.ownerName ?? "Unassigned"}</dd></div>
              <div><dt className="text-xs text-muted">Due</dt><dd className={`font-semibold ${entry.overdue ? "text-red-700" : ""}`}>{entry.dueAt ? formatDateTime(entry.dueAt) : "No due date"}</dd></div>
              <div><dt className="text-xs text-muted">Escalation</dt><dd className="font-semibold">Level {entry.escalationLevel}{entry.reopenCount ? ` · reopened ${entry.reopenCount}×` : ""}</dd></div>
            </dl>
            <div className="flex flex-wrap gap-2 text-xs">
              {entry.requiresEvidence ? <span className="badge bg-amber-100 text-amber-800">Evidence required</span> : null}
              {entry.requiresIndependentApproval ? <span className="badge bg-red-100 text-red-800"><ShieldCheck size={11} className="mr-1 inline" aria-hidden />Independent approval required</span> : null}
              <span className="badge">{entry.linkCount} linked records</span>
              <span className="badge">{entry.lineCount} reconciliation lines</span>
              {entry.sourceSession ? (
                <Link href={`/susu/admin/reconciliation/sessions/${entry.sourceSession.id}`} className="badge bg-sky-100 text-sky-800 hover:underline">
                  Source session
                </Link>
              ) : null}
            </div>
            {entry.evidence ? <p className="text-xs text-muted"><span className="font-semibold text-ink">Evidence on file:</span> {entry.evidence}</p> : null}
          </header>

          {entry.status === "resolution_proposed" ? (
            <section className="card space-y-3 border-l-4 border-l-indigo-500">
              <h2 className="flex items-center gap-2 font-semibold"><CheckCircle2 size={16} aria-hidden /> Resolution awaiting a decision</h2>
              <p className="text-sm"><span className="font-semibold">Proposed by:</span> {entry.resolutionProposedByName ?? "—"} on {entry.resolutionProposedAt ? formatDateTime(entry.resolutionProposedAt) : "—"}</p>
              <p className="text-sm"><span className="font-semibold">Type:</span> {(entry.proposedResolutionType ?? "—").replaceAll("_", " ")}</p>
              <p className="text-sm">{entry.proposedResolutionNote ?? "No note"}</p>
              {entry.proposedEvidenceRef ? <p className="text-xs text-muted">Evidence: {entry.proposedEvidenceRef}</p> : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary" onClick={() => setConfirmKind("approve")} disabled={busy}>Approve resolution</button>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="proposal-reject">Reject the proposal (case returns to review)</label>
                <textarea id="proposal-reject" rows={2} value={proposalRejectReason} onChange={(event) => setProposalRejectReason(event.target.value)} placeholder="Why is the proposal not acceptable?" />
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => {
                  if (proposalRejectReason.trim().length < 5) {
                    setError("Record why the proposal was rejected.");
                    return;
                  }
                  void perform(() => rejectResolutionProposal({ caseId: entry.id, reason: proposalRejectReason.trim() }), "Proposal rejected; the case is back under review.");
                }}
              >
                Reject proposal
              </button>
            </section>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card space-y-4">
              <h2 className="flex items-center gap-2 font-semibold"><Clock3 size={16} aria-hidden /> Assignment and timing</h2>
              <div className="form-group">
                <label className="form-label" htmlFor="case-owner">Owner</label>
                <select id="case-owner" value={assignOwner} onChange={(event) => setAssignOwner(event.target.value)}>
                  <option value="">Choose an eligible owner</option>
                  {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name} · {owner.role.replaceAll("_", " ")}</option>)}
                </select>
                <p className="mt-1 text-xs text-muted">A branch manager or finance user must belong to this case&apos;s branch.</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="assign-reason">{entry.ownerId ? "Reassignment reason *" : "Assignment note"}</label>
                <input id="assign-reason" value={assignReason} onChange={(event) => setAssignReason(event.target.value)} placeholder={entry.ownerId ? "Why is ownership changing?" : "Optional context"} />
              </div>
              {!entry.ownerId ? (
                <div className="form-group">
                  <label className="form-label" htmlFor="assign-due">Due date</label>
                  <input id="assign-due" type="date" value={assignDue} onChange={(event) => setAssignDue(event.target.value)} />
                </div>
              ) : null}
              <button type="button" className="btn btn-primary" onClick={saveAssignment} disabled={busy || !entry.branchId}>
                {entry.ownerId ? "Reassign case" : "Assign case"}
              </button>
              {!entry.branchId ? <p className="text-xs text-amber-700">This case has no branch, so a branch-scoped owner cannot be validated.</p> : null}
              <hr className="border-line" />
              <h3 className="font-semibold">Due date</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="form-group">
                  <label className="form-label" htmlFor="extend-due">New due date</label>
                  <input id="extend-due" type="date" value={extendDue} onChange={(event) => setExtendDue(event.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="extend-reason">Reason *</label>
                  <input id="extend-reason" value={extendReason} onChange={(event) => setExtendReason(event.target.value)} placeholder="Why is more time needed?" />
                </div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={saveExtension} disabled={busy}>Extend due date</button>
              <hr className="border-line" />
              <h3 className="font-semibold">Escalation</h3>
              <div className="form-group">
                <label className="form-label" htmlFor="escalate-reason">Escalation reason *</label>
                <input id="escalate-reason" value={escalateReason} onChange={(event) => setEscalateReason(event.target.value)} placeholder="What needs higher attention?" />
              </div>
              <button type="button" className="btn btn-secondary" onClick={saveEscalation} disabled={busy || entry.status === "escalated"}>Escalate</button>
            </section>

            <section className="card space-y-4">
              <h2 className="flex items-center gap-2 font-semibold"><FileText size={16} aria-hidden /> Notes and evidence</h2>
              <div className="form-group">
                <label className="form-label" htmlFor="case-note">Note *</label>
                <textarea id="case-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What did you check, and what did you find?" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="case-evidence">Evidence reference</label>
                <input id="case-evidence" value={noteEvidence} onChange={(event) => setNoteEvidence(event.target.value)} placeholder="Receipt, bank slip, statement or document reference" />
              </div>
              <button type="button" className="btn btn-primary" onClick={saveNote} disabled={busy}>Add note</button>
              <hr className="border-line" />
              <h3 className="font-semibold">Link an internal record</h3>
              <div className="form-group">
                <label className="form-label" htmlFor="link-type">Record type</label>
                <select id="link-type" value={linkType} onChange={(event) => setLinkType(event.target.value)}>
                  {LINK_TYPES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="link-id">Record id</label>
                <input id="link-id" value={linkId} onChange={(event) => setLinkId(event.target.value)} placeholder="Paste the record id" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="link-note">Link note</label>
                <input id="link-note" value={linkNote} onChange={(event) => setLinkNote(event.target.value)} placeholder="Why is this record relevant?" />
              </div>
              <button type="button" className="btn btn-secondary" onClick={saveLink} disabled={busy}>Link record</button>
            </section>
          </div>

          <section className="card space-y-4">
            <h2 className="flex items-center gap-2 font-semibold"><CheckCircle2 size={16} aria-hidden /> Resolve or close</h2>
            <p className="text-sm text-muted">
              A high-value case, or one with high severity, must be proposed and approved by a
              different person with finance authority. The same person cannot do both.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="form-group">
                <label className="form-label" htmlFor="resolution-type">Resolution type</label>
                <select id="resolution-type" value={resolutionType} onChange={(event) => setResolutionType(event.target.value)}>
                  {RESOLUTION_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="resolution-evidence">Evidence reference</label>
                <input id="resolution-evidence" value={resolutionEvidence} onChange={(event) => setResolutionEvidence(event.target.value)} placeholder="Required for financial cases" />
              </div>
              <div className="form-group md:col-span-2">
                <label className="form-label" htmlFor="resolution-note">Resolution note *</label>
                <textarea id="resolution-note" rows={3} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} placeholder="What was decided, and how was the difference cleared?" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={saveProposal}
                disabled={busy || !entry.allowedNextStatuses.includes("resolution_proposed")}
              >
                Propose resolution
              </button>
              {!entry.requiresIndependentApproval ? (
                <button type="button" className="btn btn-secondary" onClick={saveDirectResolution} disabled={busy}>
                  Resolve directly
                </button>
              ) : (
                <span className="self-center text-xs text-muted">Independent approval is required; use propose then approve.</span>
              )}
            </div>
            <hr className="border-line" />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <h3 className="font-semibold">Reject this case</h3>
                <div className="form-group">
                  <label className="form-label" htmlFor="reject-reason">Reason *</label>
                  <input id="reject-reason" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="Why is the case not valid?" />
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => setConfirmKind("reject")} disabled={busy || entry.status === "resolution_proposed"}>Reject case</button>
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold">Reopen a closed case</h3>
                <div className="form-group">
                  <label className="form-label" htmlFor="reopen-reason">Reason *</label>
                  <input id="reopen-reason" value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} placeholder="What new information exists?" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="reopen-evidence">New evidence *</label>
                  <input id="reopen-evidence" value={reopenEvidence} onChange={(event) => setReopenEvidence(event.target.value)} placeholder="A closed case needs new evidence to reopen" />
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => setConfirmKind("reopen")} disabled={busy || !["resolved", "rejected", "dismissed"].includes(entry.status)}>Reopen case</button>
              </div>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card">
              <h2 className="flex items-center gap-2 font-semibold"><FileText size={16} aria-hidden /> Linked records</h2>
              {!entry.links.length ? <p className="mt-2 text-sm text-muted">No records are linked yet.</p> : (
                <ul className="mt-3 divide-y divide-line text-sm">
                  {entry.links.map((link) => (
                    <li key={link.id} className="py-2">
                      <p className="font-semibold">{link.entityType.replaceAll("_", " ")}</p>
                      <p className="break-all font-mono text-[11px] text-muted">{link.entityId}</p>
                      {link.note ? <p className="text-xs text-muted">{link.note}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
              {entry.lines.length ? (
                <>
                  <h3 className="mt-4 font-semibold">Reconciliation lines</h3>
                  <ul className="mt-2 space-y-2 text-sm">
                    {entry.lines.map((line) => (
                      <li key={line.id} className="rounded-control border border-line px-3 py-2">
                        <p className="font-semibold">{line.entityType.replaceAll("_", " ")} · {line.status}</p>
                        <p className="text-xs text-muted">{formatCedi(line.variance)} variance · revision {line.revision}</p>
                        {line.reason ? <p className="text-xs">{line.reason}</p> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>

            <section className="card">
              <h2 className="flex items-center gap-2 font-semibold"><History size={16} aria-hidden /> Full history ({entry.events.length})</h2>
              <ol className="mt-3 space-y-3">
                {entry.events.map((event) => (
                  <li key={event.id} className="border-l-2 border-line pl-3">
                    <p className="text-sm font-semibold">{event.type.replaceAll("_", " ")}</p>
                    <p className="text-xs text-muted">{formatDateTime(event.createdAt)} · {event.actorName ?? "System"}{event.actorRole ? ` (${event.actorRole})` : ""}</p>
                    {event.fromStatus || event.toStatus ? <p className="text-xs">Status: {event.fromStatus ?? "—"} → {event.toStatus ?? "—"}</p> : null}
                    {event.reason ? <p className="text-xs"><span className="font-semibold">Reason:</span> {event.reason}</p> : null}
                    {event.note ? <p className="text-xs">{event.note}</p> : null}
                    {event.evidenceRef ? <p className="text-xs text-muted">Evidence: {event.evidenceRef}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmKind === "approve"}
        title="Approve this resolution?"
        description="This closes the case and records you as the independent approver."
        confirmLabel="Approve and resolve"
        busy={busy}
        onConfirm={() => confirmAction("approve")}
        onClose={() => setConfirmKind(null)}
      />
      <ConfirmDialog
        open={confirmKind === "resolve"}
        title="Resolve this case directly?"
        description="Only a case that does not require independent approval can be closed this way."
        confirmLabel="Resolve case"
        busy={busy}
        onConfirm={() => confirmAction("resolve")}
        onClose={() => setConfirmKind(null)}
      />
      <ConfirmDialog
        open={confirmKind === "reject"}
        title="Reject this case?"
        description="The case closes as rejected. It can only be reopened with new evidence."
        confirmLabel="Reject case"
        busy={busy}
        onConfirm={() => confirmAction("reject")}
        onClose={() => setConfirmKind(null)}
      >
        <p>{rejectReason}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmKind === "reopen"}
        title="Reopen this case?"
        description="The new evidence and reason become part of the permanent history."
        confirmLabel="Reopen case"
        busy={busy}
        onConfirm={() => confirmAction("reopen")}
        onClose={() => setConfirmKind(null)}
      >
        <p>{reopenReason}</p>
        <p className="mt-2 text-xs text-muted">Evidence: {reopenEvidence}</p>
      </ConfirmDialog>
    </div>
  );
}
