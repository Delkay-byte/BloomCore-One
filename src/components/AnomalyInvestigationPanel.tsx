"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import {
  addAnomalyInvestigationComment,
  assignAnomaly,
  closeAnomalyInvestigation,
  completeAnomalyInvestigationTask,
  createAnomalySuppression,
  getAnomalyInvestigation,
  listAnomalyScanRuns,
  listAnomalySuppressions,
  reopenAnomalyFinding,
  revokeAnomalySuppression,
  setAnomalyInvestigationStatus,
  type InvestigationView,
  type ScanRunView,
  type SuppressionView,
} from "@/lib/actions/anomaly-investigation.actions";
import { ANOMALY_INVESTIGATION_NOTE, DISPOSITIONS, DISPOSITION_LABELS } from "@/lib/anomaly-investigation";

/**
 * Investigation desk for anomaly findings.
 *
 * The finding list answers "what looks wrong". This panel answers "who owns it,
 * what did they check, and why is it closed" — and keeps a rule that is deliberately
 * quiet visible with an expiry, instead of it silently disappearing.
 */
export function AnomalyInvestigationPanel({
  anomalies,
  staff,
}: {
  anomalies: Array<{ id: string; title: string; ruleKey: string; severity: string; status: string }>;
  staff: Array<{ id: string; fullName: string }>;
}) {
  const [selectedId, setSelectedId] = useState<string>(anomalies[0]?.id ?? "");
  const [view, setView] = useState<InvestigationView | null>(null);
  const [runs, setRuns] = useState<ScanRunView[]>([]);
  const [suppressions, setSuppressions] = useState<SuppressionView[]>([]);
  const [limits, setLimits] = useState<{
    alertBudget: number;
    quietHours: number;
    maxSuppressionDays: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [assigneeId, setAssigneeId] = useState("");
  const [comment, setComment] = useState("");
  const [disposition, setDisposition] = useState<(typeof DISPOSITIONS)[number]>("genuine");
  const [closeNote, setCloseNote] = useState("");
  const [correctionType, setCorrectionType] = useState("momoTransaction");
  const [correctionId, setCorrectionId] = useState("");
  const [suppressDays, setSuppressDays] = useState("30");
  const [reopenNote, setReopenNote] = useState("");
  const [suppressionRule, setSuppressionRule] = useState("");
  const [suppressionReason, setSuppressionReason] = useState("");
  const [suppressionDays, setSuppressionDays] = useState("30");
  const [revokeReason, setRevokeReason] = useState("");

  const selected = anomalies.find((row) => row.id === selectedId) ?? null;

  const loadInvestigation = useCallback(async (anomalyId: string) => {
    if (!anomalyId) return;
    const result = await getAnomalyInvestigation(anomalyId);
    if (result.success && result.data) {
      setView(result.data);
      setAssigneeId(result.data.assigneeId ?? "");
    } else {
      setError(result.error ?? "The investigation could not be loaded.");
    }
  }, []);

  const loadOperations = useCallback(async () => {
    const [runResult, suppressionResult] = await Promise.all([
      listAnomalyScanRuns(),
      listAnomalySuppressions(),
    ]);
    if (runResult.success && runResult.data) {
      setRuns(runResult.data);
      if (runResult.limits) setLimits(runResult.limits);
    }
    if (suppressionResult.success && suppressionResult.data) {
      setSuppressions(suppressionResult.data);
    }
  }, []);

  useEffect(() => {
    void loadInvestigation(selectedId);
  }, [selectedId, loadInvestigation]);

  useEffect(() => {
    void loadOperations();
  }, [loadOperations]);

  async function run(
    action: () => Promise<{ success: boolean; error?: string }>,
    message: string
  ) {
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
      await loadInvestigation(selectedId);
      await loadOperations();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <ClipboardList size={15} aria-hidden /> Anomaly investigations
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-slate-600">{ANOMALY_INVESTIGATION_NOTE}</p>
        </div>
        {limits ? (
          <p className="text-xs text-slate-500">
            Alert budget: {limits.alertBudget} new alerts per scan, one per finding every{" "}
            {limits.quietHours}h. Suppression is capped at {limits.maxSuppressionDays} days.
          </p>
        ) : null}
      </div>

      {error ? <p className="notice notice-danger mt-3 text-xs">{error}</p> : null}
      {success ? <p className="notice mt-3 text-xs">{success}</p> : null}

      {!selected ? (
        <p className="mt-3 text-xs text-slate-500">
          No finding is open to investigate. Run a scan, then come back here to own the
          investigation.
        </p>
      ) : null}

      {selected ? (
        <>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-xs font-semibold text-slate-700">
          Finding
          <select
            className="input mt-1 py-1"
            data-testid="investigation-finding"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {anomalies.map((row) => (
              <option key={row.id} value={row.id}>
                {row.severity.toUpperCase()} · {row.title}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-700">
          Owner
          <select
            className="input mt-1 py-1"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.fullName}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="investigation-assign"
            disabled={busy || !assigneeId}
            onClick={() =>
              run(
                () => assignAnomaly({ anomalyId: selectedId, assigneeId }),
                "Investigation assigned."
              )
            }
          >
            Assign
          </button>
        </div>
        <div className="text-xs text-slate-600">
          <div>Status: {view?.statusLabel ?? "—"}</div>
          <div>
            Due:{" "}
            {view?.dueAt
              ? `${new Date(view.dueAt).toLocaleDateString()}${view.overdue ? " (overdue)" : ""}`
              : "no clock started"}
          </div>
          <div>Reopened: {view?.reopenCount ?? 0}×</div>
        </div>
      </div>

      {view && view.status !== "closed" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {(["investigating", "awaiting_evidence", "open"] as const).map((status) => (
            <button
              key={status}
              type="button"
              className="btn btn-secondary btn-xs"
              disabled={busy || view.status === status}
              onClick={() =>
                run(
                  () => setAnomalyInvestigationStatus({ anomalyId: selectedId, status }),
                  "Investigation status updated."
                )
              }
            >
              {status === "awaiting_evidence"
                ? "Waiting for evidence"
                : status === "investigating"
                  ? "Investigating"
                  : "Move back to open"}
            </button>
          ))}
        </div>
      ) : null}
        </>
      ) : null}

      {view ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-xs font-bold text-slate-900">What to check</h3>
            <ul className="mt-2 space-y-1">
              {view.tasks.map((task) => (
                <li key={task.id} className="flex items-start gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={task.done}
                    disabled={busy || view.status === "closed"}
                    onChange={(event) =>
                      run(
                        () =>
                          completeAnomalyInvestigationTask({
                            anomalyId: selectedId,
                            taskId: task.id,
                            done: event.target.checked,
                          }),
                        "Checklist updated."
                      )
                    }
                  />
                  <span>
                    {task.label}
                    {task.doneByName ? (
                      <span className="block text-slate-400">
                        {task.doneByName}
                        {task.doneAt ? ` · ${new Date(task.doneAt).toLocaleDateString()}` : ""}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>

            <h3 className="mt-4 text-xs font-bold text-slate-900">Close with a decision</h3>
            <div className="mt-2 grid gap-2">
              <select
                className="input py-1 text-xs"
                value={disposition}
                onChange={(event) =>
                  setDisposition(event.target.value as typeof disposition)
                }
              >
                {DISPOSITIONS.map((value) => (
                  <option key={value} value={value}>
                    {DISPOSITION_LABELS[value]}
                  </option>
                ))}
              </select>
              <textarea
                className="input text-xs"
                rows={2}
                maxLength={1000}
                placeholder="What was checked and what the decision was"
                value={closeNote}
                onChange={(event) => setCloseNote(event.target.value)}
              />
              {disposition === "genuine" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    className="input py-1 text-xs"
                    value={correctionType}
                    onChange={(event) => setCorrectionType(event.target.value)}
                  >
                    <option value="momoTransaction">MoMo transaction / reversal</option>
                    <option value="branchTransfer">Branch transfer</option>
                    <option value="dailyAccount">Daily account</option>
                  </select>
                  <input
                    className="input text-xs"
                    placeholder="Correction record id"
                    value={correctionId}
                    onChange={(event) => setCorrectionId(event.target.value)}
                  />
                </div>
              ) : null}
              {disposition === "false_positive" ? (
                <label className="text-xs text-slate-700">
                  Stay quiet for (days, 0 = not at all)
                  <input
                    className="input ml-2 w-20 py-1 text-xs"
                    inputMode="numeric"
                    value={suppressDays}
                    onChange={(event) => setSuppressDays(event.target.value)}
                  />
                </label>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-xs w-fit"
                data-testid="investigation-close"
                disabled={busy || view.status === "closed"}
                onClick={() =>
                  run(
                    () =>
                      closeAnomalyInvestigation({
                        anomalyId: selectedId,
                        disposition,
                        note: closeNote,
                        linkedCorrectionType:
                          disposition === "genuine" ? correctionType : undefined,
                        linkedCorrectionId:
                          disposition === "genuine" ? correctionId : undefined,
                        suppressDays: disposition === "false_positive" ? Number(suppressDays) : 0,
                      }),
                    "Investigation closed."
                  )
                }
              >
                Close investigation
              </button>
            </div>

            {view.status === "closed" ? (
              <div className="mt-3">
                <p className="text-xs text-slate-600">
                  Closed{view.disposition ? ` as ${DISPOSITION_LABELS[view.disposition]}` : ""}
                  {view.dispositionNote ? `: ${view.dispositionNote}` : "."}
                </p>
                {view.linkedCorrectionId ? (
                  <p className="text-xs text-slate-500">
                    Correction: {view.linkedCorrectionType} · {view.linkedCorrectionId}
                  </p>
                ) : null}
                {view.suppressedUntil ? (
                  <p className="text-xs text-amber-800">
                    Rule stays quiet for this record until{" "}
                    {new Date(view.suppressedUntil).toLocaleDateString()}.
                  </p>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <input
                    className="input text-xs"
                    placeholder="Why reopen?"
                    value={reopenNote}
                    onChange={(event) => setReopenNote(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => reopenAnomalyFinding({ anomalyId: selectedId, note: reopenNote }),
                        "Finding reopened."
                      )
                    }
                  >
                    Reopen
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <h3 className="text-xs font-bold text-slate-900">Notes</h3>
            <div className="mt-2 flex gap-2">
              <input
                className="input text-xs"
                placeholder="Add what you found"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={busy || comment.trim().length < 2}
                onClick={() =>
                  run(
                    () => addAnomalyInvestigationComment({ anomalyId: selectedId, body: comment }),
                    "Note added."
                  )
                }
              >
                Add
              </button>
            </div>
            <ul className="mt-2 space-y-1 text-xs text-slate-700">
              {view.comments.map((row) => (
                <li key={row.id}>
                  <span className="font-medium">{row.authorName}</span>{" "}
                  <span className="text-slate-400">
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                  <div>{row.body}</div>
                </li>
              ))}
              {view.comments.length === 0 ? (
                <li className="text-slate-400">No notes yet.</li>
              ) : null}
            </ul>

            <h3 className="mt-4 text-xs font-bold text-slate-900">History</h3>
            <ol className="mt-2 space-y-1 text-xs text-slate-600">
              {view.events.map((event) => (
                <li key={event.id}>
                  <span className="font-medium">{event.kind.replace(/_/g, " ")}</span>{" "}
                  <span className="text-slate-400">
                    {new Date(event.createdAt).toLocaleDateString()}
                  </span>
                  {event.summary ? <div>{event.summary}</div> : null}
                  {event.note ? <div className="text-slate-500">{event.note}</div> : null}
                  {event.snapshotHash ? (
                    <div className="font-mono text-[10px] text-slate-400">
                      evidence {event.snapshotHash.slice(0, 16)}
                    </div>
                  ) : null}
                </li>
              ))}
              {view.events.length === 0 ? (
                <li className="text-slate-400">No events recorded yet.</li>
              ) : null}
            </ol>
          </div>
        </div>
      ) : null}

      <div className="mt-4 border-t border-slate-100 pt-3">
        <h3 className="text-xs font-bold text-slate-900">Deliberately quiet rules</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <input
            className="input text-xs"
            placeholder="Rule key"
            value={suppressionRule}
            onChange={(event) => setSuppressionRule(event.target.value)}
          />
          <input
            className="input text-xs"
            placeholder="Why it should stay quiet"
            value={suppressionReason}
            onChange={(event) => setSuppressionReason(event.target.value)}
          />
          <input
            className="input text-xs"
            inputMode="numeric"
            placeholder="Days"
            value={suppressionDays}
            onChange={(event) => setSuppressionDays(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={busy || suppressionRule.length < 3}
            onClick={() =>
              run(
                () =>
                  createAnomalySuppression({
                    ruleKey: suppressionRule,
                    reason: suppressionReason,
                    days: Number(suppressionDays),
                  }),
                "Suppression recorded."
              )
            }
          >
            Suppress rule
          </button>
        </div>
        <ul className="mt-2 space-y-1 text-xs text-slate-700">
          {suppressions.map((row) => (
            <li key={row.id} className={row.active ? "" : "text-slate-400"}>
              <span className="font-mono">{row.ruleKey}</span>{" "}
              {row.entityId ? `· ${row.entityId}` : "· whole rule"} ·{" "}
              {row.active ? "quiet until" : "ended"}{" "}
              {new Date(row.expiresAt).toLocaleDateString()} · {row.reason}
              {row.active ? (
                <span className="ml-2 inline-flex items-center gap-1">
                  <input
                    className="input py-0.5 text-[11px]"
                    placeholder="Lift because…"
                    value={revokeReason}
                    onChange={(event) => setRevokeReason(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => revokeAnomalySuppression({ id: row.id, reason: revokeReason }),
                        "Suppression lifted."
                      )
                    }
                  >
                    Lift
                  </button>
                </span>
              ) : null}
            </li>
          ))}
          {suppressions.length === 0 ? (
            <li className="text-slate-400">Nothing is suppressed.</li>
          ) : null}
        </ul>
      </div>

      <div className="mt-4 border-t border-slate-100 pt-3">
        <h3 className="text-xs font-bold text-slate-900">Recent scans</h3>
        <div className="mt-2 overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Trigger</th>
                <th>Status</th>
                <th>Seen</th>
                <th>New</th>
                <th>Reopened</th>
                <th>Quiet</th>
                <th>Notified</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((row) => (
                <tr key={row.id}>
                  <td className="text-xs">{new Date(row.startedAt).toLocaleString()}</td>
                  <td className="text-xs">{row.trigger}</td>
                  <td className="text-xs">
                    {row.status}
                    {row.error ? <span className="block text-red-600">{row.error}</span> : null}
                  </td>
                  <td className="text-xs tnum">{row.scanned}</td>
                  <td className="text-xs tnum">{row.created}</td>
                  <td className="text-xs tnum">{row.reopened}</td>
                  <td className="text-xs tnum">{row.suppressed}</td>
                  <td className="text-xs tnum">{row.notified}</td>
                </tr>
              ))}
              {runs.length === 0 ? (
                <tr>
                  <td className="text-xs text-slate-400" colSpan={8}>
                    No scan has been recorded yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export default AnomalyInvestigationPanel;
