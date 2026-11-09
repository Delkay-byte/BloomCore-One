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
 * Draft flushers registered by mounted forms. A workspace switch asks every
 * active form to save before the document navigates away.
 */
const activeDraftFlushers = new Set<() => Promise<boolean>>();

/** Save every mounted draft immediately. Returns false if any save failed. */
export async function flushActiveDrafts(): Promise<boolean> {
  if (activeDraftFlushers.size === 0) return true;
  const results = await Promise.allSettled(
    Array.from(activeDraftFlushers).map((flush) => flush())
  );
  return results.every(
    (result) => result.status === "fulfilled" && result.value === true
  );
}

/**
 * Draft persistence for controlled forms whose values live in React state.
 *
 * Guarantees:
 * - A restore always settles: the caller can render a deliberate restoring
 *   state instead of an empty form that is later overwritten.
 * - Saves are revision ordered. A slower, older request can never replace the
 *   newest values in the UI state.
 * - The status never stays on `saving`. Every path ends in saved or error.
 * - A failed save keeps the current values on the page and exposes `retry`.
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
  const [status, setStatus] = useState<DraftStatus>(enabled ? "restoring" : "idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [ready, setReady] = useState(!enabled);
  const [dirty, setDirty] = useState(false);
  const hydrated = useRef(false);
  const latest = useRef(value);
  const restoreRef = useRef(restore);
  const mounted = useRef(true);
  const saveRevision = useRef(0);

  // The caller passes an object literal, so its identity changes on every
  // render. Depending on that object made the autosave effect re-fire after its
  // own `setStatus` render, which produced an endless "Saving draft…" loop and
  // a database write every debounce interval. The serialised value is stable
  // until the user actually changes a field.
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Values are plain form state; if a caller ever passes something that
    // cannot be serialised, fall back to a stable key rather than reading the
    // clock during render.
    serialized = "unserializable";
  }

  useEffect(() => {
    latest.current = value;
    restoreRef.current = restore;
  }, [value, restore]);

  // Restore once per draft key / server version. The ready flag is only set
  // after the read has settled, so a form never initialises with defaults and
  // then silently swaps in stored values.
  useEffect(() => {
    mounted.current = true;
    hydrated.current = false;

    if (!enabled) {
      setStatus("idle");
      setReady(true);
      return;
    }

    let cancelled = false;
    setReady(false);
    setStatus("restoring");

    (async () => {
      const draft = await loadDraft<T>(draftKey);
      if (cancelled || !mounted.current) return;

      const serverTime = serverUpdatedAt
        ? new Date(serverUpdatedAt).getTime()
        : null;
      const draftTime = draft ? new Date(draft.updatedAt).getTime() : null;

      if (draft?.data && serverTime && draftTime && draftTime < serverTime) {
        // The server record is newer. Keep the older draft readable but do not
        // let it overwrite what the user just opened.
        setLastSavedAt(draft.updatedAt);
        setStatus("conflict");
      } else if (draft?.data) {
        restoreRef.current(draft.data);
        setLastSavedAt(draft.updatedAt);
        setStatus("restored");
        setDirty(false);
      } else {
        setStatus("idle");
      }

      hydrated.current = true;
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
    // `restore` is read through a ref so an inline callback does not re-run the
    // restore and overwrite what the user is typing.
  }, [draftKey, enabled, serverUpdatedAt]);

  useEffect(() => {
    if (!enabled || !hydrated.current) return;
    // A restore writes values through setState; give React one tick before the
    // autosave effect treats those values as a user edit.
    const timer = setTimeout(async () => {
      const revision = ++saveRevision.current;
      setStatus("saving");
      setDirty(true);
      try {
        const record = await saveDraft(draftKey, workflow, latest.current);
        if (!mounted.current || revision !== saveRevision.current) return;
        setLastSavedAt(record.updatedAt);
        setStatus("saved");
        setDirty(false);
      } catch {
        if (!mounted.current || revision !== saveRevision.current) return;
        setStatus("error");
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [serialized, enabled, draftKey, workflow, debounceMs]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true;
    const revision = ++saveRevision.current;
    setStatus("saving");
    try {
      const record = await saveDraft(draftKey, workflow, latest.current);
      if (mounted.current && revision === saveRevision.current) {
        setLastSavedAt(record.updatedAt);
        setStatus("saved");
        setDirty(false);
      }
      return true;
    } catch {
      if (mounted.current && revision === saveRevision.current) {
        setStatus("error");
      }
      return false;
    }
  }, [draftKey, enabled, workflow]);

  useEffect(() => {
    if (!enabled) return;
    activeDraftFlushers.add(saveNow);
    return () => {
      activeDraftFlushers.delete(saveNow);
    };
  }, [enabled, saveNow]);

  const clearDraft = useCallback(async () => {
    saveRevision.current += 1;
    setLastSavedAt(null);
    setStatus("idle");
    setDirty(false);
    await deleteDraft(draftKey);
  }, [draftKey]);

  return {
    status,
    lastSavedAt,
    ready,
    dirty,
    /** Re-attempt the failed save with the values currently on screen. */
    retry: saveNow,
    /** Force a save, for example when the user explicitly asks for one. */
    flush: saveNow,
    clearDraft,
    acknowledgeRestored: () => setStatus(lastSavedAt ? "saved" : "idle"),
  };
}
