"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteDraft, loadDraft, saveDraft } from "@/lib/offline/drafts";
import type { DraftStatus } from "./useFormDraft";

export interface UseObjectDraftOptions<T> {
  draftKey: string;
  workflow: string;
  /** Current serializable form state. */
  value: T;
  /** Apply a restored draft to component state. */
  restore: (value: T) => void;
  enabled?: boolean;
  debounceMs?: number;
  /** Server record timestamp; a draft older than this is not applied. */
  serverUpdatedAt?: string | Date | null;
}

/**
 * Draft persistence for controlled forms whose values live in React state.
 * The caller decides what is safe to serialize; `saveDraft` additionally strips
 * secret-looking keys. Restoration is explicit, so a stale draft never
 * overwrites a freshly loaded server record without the user seeing it.
 */
export function useObjectDraft<T>({
  draftKey,
  workflow,
  value,
  restore,
  enabled = true,
  debounceMs = 700,
  serverUpdatedAt,
}: UseObjectDraftOptions<T>) {
  const [status, setStatus] = useState<DraftStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const hydrated = useRef(false);
  const latest = useRef(value);

  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    hydrated.current = false;
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      setStatus("restoring");
      const draft = await loadDraft<T>(draftKey);
      if (cancelled) return;
      const serverTime = serverUpdatedAt
        ? new Date(serverUpdatedAt).getTime()
        : null;
      const draftTime = draft ? new Date(draft.updatedAt).getTime() : null;
      if (draft?.data && serverTime && draftTime && draftTime < serverTime) {
        // The record changed on the server after this draft was written. Do not
        // overwrite it; keep the draft for deliberate review.
        setLastSavedAt(draft.updatedAt);
        setStatus("conflict");
      } else if (draft?.data) {
        restore(draft.data);
        setLastSavedAt(draft.updatedAt);
        setStatus("restored");
      } else {
        setStatus("idle");
      }
      hydrated.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // `restore` is intentionally excluded: callers pass an inline function and
    // the effect must run only when the draft key or enabled flag changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, enabled, serverUpdatedAt]);

  useEffect(() => {
    if (!enabled || !hydrated.current) return;
    const timer = setTimeout(async () => {
      setStatus("saving");
      try {
        const record = await saveDraft(draftKey, workflow, latest.current);
        setLastSavedAt(record.updatedAt);
        setStatus("saved");
      } catch {
        setStatus("unavailable");
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [value, enabled, draftKey, workflow, debounceMs]);

  const clearDraft = useCallback(async () => {
    setLastSavedAt(null);
    setStatus("idle");
    await deleteDraft(draftKey);
  }, [draftKey]);

  return {
    status,
    lastSavedAt,
    clearDraft,
    acknowledgeRestored: () => setStatus(lastSavedAt ? "saved" : "idle"),
  };
}
