"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, Play, RefreshCw, ShieldCheck } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import ShiftStatusBadge from "@/components/momo/ShiftStatusBadge";
import {
  closeShift,
  confirmShiftHandover,
  createShift,
  getWorkerShiftBoard,
  openShift,
  type ShiftView,
  type WorkerShiftBoard,
} from "@/lib/actions/shift.actions";
import { SHIFT_NAMES, SHIFT_NAME_LABELS, type ShiftName } from "@/lib/shifts";
import { ACTOR_PROOF_REQUIRED } from "@/lib/tenant-policy";
import ReauthDialog from "@/components/ReauthDialog";

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function WorkerShiftsPage() {
  const [board, setBoard] = useState<WorkerShiftBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [form, setForm] = useState({
    businessDate: todayIso(),
    name: "morning" as ShiftName,
    customLabel: "",
    openingCash: "",
    openingMomoFloat: "",
    openingAdjustmentReason: "",
  });
  const [closeForm, setCloseForm] = useState({
    shiftId: "",
    closingCash: "",
    closingMomoFloat: "",
    handoverToUserId: "",
    outstandingOperations: "",
    outgoingNotes: "",
    outgoingEvidence: "",
  });
  const [confirmForm, setConfirmForm] = useState({
    handoverId: "",
    incomingCash: "",
    incomingMomoFloat: "",
    operationsAccepted: false,
    incomingNotes: "",
    incomingEvidence: "",
  });

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const data = await getWorkerShiftBoard();
      setBoard(data);
    } catch {
      setError("Your shift board could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const myUserId = board?.userId ?? null;

  const colleagues = board?.colleagues ?? [];

  const ownShifts = useMemo(
    () => (board?.shifts ?? []).filter((shift) => shift.assignedUserId === myUserId),
    [board?.shifts, myUserId]
  );
  const recentShifts = (board?.shifts ?? []).slice(0, 12);

  async function run(
    label: string,
    fn: () => Promise<{ success: boolean; error?: string; data?: unknown }>
  ) {
    setBusy(label);
    setError("");
    setSuccess("");
    const result = await fn();
    if (!result.success) {
      setError(result.error ?? "That action could not be completed.");
    } else {
      setSuccess("Saved.");
      await load();
    }
    setBusy(null);
    return result;
  }

  async function handleCreate() {
    const result = await run("create", () =>
      createShift({
        businessDate: form.businessDate,
        name: form.name,
        label:
          form.name === "custom"
            ? form.customLabel.trim() || "Custom shift"
            : SHIFT_NAME_LABELS[form.name],
        locationId: board?.locationId ?? "",
        assignedUserId: myUserId ?? "",
        openingCash: Number(form.openingCash || 0),
        openingMomoFloat: Number(form.openingMomoFloat || 0),
        openingAdjustmentReason: form.openingAdjustmentReason || undefined,
      })
    );
    if (result.success) {
      const data = result.data as { shiftId?: string } | undefined;
      if (data?.shiftId) {
        const opened = await openShift(data.shiftId);
        if (!opened.success) setError(opened.error ?? "The shift was saved but not opened.");
        await load();
      }
      setForm((current) => ({
        ...current,
        customLabel: "",
        openingCash: "",
        openingMomoFloat: "",
        openingAdjustmentReason: "",
      }));
    }
  }

  async function submitClose(actorProofToken?: string) {
    return closeShift({
      shiftId: closeForm.shiftId,
      closingCash: Number(closeForm.closingCash || 0),
      closingMomoFloat: Number(closeForm.closingMomoFloat || 0),
      handoverToUserId: closeForm.handoverToUserId,
      outstandingOperations: closeForm.outstandingOperations || undefined,
      outgoingNotes: closeForm.outgoingNotes || undefined,
      outgoingEvidence: closeForm.outgoingEvidence || undefined,
      actorProofToken,
    });
  }

  async function handleClose() {
    const result = await run("close", () => submitClose());
    // The business may require the actor to prove their own identity again
    // before a counted handover is submitted on a shared device. The server
    // decides; the browser only asks for the password it was refused for.
    if (!result.success && result.error === ACTOR_PROOF_REQUIRED) {
      setProofOpen(true);
      return;
    }
    setCloseForm({
      shiftId: "",
      closingCash: "",
      closingMomoFloat: "",
      handoverToUserId: "",
      outstandingOperations: "",
      outgoingNotes: "",
      outgoingEvidence: "",
    });
  }

  async function handleConfirm() {
    await run("confirm", () =>
      confirmShiftHandover({
        handoverId: confirmForm.handoverId,
        incomingCash: Number(confirmForm.incomingCash || 0),
        incomingMomoFloat: Number(confirmForm.incomingMomoFloat || 0),
        operationsAccepted: confirmForm.operationsAccepted,
        incomingNotes: confirmForm.incomingNotes || undefined,
        incomingEvidence: confirmForm.incomingEvidence || undefined,
      })
    );
    setConfirmForm({
      handoverId: "",
      incomingCash: "",
      incomingMomoFloat: "",
      operationsAccepted: false,
      incomingNotes: "",
      incomingEvidence: "",
    });
  }

  function startClose(shift: ShiftView) {
    setCloseForm({
      shiftId: shift.id,
      closingCash: String(shift.openingCash),
      closingMomoFloat: String(shift.openingMomoFloat),
      handoverToUserId: colleagues[0]?.id ?? "",
      outstandingOperations: "",
      outgoingNotes: "",
      outgoingEvidence: "",
    });
  }

  function startConfirm(handoverId: string) {
    setConfirmForm({
      handoverId,
      incomingCash: "",
      incomingMomoFloat: "",
      operationsAccepted: false,
      incomingNotes: "",
      incomingEvidence: "",
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Shifts &amp; handover</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Open your shift, then hand over the cash and float to a colleague.
            Both employees record their own side, so neither can overwrite the
            other.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary">
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </button>
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      {loading && !board ? (
        <p className="text-sm text-slate-500">Loading your shifts…</p>
      ) : !board?.locationId ? (
        <Notice type="warning">
          Your account is not assigned to a branch, so shifts are not available.
        </Notice>
      ) : (
        <>
          <section className="card p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Play className="h-4 w-4 text-brand-600" aria-hidden />
              Start a shift
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Leave the opening amounts at 0 to carry the previous closed
              shift&apos;s closing figures. Any manual opening that differs from
              that close needs an explanation.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="text-xs font-medium text-slate-600">
                Business date
                <input
                  type="date"
                  value={form.businessDate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, businessDate: event.target.value }))
                  }
                  className="input mt-1 w-full"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Shift
                <select
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value as ShiftName,
                    }))
                  }
                  className="input mt-1 w-full"
                >
                  {SHIFT_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {SHIFT_NAME_LABELS[name]}
                    </option>
                  ))}
                </select>
              </label>
              {form.name === "custom" && (
                <label className="text-xs font-medium text-slate-600">
                  Custom shift name
                  <input
                    type="text"
                    value={form.customLabel}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        customLabel: event.target.value,
                      }))
                    }
                    maxLength={60}
                    placeholder="For example School run"
                    className="input mt-1 w-full"
                  />
                </label>
              )}
              <label className="text-xs font-medium text-slate-600">
                Opening cash
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.openingCash}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, openingCash: event.target.value }))
                  }
                  className="input mt-1 w-full"
                  placeholder="0.00"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Opening E-cash
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.openingMomoFloat}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      openingMomoFloat: event.target.value,
                    }))
                  }
                  className="input mt-1 w-full"
                  placeholder="0.00"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={busy !== null || !board.locationId}
                  className="btn btn-primary w-full"
                >
                  {busy === "create" ? "Starting…" : "Start shift"}
                </button>
              </div>
            </div>
            <label className="mt-3 block text-xs font-medium text-slate-600">
              Opening explanation (only needed when it differs from the previous close)
              <input
                type="text"
                value={form.openingAdjustmentReason}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    openingAdjustmentReason: event.target.value,
                  }))
                }
                maxLength={500}
                className="input mt-1 w-full"
                placeholder="e.g. Change fund replenished from the safe"
              />
            </label>
          </section>

          {board.awaitingMyConfirmation.length > 0 && (
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <ShieldCheck className="h-4 w-4 text-amber-600" aria-hidden />
                Handovers waiting for your count
              </h2>
              <div className="mt-3 space-y-3">
                {board.awaitingMyConfirmation.map((handover) => (
                  <div key={handover.id} className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
                    <p className="text-sm font-semibold text-slate-900">
                      {handover.outgoingUserName ?? "Outgoing employee"} declared{" "}
                      <CediAmount amount={handover.outgoingCash} /> cash and{" "}
                      <CediAmount amount={handover.outgoingMomoFloat} /> float
                    </p>
                    {handover.outstandingOperations && (
                      <p className="mt-1 text-xs text-slate-600">
                        Outstanding operations: {handover.outstandingOperations}
                      </p>
                    )}
                    {handover.outgoingNotes && (
                      <p className="mt-1 text-xs text-slate-600">
                        Notes: {handover.outgoingNotes}
                      </p>
                    )}
                    {handover.outgoingEvidence && (
                      <p className="mt-1 text-xs text-slate-600">
                        Outgoing evidence: {handover.outgoingEvidence}
                      </p>
                    )}
                    {confirmForm.handoverId === handover.id ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <label className="text-xs font-medium text-slate-600">
                          Counted cash
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={confirmForm.incomingCash}
                            onChange={(event) =>
                              setConfirmForm((current) => ({
                                ...current,
                                incomingCash: event.target.value,
                              }))
                            }
                            className="input mt-1 w-full"
                          />
                        </label>
                        <label className="text-xs font-medium text-slate-600">
                          Counted E-cash
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={confirmForm.incomingMomoFloat}
                            onChange={(event) =>
                              setConfirmForm((current) => ({
                                ...current,
                                incomingMomoFloat: event.target.value,
                              }))
                            }
                            className="input mt-1 w-full"
                          />
                        </label>
                        <label className="flex items-start gap-2 text-xs text-slate-700 sm:col-span-2">
                          <input
                            type="checkbox"
                            checked={confirmForm.operationsAccepted}
                            onChange={(event) =>
                              setConfirmForm((current) => ({
                                ...current,
                                operationsAccepted: event.target.checked,
                              }))
                            }
                            className="mt-0.5"
                          />
                          I accept the outstanding operations listed above and
                          have counted the cash and float myself.
                        </label>
                        <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                          Note (required if your count differs)
                          <input
                            type="text"
                            value={confirmForm.incomingNotes}
                            onChange={(event) =>
                              setConfirmForm((current) => ({
                                ...current,
                                incomingNotes: event.target.value,
                              }))
                            }
                            maxLength={500}
                            className="input mt-1 w-full"
                          />
                        </label>
                        <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                          Receipt / count evidence (optional)
                          <input
                            type="text"
                            value={confirmForm.incomingEvidence}
                            onChange={(event) =>
                              setConfirmForm((current) => ({
                                ...current,
                                incomingEvidence: event.target.value,
                              }))
                            }
                            maxLength={300}
                            placeholder="Count sheet, receipt number or other evidence held"
                            className="input mt-1 w-full"
                          />
                        </label>
                        <div className="flex items-end gap-2 sm:col-span-2">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy !== null}
                            onClick={() => void handleConfirm()}
                          >
                            {busy === "confirm" ? "Confirming…" : "Confirm my count"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setConfirmForm((current) => ({ ...current, handoverId: "" }))}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary mt-3"
                        onClick={() => startConfirm(handover.id)}
                      >
                        Count and confirm
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Clock3 className="h-4 w-4 text-brand-600" aria-hidden />
              Your shifts
            </h2>
            {ownShifts.length === 0 ? (
              <p className="card p-4 text-sm text-slate-500">
                You have no shifts yet. Start one above.
              </p>
            ) : (
              ownShifts.map((shift) => (
                <article key={shift.id} className="card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-slate-900">
                        {shift.label} · {fmtDate(shift.businessDate)}
                      </p>
                      <p className="text-[11px] text-slate-400">{shift.reference}</p>
                    </div>
                    <ShiftStatusBadge status={shift.status} label={shift.statusLabel} />
                  </div>
                  <p className="mt-2 text-sm text-slate-700">
                    Opening cash <CediAmount amount={shift.openingCash} /> · float{" "}
                    <CediAmount amount={shift.openingMomoFloat} />{" "}
                    <span className="text-xs text-slate-500">
                      ({shift.openingSource.replace(/_/g, " ")})
                    </span>
                  </p>
                  {shift.closingCash !== null && (
                    <p className="text-sm text-slate-700">
                      Declared close cash <CediAmount amount={shift.closingCash} /> ·
                      float <CediAmount amount={shift.closingMomoFloat ?? 0} />
                    </p>
                  )}

                  {shift.status === "draft" && (
                    <button
                      type="button"
                      className="btn btn-primary mt-3"
                      disabled={busy !== null}
                      onClick={() => void run("open", () => openShift(shift.id))}
                    >
                      {busy === "open" ? "Opening…" : "Open this shift"}
                    </button>
                  )}

                  {shift.status === "open" && (
                    <>
                      {closeForm.shiftId === shift.id ? (
                        <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2">
                          <label className="text-xs font-medium text-slate-600">
                            Closing cash you are handing over
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={closeForm.closingCash}
                              onChange={(event) =>
                                setCloseForm((current) => ({
                                  ...current,
                                  closingCash: event.target.value,
                                }))
                              }
                              className="input mt-1 w-full"
                            />
                          </label>
                          <label className="text-xs font-medium text-slate-600">
                            Closing E-cash you are handing over
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={closeForm.closingMomoFloat}
                              onChange={(event) =>
                                setCloseForm((current) => ({
                                  ...current,
                                  closingMomoFloat: event.target.value,
                                }))
                              }
                              className="input mt-1 w-full"
                            />
                          </label>
                          <label className="text-xs font-medium text-slate-600">
                            Hand over to
                            <select
                              value={closeForm.handoverToUserId}
                              onChange={(event) =>
                                setCloseForm((current) => ({
                                  ...current,
                                  handoverToUserId: event.target.value,
                                }))
                              }
                              className="input mt-1 w-full"
                            >
                              <option value="">Choose a colleague</option>
                              {colleagues.map((colleague) => (
                                <option key={colleague.id} value={colleague.id}>
                                  {colleague.fullName}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="text-xs font-medium text-slate-600">
                            Outstanding operations (optional)
                            <input
                              type="text"
                              value={closeForm.outstandingOperations}
                              onChange={(event) =>
                                setCloseForm((current) => ({
                                  ...current,
                                  outstandingOperations: event.target.value,
                                }))
                              }
                              maxLength={1000}
                              className="input mt-1 w-full"
                            />
                          </label>
                          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                            Notes (optional)
                            <input
                              type="text"
                              value={closeForm.outgoingNotes}
                              onChange={(event) =>
                                setCloseForm((current) => ({
                                  ...current,
                                  outgoingNotes: event.target.value,
                                }))
                              }
                              maxLength={500}
                              className="input mt-1 w-full"
                            />
                          </label>
                          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                            Count sheet / handover evidence (optional)
                            <input
                              type="text"
                              value={closeForm.outgoingEvidence}
                              onChange={(event) =>
                                setCloseForm((current) => ({
                                  ...current,
                                  outgoingEvidence: event.target.value,
                                }))
                              }
                              maxLength={300}
                              placeholder="Till slip, count sheet or other evidence held"
                              className="input mt-1 w-full"
                            />
                          </label>
                          <div className="flex items-end gap-2 sm:col-span-2">
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busy !== null || !closeForm.handoverToUserId}
                              onClick={() => void handleClose()}
                            >
                              {busy === "close" ? "Submitting…" : "Submit handover"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => setCloseForm((current) => ({ ...current, shiftId: "" }))}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary mt-3"
                          onClick={() => startClose(shift)}
                          disabled={colleagues.length === 0}
                        >
                          Close and hand over
                        </button>
                      )}
                      {colleagues.length === 0 && (
                        <p className="mt-2 text-xs text-amber-800">
                          A second employee at this branch is needed to receive the
                          handover. Ask your supervisor to add one.
                        </p>
                      )}
                    </>
                  )}

                  {shift.status === "awaiting_handover" && (
                    <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      Waiting for the receiving employee to count and confirm. You
                      cannot change your declared figures now.
                    </p>
                  )}
                  {shift.status === "variance_open" && (
                    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-900">
                      The receiver counted a different amount. A supervisor must
                      investigate before this handover closes.
                    </p>
                  )}
                  {shift.status === "closed" && (
                    <p className="mt-3 text-xs text-emerald-800">
                      Both sides confirmed and the shift is closed.
                    </p>
                  )}
                </article>
              ))
            )}
          </section>

          {recentShifts.length > 0 && (
            <section className="card p-4">
              <h2 className="text-sm font-bold text-slate-900">Branch shifts</h2>
              <ul className="mt-2 divide-y divide-slate-100">
                {recentShifts.map((shift) => (
                  <li
                    key={shift.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-slate-600"
                  >
                    <span>
                      <strong className="text-slate-800">{shift.label}</strong> ·{" "}
                      {fmtDate(shift.businessDate)} ·{" "}
                      {shift.assignedUserName ?? "Unassigned"}
                    </span>
                    <ShiftStatusBadge status={shift.status} label={shift.statusLabel} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <ReauthDialog
        open={proofOpen}
        onClose={() => setProofOpen(false)}
        onConfirmed={async (token) => {
          setProofOpen(false);
          await run("close", () => submitClose(token));
        }}
        title="Confirm your identity"
        description="This business requires your own password before a counted handover is submitted from a shared device."
        actionLabel="Submit count"
        module="momo"
        purpose="finance.shift_count.submit"
        targetType="shift"
        targetId={closeForm.shiftId || undefined}
        context={{}}
      />
    </div>
  );
}
