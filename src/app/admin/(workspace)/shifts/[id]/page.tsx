"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import ReauthDialog from "@/components/ReauthDialog";
import ShiftStatusBadge from "@/components/momo/ShiftStatusBadge";
import {
  getShiftDetail,
  resolveShiftHandover,
  type ShiftDetailView,
} from "@/lib/actions/shift.actions";

function fmt(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminShiftDetailPage() {
  const params = useParams<{ id: string }>();
  const shiftId = params?.id;
  const [data, setData] = useState<ShiftDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [reauthOpen, setReauthOpen] = useState(false);
  const [pendingHandover, setPendingHandover] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shiftId) return;
    setError("");
    setLoading(true);
    try {
      const detail = await getShiftDetail(shiftId);
      if (!detail) {
        setError("This shift is not available to you.");
        setData(null);
      } else {
        setData(detail);
      }
    } catch {
      setError("The shift could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(handoverId: string, stepUpToken: string) {
    setError("");
    setSuccess("");
    const result = await resolveShiftHandover({
      handoverId,
      resolutionNote,
      stepUpToken,
    });
    if (!result.success) {
      setError(result.error ?? "The resolution could not be recorded.");
      return;
    }
    setSuccess("Investigation outcome recorded. The shift is closed.");
    setResolutionNote("");
    setPendingHandover(null);
    await load();
  }

  if (loading && !data) {
    return <p className="text-sm text-slate-500">Loading shift record…</p>;
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <Notice type="error">{error || "This shift is not available."}</Notice>
        <Link href="/admin/shifts" className="btn btn-secondary inline-flex">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to shifts
        </Link>
      </div>
    );
  }

  const shift = data.shift;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/shifts"
            className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Shifts &amp; handovers
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">
            {shift.label} · {fmtDate(shift.businessDate)}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {shift.locationName} · {shift.assignedUserName ?? "Unassigned"} ·{" "}
            {shift.reference}
          </p>
        </div>
        <ShiftStatusBadge status={shift.status} label={shift.statusLabel} />
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      <section className="card p-4">
        <h2 className="text-sm font-bold text-slate-900">Shift position</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Opening cash</dt>
            <dd className="font-semibold text-slate-900">
              <CediAmount amount={shift.openingCash} />
            </dd>
            <dd className="text-[11px] text-slate-400">
              Source: {shift.openingSource.replace(/_/g, " ")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Opening E-cash</dt>
            <dd className="font-semibold text-slate-900">
              <CediAmount amount={shift.openingMomoFloat} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Outgoing closing cash</dt>
            <dd className="font-semibold text-slate-900">
              {shift.closingCash === null ? "Not submitted" : <CediAmount amount={shift.closingCash} />}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Outgoing closing E-cash</dt>
            <dd className="font-semibold text-slate-900">
              {shift.closingMomoFloat === null ? (
                "Not submitted"
              ) : (
                <CediAmount amount={shift.closingMomoFloat} />
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Opened</dt>
            <dd className="text-slate-800">{fmt(shift.openedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Outgoing submitted</dt>
            <dd className="text-slate-800">{fmt(shift.closedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Daily account</dt>
            <dd className="text-slate-800">
              {shift.dailyAccountId ? "Linked" : "No daily account linked"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Shift notes</dt>
            <dd className="text-slate-800">{shift.closingNotes || "—"}</dd>
          </div>
        </dl>
        {shift.openingAdjustmentReason && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Opening adjustment: {shift.openingAdjustmentReason}
          </p>
        )}
        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
          Shift figures are accountability snapshots and are not added into the
          daily account totals.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold text-slate-900">Handover history</h2>
        {shift.handovers.length === 0 ? (
          <p className="card p-4 text-sm text-slate-500">
            No handover has been submitted for this shift yet.
          </p>
        ) : (
          shift.handovers.map((handover) => {
            const variance = (handover.cashVariance ?? 0) + (handover.floatVariance ?? 0);
            return (
              <article key={handover.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      {handover.outgoingUserName ?? "Outgoing"} →{" "}
                      {handover.incomingUserName ?? "Receiver not confirmed"}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {handover.reference} · submitted {fmt(handover.createdAt)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                      handover.status === "confirmed" || handover.status === "resolved"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : handover.status === "variance_open"
                          ? "border-red-200 bg-red-50 text-red-800"
                          : "border-amber-200 bg-amber-50 text-amber-900"
                    }`}
                  >
                    {handover.status.replace(/_/g, " ")}
                  </span>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Outgoing declaration
                    </p>
                    <p className="mt-1 text-sm text-slate-800">
                      Cash <CediAmount amount={handover.outgoingCash} /> · E-cash{" "}
                      <CediAmount amount={handover.outgoingMomoFloat} />
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
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Receiver count
                    </p>
                    {handover.incomingCash === null ? (
                      <p className="mt-1 text-sm text-slate-500">
                        Waiting for the receiving employee to count and confirm.
                      </p>
                    ) : (
                      <>
                        <p className="mt-1 text-sm text-slate-800">
                          Cash <CediAmount amount={handover.incomingCash} /> · E-cash{" "}
                          <CediAmount amount={handover.incomingMomoFloat ?? 0} />
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          Operations accepted: {handover.operationsAccepted ? "Yes" : "No"}
                        </p>
                        {handover.incomingNotes && (
                          <p className="mt-1 text-xs text-slate-600">
                            Notes: {handover.incomingNotes}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-sm">
                  <p className={Math.abs(variance) > 0 ? "font-semibold text-amber-800" : "text-slate-600"}>
                    Cash variance <CediAmount amount={handover.cashVariance ?? 0} showSign /> ·
                    float variance <CediAmount amount={handover.floatVariance ?? 0} showSign />
                  </p>
                  <p className="text-xs text-slate-500">
                    {handover.confirmedAt ? `Confirmed ${fmt(handover.confirmedAt)}` : "Not confirmed"}
                  </p>
                </div>

                {handover.varianceReason && (
                  <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Receiver explanation: {handover.varianceReason}
                  </p>
                )}
                {handover.resolutionNote && (
                  <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                    Investigation outcome: {handover.resolutionNote} ·{" "}
                    {fmt(handover.resolvedAt)}
                  </p>
                )}

                {handover.status === "variance_open" && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                    <label className="text-xs font-semibold text-amber-900">
                      Investigation outcome
                      <textarea
                        value={pendingHandover === handover.id ? resolutionNote : ""}
                        onChange={(event) => {
                          setPendingHandover(handover.id);
                          setResolutionNote(event.target.value);
                        }}
                        rows={2}
                        maxLength={500}
                        placeholder="What was investigated and how the difference was resolved?"
                        className="input mt-1 w-full"
                      />
                    </label>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={resolutionNote.trim().length < 10}
                        onClick={() => {
                          setPendingHandover(handover.id);
                          setReauthOpen(true);
                        }}
                      >
                        <ShieldCheck className="h-4 w-4" aria-hidden /> Record outcome
                      </button>
                      <span className="text-[11px] text-amber-900">
                        Requires your administrator password and at least 10 characters.
                      </span>
                    </div>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>

      <ReauthDialog
        open={reauthOpen}
        onClose={() => setReauthOpen(false)}
        onConfirmed={(token) => {
          if (pendingHandover) void resolve(pendingHandover, token);
          setReauthOpen(false);
        }}
        title="Confirm the investigation outcome"
        description="This records the final accountability outcome for the handover variance."
        actionLabel="Record outcome"
        module="admin"
        purpose="finance.shift_handover.resolve"
        targetType="shiftHandover"
        targetId={pendingHandover ?? undefined}
        context={{
          amountMinor: pendingHandover
            ? Math.round(
                ((shift.handovers.find((row) => row.id === pendingHandover)?.cashVariance ??
                  0) *
                  100) +
                  (shift.handovers.find((row) => row.id === pendingHandover)?.floatVariance ??
                    0) *
                    100
              )
            : 0,
        }}
      />
    </div>
  );
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
