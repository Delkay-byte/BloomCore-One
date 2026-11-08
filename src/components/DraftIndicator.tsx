"use client";

import { AlertCircle, CheckCircle2, RotateCcw } from "lucide-react";
import type { DraftStatus } from "@/hooks/useFormDraft";

/**
 * Unobtrusive draft indicator for forms. It distinguishes locally saved,
 * unfinished work from a submitted record and lets the user discard it or
 * retry a failed write.
 *
 * A draft is only announced as saved after the write has completed. The saving
 * state always terminates; nothing here can spin indefinitely.
 */
export default function DraftIndicator({
  status,
  lastSavedAt,
  onDiscard,
  onAcknowledge,
  onRetry,
}: {
  status: DraftStatus;
  lastSavedAt: string | null;
  onDiscard?: () => void;
  onAcknowledge?: () => void;
  onRetry?: () => void;
}) {
  if (status === "idle") return null;

  const time = lastSavedAt
    ? new Date(lastSavedAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  if (status === "restoring") {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-500"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <RotateCcw size={14} className="animate-spin" aria-hidden />
        <span>Restoring your draft…</span>
      </div>
    );
  }

  if (status === "restored") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600" role="status">
        <CheckCircle2 size={14} className="text-emerald-600" aria-hidden />
        <span>
          Draft restored{time ? ` · saved ${time}` : ""}. Review the values before submitting.
        </span>
        <button
          type="button"
          onClick={onDiscard}
          className="underline underline-offset-2 hover:text-slate-900"
        >
          Discard draft
        </button>
        <button
          type="button"
          onClick={onAcknowledge}
          className="underline underline-offset-2 hover:text-slate-900"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (status === "conflict") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-amber-800" role="status">
        <span>
          A newer version of this record was loaded, so your older draft was not applied.
        </span>
        {onDiscard && (
          <button
            type="button"
            onClick={onDiscard}
            className="underline underline-offset-2 hover:text-amber-950"
          >
            Discard old draft
          </button>
        )}
      </div>
    );
  }

  if (status === "unavailable" || status === "error") {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        role="alert"
      >
        <AlertCircle size={14} className="flex-none" aria-hidden />
        <span>
          We couldn&apos;t save this draft on this device. Your changes are still
          on this page.
        </span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="font-semibold underline underline-offset-2 hover:text-amber-950"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (status === "saving") {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-500"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <RotateCcw size={14} className="animate-spin" aria-hidden />
        <span>Saving draft…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600" role="status">
      <CheckCircle2 size={14} className="text-emerald-600" aria-hidden />
      <span>
        <span className="font-medium text-emerald-800">Draft saved successfully</span>
        {time ? ` · last saved at ${time}` : ""} on this device.
      </span>
      {onDiscard && (
        <button
          type="button"
          onClick={onDiscard}
          className="underline underline-offset-2 hover:text-slate-900"
        >
          Discard
        </button>
      )}
    </div>
  );
}
