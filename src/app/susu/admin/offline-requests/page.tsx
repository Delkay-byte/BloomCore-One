"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CloudOff, RefreshCw, ShieldCheck, X } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import ReauthDialog from "@/components/ReauthDialog";
import {
  authoriseOfflineRequest,
  getOfflineRequests,
  rejectOfflineRequest,
  type OfflineRequestView,
} from "@/lib/actions/offline-request.actions";

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  needs_review: "bg-red-100 text-red-800",
  authorised: "bg-emerald-100 text-emerald-800",
  rejected: "bg-slate-100 text-slate-700",
  cancelled: "bg-slate-100 text-slate-700",
};

export default function OfflineRequestsPage() {
  const [status, setStatus] = useState<"pending" | "needs_review" | "authorised" | "all">("pending");
  const [requests, setRequests] = useState<OfflineRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [reauthFor, setReauthFor] = useState<OfflineRequestView | null>(null);

  const load = useCallback(async (filter: string) => {
    setLoading(true);
    setError("");
    try {
      setRequests(await getOfflineRequests(filter === "all" ? undefined : filter));
    } catch {
      setError("The offline request queue could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  async function reject(request: OfflineRequestView) {
    setBusy(request.id);
    setError("");
    setSuccess("");
    try {
      const result = await rejectOfflineRequest({
        id: request.id,
        note: note[request.id] ?? "",
      });
      if (!result.success) {
        setError(result.error ?? "The request could not be rejected.");
        return;
      }
      setSuccess("Request refused. The collector sees the reason on their device.");
      await load(status);
    } finally {
      setBusy(null);
    }
  }

  async function authorise(request: OfflineRequestView, token?: string) {
    setBusy(request.id);
    setError("");
    setSuccess("");
    try {
      const result = await authoriseOfflineRequest({
        id: request.id,
        note: note[request.id],
        stepUpToken: token,
      });
      setReauthFor(null);
      if (!result.success) {
        setError(result.error ?? "The request could not be authorised.");
        await load(status);
        return;
      }
      setSuccess(
        "Authorised. The record was created by the same action the online screen uses."
      );
      await load(status);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Offline Requests</h1>
          <p className="mt-1 text-sm text-slate-600">
            Withdrawals, cash handovers and reversals captured while a collector was offline.
            Nothing here has touched the ledger yet: each request needs your decision.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(status)}
          className="btn btn-secondary btn-sm"
          disabled={loading}
        >
          <RefreshCw size={13} aria-hidden />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && <Notice type="error" message={error}>{error}</Notice>}
      {success && <Notice type="success" message={success}>{success}</Notice>}

      <div className="flex flex-wrap gap-1.5">
        {[
          { value: "pending", label: "Waiting" },
          { value: "needs_review", label: "Needs review" },
          { value: "authorised", label: "Authorised" },
          { value: "all", label: "All" },
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setStatus(option.value as typeof status)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              status === option.value
                ? "bg-brand-700 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading && requests.length === 0 && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading offline requests">
          <div className="skeleton h-28 rounded-xl" />
          <div className="skeleton h-28 rounded-xl" />
        </div>
      )}

      {!loading && requests.length === 0 && (
        <div className="card flex items-start gap-3 p-5">
          <CloudOff size={18} className="mt-0.5 text-slate-400" aria-hidden />
          <p className="text-sm text-slate-600">
            Nothing in this view. Requests appear here after a collector captures a withdrawal,
            cash handover or reversal while offline and the device reconnects.
          </p>
        </div>
      )}

      {requests.map((request) => (
        <article key={request.id} className="card space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold text-slate-900">
                {request.kindLabel}
                {request.amount !== null && (
                  <span className="ml-2 text-slate-700">
                    <CediAmount amount={request.amount} />
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500">
                {request.subjectLabel} · captured{" "}
                {new Date(request.requestedAt).toLocaleString("en-GB")}
                {request.requestedByName ? ` by ${request.requestedByName}` : ""}
                {request.ageHours >= 1 ? ` · ${request.ageHours}h old` : ""}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                STATUS_TONE[request.status] ?? "bg-slate-100 text-slate-700"
              }`}
            >
              {request.statusLabel}
            </span>
          </div>

          {request.notes && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
              Collector note: {request.notes}
            </p>
          )}
          {request.reason && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
              Reversal reason: {request.reason}
            </p>
          )}
          {request.conflictReason && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
              {request.conflictReason}
            </p>
          )}
          {request.decisionNote && (
            <p className="text-xs text-slate-600">
              Decision: {request.decisionNote}
              {request.decidedByName ? ` — ${request.decidedByName}` : ""}
            </p>
          )}
          {request.resultingEntityType && (
            <p className="text-xs text-emerald-800">
              Created {request.resultingEntityType}
              {request.resultingEntityId ? ` ${request.resultingEntityId}` : ""}.
            </p>
          )}

          {(request.status === "pending" || request.status === "needs_review") && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-600">
                Decision note
                <input
                  type="text"
                  maxLength={500}
                  value={note[request.id] ?? ""}
                  onChange={(event) =>
                    setNote((current) => ({ ...current, [request.id]: event.target.value }))
                  }
                  placeholder={
                    request.status === "needs_review"
                      ? "Why this could not be posted, and what happens next"
                      : "Optional context for the record"
                  }
                  className="input mt-1 block w-full"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // Only a withdrawal or a reversal needs a fresh password; the
                    // cash handover is recorded under the administrator session.
                    if (request.grant) setReauthFor(request);
                    else void authorise(request);
                  }}
                  className="btn btn-primary btn-sm"
                  disabled={busy === request.id}
                >
                  <ShieldCheck size={14} aria-hidden />
                  {request.grant ? "Authorise and post" : "Record the cash handover"}
                </button>
                <button
                  type="button"
                  onClick={() => void reject(request)}
                  className="btn btn-secondary btn-sm"
                  disabled={busy === request.id || (note[request.id] ?? "").trim().length < 5}
                >
                  <X size={14} aria-hidden />
                  Refuse
                </button>
                <span className="text-[11px] text-slate-500">
                  {request.grant
                    ? "Authorising asks for your password and runs the same action as the online screen."
                    : "This runs the same action as the online screen, under your session."}
                </span>
              </div>
            </div>
          )}

          {request.status === "authorised" && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-800">
              <Check size={13} aria-hidden /> Posted from an offline capture.
            </p>
          )}
        </article>
      ))}

      <ReauthDialog
        open={reauthFor !== null}
        onClose={() => setReauthFor(null)}
        onConfirmed={(token) => {
          if (reauthFor) void authorise(reauthFor, token);
        }}
        title="Authorise the offline request"
        description="This posts a record from an offline capture. Confirm your password to authorise it."
        actionLabel="Authorise and post"
        module="admin"
        purpose={reauthFor?.grant?.purpose as never}
        targetType={reauthFor?.grant?.targetType}
        targetId={reauthFor?.grant?.targetId}
        context={reauthFor?.grant?.context ?? {}}
      />
    </div>
  );
}
