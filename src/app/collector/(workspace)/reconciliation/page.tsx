"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck2, ClipboardCheck, RefreshCw } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { SkeletonTable } from "@/components/ui/Skeletons";
import { formatCedi, formatDateTime } from "@/lib/utils";
import {
  declareDailyClosing,
  getCollectorReconciliationSummary,
  listDailyClosings,
  openDailyCollectorClosing,
  recordDailyClosingHandover,
  type DailyClosingView,
  type ReconciliationOverview,
} from "@/lib/actions/susu-reconciliation.actions";
import {
  listExceptionCases,
  respondToExceptionCase,
  type ExceptionCaseView,
} from "@/lib/actions/susu-exception-cases.actions";
import { CASE_STATUS_LABELS } from "@/lib/reconciliation-policy";

const TERMINAL = ["resolved", "rejected", "dismissed"];

function dayInput(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export default function CollectorReconciliationPage() {
  const [summary, setSummary] = useState<ReconciliationOverview | null>(null);
  const [closings, setClosings] = useState<DailyClosingView[]>([]);
  const [cases, setCases] = useState<ExceptionCaseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [closingDay, setClosingDay] = useState(dayInput());
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [respondCaseId, setRespondCaseId] = useState<string | null>(null);
  const [responseNote, setResponseNote] = useState("");
  const [responseEvidence, setResponseEvidence] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [summaryResult, closingResult, caseResult] = await Promise.all([
        getCollectorReconciliationSummary(),
        listDailyClosings({ limit: 14 }),
        listExceptionCases({ limit: 50 }),
      ]);
      if (!summaryResult.success) {
        setError(summaryResult.error ?? "Your reconciliation summary could not be loaded.");
        return;
      }
      setSummary(summaryResult.data ?? null);
      if (closingResult.success) setClosings(closingResult.data?.closings ?? []);
      if (caseResult.success) setCases(caseResult.data?.cases ?? []);
    } catch {
      setError("Your reconciliation summary could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openToday() {
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const result = await openDailyCollectorClosing({ closingDate: closingDay });
      if (!result.success) {
        setError(result.error ?? "The day could not be opened.");
        return;
      }
      setSuccess("Day opened. Expected cash is from the contributions the server recorded.");
      await load();
    } catch {
      setError("The day could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitClosing(action: "declare" | "handover", closing: DailyClosingView) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a valid amount.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result =
        action === "declare"
          ? await declareDailyClosing({
              closingId: closing.id,
              declaredCash: value,
              note: note.trim() || undefined,
              evidenceRef: evidence.trim() || undefined,
            })
          : await recordDailyClosingHandover({
              closingId: closing.id,
              handoverAmount: value,
              note: note.trim() || undefined,
              evidenceRef: evidence.trim() || undefined,
            });
      if (!result.success) {
        setError(result.error ?? "The closing could not be updated.");
        return;
      }
      setSuccess(
        action === "declare"
          ? "Cash declared. Hand the cash to the office and record it once the office counts it."
          : "Handover recorded. The office must receive and close the day."
      );
      setAmount("");
      setEvidence("");
      setNote("");
      await load();
    } catch {
      setError("The closing could not be updated. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function respond(caseId: string) {
    if (responseNote.trim().length < 3) {
      setError("Write a response of at least 3 characters.");
      return;
    }
    if (!responseEvidence.trim()) {
      setError("Supply an evidence reference with your response.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await respondToExceptionCase({
        caseId,
        note: responseNote.trim(),
        evidenceRef: responseEvidence.trim(),
      });
      if (!result.success) {
        setError(result.error ?? "Your response could not be recorded.");
        return;
      }
      setSuccess("Response recorded for the branch team.");
      setRespondCaseId(null);
      setResponseNote("");
      setResponseEvidence("");
      await load();
    } catch {
      setError("Your response could not be recorded. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ClipboardCheck size={22} aria-hidden /> My reconciliation
        </h1>
        <p className="mt-1 text-sm text-muted">
          Your own daily close, differences and queries. The branch team closes the day after the
          office receives the cash.
        </p>
      </header>

      {error ? <Notice type="error" message={error}>{error}</Notice> : null}
      {success ? <Notice type="success" message={success}>{success}</Notice> : null}

      {loading && !summary ? (
        <SkeletonTable rows={3} columns={3} />
      ) : summary ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="card !p-3"><p className="text-xs text-muted">My open cases</p><p className="text-2xl font-bold">{summary.cases.open + summary.cases.assigned + summary.cases.underReview + summary.cases.awaitingEvidence + summary.cases.escalated + summary.cases.reopened}</p></div>
          <div className="card !p-3"><p className="text-xs text-muted">Overdue</p><p className={`text-2xl font-bold ${summary.cases.overdue ? "text-red-700" : ""}`}>{summary.cases.overdue}</p></div>
          <div className="card !p-3"><p className="text-xs text-muted">My outstanding cash</p><p className="text-2xl font-bold tabular-nums">{formatCedi(summary.cash.outstanding)}</p></div>
          <div className="card !p-3"><p className="text-xs text-muted">Waiting to sync</p><p className="text-2xl font-bold tabular-nums">{summary.pendingSync.queuedTransactions + summary.pendingSync.failedAttempts}</p></div>
        </div>
      ) : null}

      <section className="card space-y-3" aria-label="My daily closing">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold"><CalendarCheck2 size={16} aria-hidden /> Daily closing</h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} aria-hidden /> Refresh
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="form-group">
            <label className="form-label" htmlFor="collector-closing-day">Business day</label>
            <input id="collector-closing-day" type="date" max={dayInput()} value={closingDay} onChange={(event) => setClosingDay(event.target.value)} />
          </div>
          <div className="flex items-end">
            <button type="button" className="btn btn-primary" onClick={() => void openToday()} disabled={busy}>Open my day</button>
          </div>
        </div>

        {!closings.length ? (
          <p className="text-sm text-muted">No daily close yet. Open your day to record the cash you hold.</p>
        ) : (
          <ul className="space-y-3">
            {closings.map((closing) => {
              const actionable = closing.status === "open" || closing.status === "declared";
              return (
                <li key={closing.id} className="rounded-control border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{closing.closingDay}</p>
                      <p className="text-xs text-muted">
                        Expected {formatCedi(closing.expectedCash)} · Declared {closing.declaredCash === null ? "—" : formatCedi(closing.declaredCash)} · Handed over {closing.handoverAmount === null ? "—" : formatCedi(closing.handoverAmount)}
                      </p>
                    </div>
                    <span className="badge">{closing.status.replaceAll("_", " ")}</span>
                  </div>
                  {closing.pendingSyncCount ? <p className="mt-2 text-xs font-semibold text-amber-700">{closing.pendingSyncCount} contribution{closing.pendingSyncCount === 1 ? "" : "s"} waiting to sync. The office cannot close a balanced day until this clears.</p> : null}
                  {closing.exceptionCaseId ? <p className="mt-2 text-xs text-red-700">A difference case is linked to this day.</p> : null}
                  {actionable ? (
                    <div className="mt-3 space-y-2 border-t border-line pt-3">
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div className="form-group">
                          <label className="form-label" htmlFor={`amount-${closing.id}`}>{closing.status === "open" ? "Cash I counted" : "Cash handed over"}</label>
                          <input id={`amount-${closing.id}`} type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`evidence-${closing.id}`}>Evidence reference</label>
                          <input id={`evidence-${closing.id}`} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="Required if the amount differs" />
                        </div>
                        <div className="form-group">
                          <label className="form-label" htmlFor={`note-${closing.id}`}>Note</label>
                          <input id={`note-${closing.id}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional" />
                        </div>
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitClosing(closing.status === "open" ? "declare" : "handover", closing)} disabled={busy}>
                        {closing.status === "open" ? "Declare cash" : "Record handover"}
                      </button>
                      <p className="text-[11px] text-muted">{closing.status === "open" ? "The amount must match the cash you actually hold." : "Only the office can receive and close after this."}</p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">My open cases</h2>
        {!cases.length ? (
          <p className="text-sm text-muted">No exception case involves your collections.</p>
        ) : (
          <ul className="divide-y divide-line">
            {cases.map((entry) => (
              <li key={entry.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{entry.caseNumber} · {entry.title}</p>
                    <p className="text-xs text-muted">{CASE_STATUS_LABELS[entry.status] ?? entry.status} · {entry.dueAt ? `Due ${formatDateTime(entry.dueAt)}` : "No due date"} · {formatCedi(entry.amountAtStake ?? 0)}</p>
                    {entry.description ? <p className="mt-1 text-xs">{entry.description}</p> : null}
                  </div>
                  <span className="badge">{entry.severity}</span>
                </div>
                {!TERMINAL.includes(entry.status) ? (
                  respondCaseId === entry.id ? (
                    <div className="mt-3 space-y-2 rounded-control bg-surface-sunken p-3">
                      <div className="form-group">
                        <label className="form-label" htmlFor={`response-${entry.id}`}>Your response *</label>
                        <textarea id={`response-${entry.id}`} rows={2} value={responseNote} onChange={(event) => setResponseNote(event.target.value)} placeholder="What do you know about this difference?" />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor={`response-evidence-${entry.id}`}>Evidence reference *</label>
                        <input id={`response-evidence-${entry.id}`} value={responseEvidence} onChange={(event) => setResponseEvidence(event.target.value)} placeholder="Receipt or document reference" />
                      </div>
                      <div className="flex gap-2">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void respond(entry.id)} disabled={busy}>Send response</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRespondCaseId(null)} disabled={busy}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="mt-2 btn btn-secondary btn-sm" onClick={() => { setRespondCaseId(entry.id); setResponseNote(""); setResponseEvidence(""); }}>
                      Respond with evidence
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">A collector cannot assign, approve, resolve or close a case. Those decisions stay with the branch team.</p>
      </section>
    </div>
  );
}
