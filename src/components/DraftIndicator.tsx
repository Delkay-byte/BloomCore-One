"use client";

import { CheckCircle2, CloudOff, RotateCcw } from "lucide-react";
import type { DraftStatus } from "@/hooks/useFormDraft";

/**
 * Unobtrusive draft indicator for forms. It distinguishes locally saved,
 * unfinished work from a submitted record and lets the user discard it.
 */
export default function DraftIndicator({
  status,
  lastSavedAt,
  onDiscard,
  onAcknowledge,
}: {
  status: DraftStatus;
  lastSavedAt: string | null;
  onDiscard?: () => void;
  onAcknowledge?: () => void;
}) {
  if (status === "idle" || status === "restoring") return null;

  const time = lastSavedAt
    ? new Date(lastSavedAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

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
      <div className="flex items-center gap-2 text-xs text-amber-700" role="status">
        <CloudOff size={14} aria-hidden />
        <span>Draft not saved. Keep this page open until you submit.</span>
      </div>
    );
  }

  if (status === "saving") {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500" role="status">
        <RotateCcw size={14} className="animate-spin" aria-hidden />
        <span>Saving draft…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500" role="status">
      <CheckCircle2 size={14} className="text-emerald-600" aria-hidden />
      <span>Draft saved{time ? ` at ${time}` : ""} on this device.</span>
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
