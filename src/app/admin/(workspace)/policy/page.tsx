"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock3, Fingerprint, RefreshCw, Save, ShieldCheck } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  getOperationalPolicy,
  saveOperationalPolicy,
  type OperationalPolicyView,
} from "@/lib/actions/tenant-policy.actions";
import {
  MAX_OFFLINE_IDLE_LOCK_MINUTES,
  MIN_OFFLINE_IDLE_LOCK_MINUTES,
  actorProofSummary,
  shiftPolicySummary,
} from "@/lib/tenant-policy";

export default function OperationsPolicyPage() {
  const [policy, setPolicy] = useState<OperationalPolicyView | null>(null);
  const [shiftsRequired, setShiftsRequired] = useState(false);
  const [actorProof, setActorProof] = useState(false);
  const [idleLock, setIdleLock] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getOperationalPolicy();
      setPolicy(next);
      setShiftsRequired(next.shiftsRequired);
      setActorProof(next.actorProofForSensitiveCounts);
      setIdleLock(
        next.offlineIdleLockMinutes === null ? "" : String(next.offlineIdleLockMinutes)
      );
      setNote(next.note ?? "");
    } catch {
      setError("The policy could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await saveOperationalPolicy({
        shiftsRequired,
        actorProofForSensitiveCounts: actorProof,
        offlineIdleLockMinutes: idleLock.trim() === "" ? null : Number(idleLock),
        note,
      });
      if (!result.success) {
        setError(result.error ?? "The policy could not be saved.");
        return;
      }
      setSuccess("Policy saved. The change is audited with the previous values.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    policy !== null &&
    (policy.shiftsRequired !== shiftsRequired ||
      policy.actorProofForSensitiveCounts !== actorProof ||
      (policy.note ?? "") !== note ||
      String(policy.offlineIdleLockMinutes ?? "") !== idleLock.trim());

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operations Policy</h1>
          <p className="mt-1 text-sm text-slate-600">
            The rules this business actually enforces. Every switch here changes a
            server-side check, not just a label.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="btn btn-secondary btn-sm"
          disabled={loading}
        >
          <RefreshCw size={13} aria-hidden />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && <Notice type="error" message={error}>{error}</Notice>}
      {success && <Notice type="success" message={success}>{success}</Notice>}

      {loading && !policy && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading policy">
          <div className="skeleton h-28 rounded-xl" />
          <div className="skeleton h-28 rounded-xl" />
        </div>
      )}

      {policy && (
        <>
          <section className="card space-y-3 p-4">
            <div className="flex items-start gap-3">
              <Clock3 size={18} className="mt-0.5 shrink-0 text-brand-700" aria-hidden />
              <div className="flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold text-slate-900">Shifts</h2>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={shiftsRequired}
                      onChange={(event) => setShiftsRequired(event.target.checked)}
                      className="h-4 w-4"
                    />
                    Require a shift before a day can close
                  </label>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  {shiftPolicySummary(shiftsRequired)}
                </p>
              </div>
            </div>
          </section>

          <section className="card space-y-3 p-4">
            <div className="flex items-start gap-3">
              <Fingerprint size={18} className="mt-0.5 shrink-0 text-brand-700" aria-hidden />
              <div className="flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold text-slate-900">Shared devices</h2>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={actorProof}
                      onChange={(event) => setActorProof(event.target.checked)}
                      className="h-4 w-4"
                    />
                    Require the actor&apos;s own password for sensitive counts
                  </label>
                </div>
                <p className="mt-1 text-xs text-slate-600">{actorProofSummary(actorProof)}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Applies to the outgoing shift count and to the daily close. The proof is a
                  single-use grant bound to that record, so it cannot be reused for another one.
                </p>
              </div>
            </div>
          </section>

          <section className="card space-y-3 p-4">
            <div className="flex items-start gap-3">
              <Fingerprint size={18} className="mt-0.5 shrink-0 text-brand-700" aria-hidden />
              <div className="flex-1">
                <h2 className="font-semibold text-slate-900">Offline idle lock</h2>
                <p className="mt-1 text-xs text-slate-600">
                  How long an unlocked offline workspace stays open without activity before it
                  locks itself. A shared device should lock sooner than a personal one.
                </p>
                <label className="mt-2 block text-xs font-medium text-slate-600">
                  Minutes (blank uses the product default of {policy.effectiveIdleLockMinutes})
                  <input
                    type="number"
                    min={MIN_OFFLINE_IDLE_LOCK_MINUTES}
                    max={MAX_OFFLINE_IDLE_LOCK_MINUTES}
                    step="1"
                    value={idleLock}
                    onChange={(event) => setIdleLock(event.target.value)}
                    className="input mt-1 block w-32"
                    placeholder={String(policy.effectiveIdleLockMinutes)}
                  />
                </label>
                <p className="mt-1 text-[11px] text-slate-500">
                  Allowed range: {MIN_OFFLINE_IDLE_LOCK_MINUTES}–
                  {MAX_OFFLINE_IDLE_LOCK_MINUTES} minutes. Going to the background still locks
                  after five minutes, whatever this says.
                </p>
              </div>
            </div>
          </section>

          <label className="card block p-4 text-xs font-medium text-slate-600">
            Why this policy (optional, shown in the audit trail)
            <input
              type="text"
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="input mt-1 block w-full"
              placeholder="For example: three branches share one till and one tablet."
            />
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              {policy.usingDefaults
                ? "This business is running on the product defaults."
                : `Last saved ${new Date(policy.updatedAt!).toLocaleString("en-GB")}${
                    policy.updatedByName ? ` by ${policy.updatedByName}` : ""
                  }.`}
            </p>
            <div className="flex items-center gap-2">
              {dirty && <span className="text-xs font-medium text-amber-700">Unsaved changes</span>}
              <button
                type="button"
                onClick={() => void save()}
                className="btn btn-primary btn-sm"
                disabled={busy || !dirty}
                aria-busy={busy}
              >
                <Save size={14} aria-hidden />
                {busy ? "Saving…" : "Save policy"}
              </button>
            </div>
          </div>

          <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-slate-500" aria-hidden />
            Changing a policy never changes a financial record and never reopens a closed day.
          </p>
        </>
      )}
    </div>
  );
}
