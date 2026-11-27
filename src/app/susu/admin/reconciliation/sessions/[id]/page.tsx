"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Play, ShieldCheck } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { SkeletonStatCards, SkeletonTable } from "@/components/ui/Skeletons";
import { PromptDialog } from "@/components/ui/Modal";
import ConfirmDialog from "../../_components/ConfirmDialog";
import { formatCedi, formatDateTime } from "@/lib/utils";
import {
  closeReconciliationSession,
  getReconciliationSession,
  raiseCasesForSession,
  reconcileSession,
  reviewReconciliationLine,
  reviewReconciliationSession,
  type ReconciliationLineView,
  type ReconciliationSessionDetail,
} from "@/lib/actions/susu-reconciliation.actions";

const LINE_TONE: Record<string, string> = {
  matched: "bg-emerald-100 text-emerald-800",
  reviewed: "bg-sky-100 text-sky-800",
  shortfall: "bg-red-100 text-red-800",
  overage: "bg-amber-100 text-amber-800",
  unmatched: "bg-red-50 text-red-800",
  duplicate: "bg-orange-100 text-orange-800",
  missing_evidence: "bg-amber-100 text-amber-800",
  sync_failure: "bg-red-100 text-red-800",
  pending_sync: "bg-slate-100 text-slate-700",
};

function amount(value: number | null) {
  return value === null ? "—" : formatCedi(value);
}

export default function ReconciliationSessionPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [session, setSession] = useState<ReconciliationSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selectedLine, setSelectedLine] = useState<ReconciliationLineView | null>(null);
  const [lineNote, setLineNote] = useState("");
  const [lineEvidence, setLineEvidence] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmReview, setConfirmReview] = useState(false);
  const [confirmRaise, setConfirmRaise] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const result = await getReconciliationSession(id);
      if (!result?.success || !result.data) {
        setError(result?.error ?? "That reconciliation session was not found.");
        return;
      }
      setSession(result.data);
      setSelectedLine((current) => {
        if (!current) return current;
        return result.data!.lines.find((line) => line.id === current.id) ?? null;
      });
    } catch {
      setError("The reconciliation session could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const latestLines = useMemo(() => {
    if (!session) return [] as ReconciliationLineView[];
    const latest = new Map<string, ReconciliationLineView>();
    for (const line of session.lines) {
      const current = latest.get(line.fingerprint);
      if (!current || line.revision > current.revision) latest.set(line.fingerprint, line);
    }
    return [...latest.values()];
  }, [session]);

  async function runDetection() {
    if (!session) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await reconcileSession(session.id);
      if (!result.success) {
        setError(result.error ?? "Detection could not be completed.");
        return;
      }
      setSuccess(
        `Detection completed: ${result.data?.created ?? 0} new, ${result.data?.updated ?? 0} refreshed, ${result.data?.revisions ?? 0} revisions.`
      );
      await load();
    } catch {
      setError("Detection could not be completed. Nothing financial was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewSession() {
    if (!session) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await reviewReconciliationSession({ sessionId: session.id });
      if (!result.success) {
        setError(result.error ?? "The session could not be reviewed.");
        return;
      }
      setSuccess("Session reviewed. The observations remain available.");
      setConfirmReview(false);
      await load();
    } catch {
      setError("The session could not be reviewed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function closeSession() {
    if (!session) return;
    if (closeReason.trim().length < 5) {
      setError("Record a close reason of at least 5 characters.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await closeReconciliationSession({
        sessionId: session.id,
        reason: closeReason.trim(),
      });
      if (!result.success) {
        setError(result.error ?? "The session could not be closed.");
        return;
      }
      setSuccess("Session closed. It is now immutable.");
      setCloseOpen(false);
      setConfirmClose(false);
      setCloseReason("");
      await load();
    } catch {
      setError("The session could not be closed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function raiseCases() {
    if (!session) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await raiseCasesForSession(session.id);
      if (!result.success) {
        setError(result.error ?? "Cases could not be raised.");
        return;
      }
      setSuccess(
        result.data?.created
          ? `${result.data.created} case${result.data.created === 1 ? "" : "s"} raised.`
          : "No case-free unresolved lines remain."
      );
      setConfirmRaise(false);
      await load();
    } catch {
      setError("Cases could not be raised. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewLine() {
    if (!selectedLine) return;
    if (lineNote.trim().length < 5) {
      setError("Record a review note of at least 5 characters.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await reviewReconciliationLine({
        lineId: selectedLine.id,
        note: lineNote.trim(),
        evidenceRef: lineEvidence.trim() || null,
        caseId: selectedLine.exceptionCaseId,
      });
      if (!result.success) {
        setError(result.error ?? "The line could not be reviewed.");
        return;
      }
      setSuccess("Difference reviewed. A later run will preserve this revision.");
      setLineNote("");
      setLineEvidence("");
      setSelectedLine(null);
      await load();
    } catch {
      setError("The line could not be reviewed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!id) return <Notice type="error" message="Missing session">Missing session</Notice>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/susu/admin/reconciliation" className="inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline">
          <ArrowLeft size={14} aria-hidden /> Workspace
        </Link>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runDetection()} disabled={busy || loading || session?.status === "closed"}>
            <Play size={13} aria-hidden /> {busy ? "Working…" : "Run detection"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmReview(true)} disabled={busy || !["matched", "case_created"].includes(session?.status ?? "")}>
            Review
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmRaise(true)} disabled={busy || session?.status === "closed"}>
            Raise cases
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCloseOpen(true)} disabled={busy || !["reviewed", "matched", "case_created"].includes(session?.status ?? "")}>
            Close session
          </button>
        </div>
      </div>

      {error ? <Notice type="error" message={error}>{error}</Notice> : null}
      {success ? <Notice type="success" message={success}>{success}</Notice> : null}

      {loading && !session ? (
        <SkeletonStatCards count={5} />
      ) : !session ? (
        <div className="card"><p className="text-sm text-muted">That session was not found.</p></div>
      ) : (
        <>
          <header className="card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Reconciliation session</p>
                <h1 className="mt-1 text-xl font-bold capitalize">{session.type.replaceAll("_", " ")} · {session.branchName ?? "No branch"}</h1>
                <p className="mt-1 text-sm text-muted">
                  {session.collectorName ?? "All collectors"} · {new Date(session.periodStart).toLocaleDateString()} to {new Date(session.periodEnd).toLocaleDateString()}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Opened {formatDateTime(session.openedAt)} · {session.runCount} run{session.runCount === 1 ? "" : "s"} · definition v{session.definitionVersion}
                </p>
              </div>
              <span className="badge text-sm">{session.statusLabel}</span>
            </div>
          </header>

          {session.summary ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
              <div className="card !p-3"><p className="text-xs text-muted">Expected</p><p className="text-lg font-bold tabular-nums">{formatCedi(session.summary.expectedTotal)}</p></div>
              <div className="card !p-3"><p className="text-xs text-muted">Declared</p><p className="text-lg font-bold tabular-nums">{formatCedi(session.summary.declaredTotal)}</p></div>
              <div className="card !p-3"><p className="text-xs text-muted">Handed over</p><p className="text-lg font-bold tabular-nums">{formatCedi(session.summary.handedOverTotal)}</p></div>
              <div className="card !p-3"><p className="text-xs text-muted">Received</p><p className="text-lg font-bold tabular-nums">{formatCedi(session.summary.receivedTotal)}</p></div>
              <div className="card !p-3"><p className="text-xs text-muted">Outstanding</p><p className={"text-lg font-bold tabular-nums " + (session.summary.outstandingTotal ? "text-red-700" : "")}>{formatCedi(session.summary.outstandingTotal)}</p></div>
              <div className="card !p-3"><p className="text-xs text-muted">Pending sync</p><p className="text-lg font-bold tabular-nums">{formatCedi(session.summary.pendingSyncAmount)}</p><p className="text-[11px] text-muted">{session.summary.pendingSyncCount} waiting</p></div>
            </div>
          ) : null}

          <section className="card overflow-hidden !p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="font-semibold">Differences ({latestLines.length} latest)</h2>
              <p className="text-xs text-muted">Every run keeps unreviewed rows in place and appends a revision once reviewed.</p>
            </div>
            {!session.lines.length ? (
              <p className="p-4 text-sm text-muted">No detection has run yet. Run detection to observe existing records.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr><th>Status</th><th>Record</th><th>Expected</th><th>Received</th><th>Variance</th><th>Reason</th><th>Revision</th><th /></tr>
                  </thead>
                  <tbody>
                    {session.lines.map((line) => (
                      <tr key={line.id} className={line.revision > 1 ? "bg-surface-sunken/40" : ""}>
                        <td>
                          <span className={`badge ${LINE_TONE[line.status] ?? "bg-slate-100 text-slate-700"}`}>{line.statusLabel}</span>
                        </td>
                        <td className="text-xs">
                          <p className="font-medium">{line.entityType.replaceAll("_", " ")}</p>
                          <p className="font-mono text-[11px] text-muted">{line.entityId.slice(0, 12)}</p>
                        </td>
                        <td className="tabular-nums">{amount(line.expectedAmount)}</td>
                        <td className="tabular-nums">{amount(line.receivedAmount)}</td>
                        <td className={`tabular-nums ${line.variance > 0 ? "text-red-700" : line.variance < 0 ? "text-amber-700" : ""}`}>{formatCedi(line.variance)}</td>
                        <td className="max-w-[26rem] text-xs">{line.reason ?? "—"}</td>
                        <td className="text-xs">r{line.revision}</td>
                        <td>
                          {line.exceptionCaseId ? (
                            <Link href={`/susu/admin/reconciliation/exceptions/${line.exceptionCaseId}`} className="text-xs font-semibold text-brand-700 hover:underline">
                              Case
                            </Link>
                          ) : line.status !== "matched" && line.status !== "reviewed" ? (
                            <button
                              type="button"
                              className="text-xs font-semibold text-brand-700 hover:underline"
                              onClick={() => {
                                setSelectedLine(line);
                                setLineNote("");
                                setLineEvidence("");
                              }}
                            >
                              Review
                            </button>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {selectedLine ? (
            <section className="card space-y-3" aria-label="Review a difference">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Review difference</h2>
                  <p className="text-sm text-muted">{selectedLine.reason ?? selectedLine.statusLabel}</p>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelectedLine(null)}>Cancel</button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="form-group">
                  <label className="form-label" htmlFor="line-note">Review note *</label>
                  <textarea id="line-note" value={lineNote} onChange={(event) => setLineNote(event.target.value)} rows={2} placeholder="Explain how the difference was checked" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="line-evidence">Evidence reference</label>
                  <input id="line-evidence" value={lineEvidence} onChange={(event) => setLineEvidence(event.target.value)} placeholder="Receipt, bank slip or case number" />
                </div>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => void reviewLine()} disabled={busy}>
                Save review
              </button>
            </section>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card">
              <h2 className="font-semibold">Raised cases</h2>
              {!session.cases.length ? (
                <p className="mt-2 text-sm text-muted">No case has been raised from this session.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {session.cases.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
                      <div>
                        <Link href={`/susu/admin/reconciliation/exceptions/${entry.id}`} className="text-sm font-semibold text-brand-700 hover:underline">
                          {entry.caseNumber} · {entry.title}
                        </Link>
                        <p className="text-xs text-muted">{entry.status} · {formatCedi(entry.amountAtStake ?? 0)} at stake</p>
                      </div>
                      <span className="badge">{entry.severity}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card">
              <h2 className="font-semibold">Session history</h2>
              <ul className="mt-3 space-y-1 text-sm text-muted">
                <li>Opened {formatDateTime(session.openedAt)} by {session.openedByName ?? "a staff member"}</li>
                <li>Last run {session.lastRunAt ? formatDateTime(session.lastRunAt) : "not run yet"}</li>
                {session.closedAt ? <li>Closed {formatDateTime(session.closedAt)}: {session.closeReason}</li> : null}
              </ul>
            </section>
          </div>
        </>
      )}

      <PromptDialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        onSubmit={() => {
          if (closeReason.trim().length < 5) {
            setError("Record a close reason of at least 5 characters.");
            return;
          }
          setCloseOpen(false);
          setConfirmClose(true);
        }}
        title="Close this reconciliation session"
        description="Closed sessions are immutable. Raise any cases before closing."
        label="Close reason *"
        placeholder="Why is this review complete?"
        confirmLabel="Continue"
        required
        value={closeReason}
        onChange={setCloseReason}
        multiline
      />
      <ConfirmDialog
        open={confirmClose}
        title="Close reconciliation session?"
        description="No further detection or line reviews will be accepted for this session."
        confirmLabel="Close session"
        busy={busy}
        onConfirm={() => void closeSession()}
        onClose={() => setConfirmClose(false)}
      >
        <p>{closeReason}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmReview}
        title="Mark this session reviewed?"
        description="This confirms the current observations without changing any money record."
        confirmLabel="Mark reviewed"
        busy={busy}
        onConfirm={() => void reviewSession()}
        onClose={() => setConfirmReview(false)}
      />
      <ConfirmDialog
        open={confirmRaise}
        title="Raise cases for unresolved differences?"
        description="One case is raised per branch, collector and category. Repeating this is safe."
        confirmLabel="Raise cases"
        busy={busy}
        onConfirm={() => void raiseCases()}
        onClose={() => setConfirmRaise(false)}
      />
    </div>
  );
}
