"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteDraft, loadDraft, saveDraft } from "@/lib/offline/drafts";

export type DraftStatus =
  | "idle"
  | "restoring"
  | "restored"
  | "saving"
  | "saved"
  | "conflict"
  | "unavailable"
  | "error";

export interface UseFormDraftOptions {
  /** Stable key, e.g. `customer:new` or `customer:<id>`. */
  draftKey: string;
  /** Workflow label stored with the draft (diagnostics/expiry). */
  workflow: string;
  /** Set false for forms that must never persist (e.g. credential forms). */
  enabled?: boolean;
  /** Debounce before writing, in milliseconds. */
  debounceMs?: number;
  /** Called after a draft has been applied to the DOM. */
  onRestored?: (updatedAt: string) => void;
}

/**
 * Automatic draft persistence for a form, including uncontrolled forms that
 * submit `FormData` to a server action.
 *
 * - Saves on input/change, debounced, so a refresh loses at most a moment.
 * - Restores values when the form mounts and announces that a draft was found.
 * - Skips password/file controls: credentials are never persisted.
 * - Clears the draft only when the caller confirms a successful submit.
 * - Never leaves the indicator on `saving`: a failed write is reported with a
 *   retry action and the typed values stay on the page.
 */
export function useFormDraft(
  formRef: React.RefObject<HTMLFormElement | null>,
  {
    draftKey,
    workflow,
    enabled = true,
    debounceMs = 700,
    onRestored,
  }: UseFormDraftOptions
) {
  const [status, setStatus] = useState<DraftStatus>(enabled ? "restoring" : "idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [ready, setReady] = useState(!enabled);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoring = useRef(true);
  const touched = useRef(false);
  const mounted = useRef(true);
  const saveRevision = useRef(0);
  const onRestoredRef = useRef(onRestored);

  useEffect(() => {
    onRestoredRef.current = onRestored;
  }, [onRestored]);

  const persist = useCallback(async () => {
    const form = formRef.current;
    if (!form) return;
    const data = collectFormData(form);
    if (!data || Object.keys(data).length === 0) return;
    const revision = ++saveRevision.current;
    setStatus("saving");
    try {
      const record = await saveDraft(draftKey, workflow, data);
      if (!mounted.current || revision !== saveRevision.current) return;
      setLastSavedAt(record.updatedAt);
      setStatus("saved");
    } catch {
      if (!mounted.current || revision !== saveRevision.current) return;
      setStatus("error");
    }
  }, [draftKey, formRef, workflow]);

  const clearDraft = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    saveRevision.current += 1;
    setLastSavedAt(null);
    setStatus("idle");
    await deleteDraft(draftKey);
  }, [draftKey]);

  useEffect(() => {
    mounted.current = true;
    restoring.current = true;
    touched.current = false;

    if (!enabled) {
      setStatus("idle");
      setReady(true);
      return;
    }

    let cancelled = false;
    setReady(false);
    setStatus("restoring");

    (async () => {
      let draft: import("@/lib/offline/drafts").DraftRecord<Record<string, unknown>> | null;
      try {
        draft = await loadDraft<Record<string, unknown>>(draftKey);
      } catch {
        // Locked or unreadable offline storage must not leave the form stuck in
        // "restoring" or disable autosave. The form starts empty and remains
        // editable; the draft stays preserved on the device.
        if (!cancelled && mounted.current) {
          restoring.current = false;
          setStatus("idle");
          setReady(true);
        }
        return;
      }
      if (cancelled || !mounted.current) return;

      // A conditional form can mount one commit after `enabled` flips. Wait for
      // the ref instead of silently abandoning the draft, which used to reopen
      // the form with every field empty.
      let form = formRef.current;
      for (let attempt = 0; !form && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (cancelled || !mounted.current) return;
        form = formRef.current;
      }

      if (draft && form && !touched.current && draft.data && Object.keys(draft.data).length > 0) {
        applyDraftToForm(form, draft.data);
        setLastSavedAt(draft.updatedAt);
        setStatus("restored");
        onRestoredRef.current?.(draft.updatedAt);
      } else {
        setStatus("idle");
      }

      setReady(true);
      // Let React finish the state updates produced by restored fields before
      // the change listener starts writing again. If the user typed while the
      // read was in flight, their input wins and is saved immediately.
      requestAnimationFrame(() => {
        restoring.current = false;
        if (touched.current) void persist();
      });
    })();

    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draftKey, enabled, formRef, persist]);

  useEffect(() => {
    const form = formRef.current;
    if (!enabled || !form) return;

    const schedule = () => {
      touched.current = true;
      if (restoring.current) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void persist();
      }, debounceMs);
    };

    form.addEventListener("input", schedule);
    form.addEventListener("change", schedule);
    return () => {
      form.removeEventListener("input", schedule);
      form.removeEventListener("change", schedule);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [debounceMs, enabled, formRef, persist]);

  /** Re-attempt a failed save with the values still in the form. */
  const retry = useCallback(async () => {
    if (!enabled || !formRef.current) return;
    await persist();
  }, [enabled, formRef, persist]);

  return {
    status,
    lastSavedAt,
    ready,
    retry,
    clearDraft,
    /** Show "Draft restored"; the indicator can be dismissed. */
    acknowledgeRestored: () => setStatus(lastSavedAt ? "saved" : "idle"),
  };
}

const SKIP_INPUT_TYPES = new Set(["password", "file", "submit", "button", "reset"]);

function collectFormData(form: HTMLFormElement): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
      continue;
    }
    if (!element.name) continue;
    if (element instanceof HTMLInputElement) {
      if (SKIP_INPUT_TYPES.has(element.type)) continue;
      if (element.type === "checkbox") {
        data[element.name] = element.checked;
        continue;
      }
      if (element.type === "radio") {
        if (element.checked) data[element.name] = element.value;
        continue;
      }
    }
    if (element instanceof HTMLSelectElement && element.multiple) {
      data[element.name] = Array.from(element.selectedOptions).map((option) => option.value);
      continue;
    }
    data[element.name] = element.value;
  }
  return data;
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) {
  if (element instanceof HTMLSelectElement) {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeChecked(element: HTMLInputElement, checked: boolean) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "checked"
  );
  descriptor?.set?.call(element, checked);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Apply stored values without creating a synthetic submit. */
export function applyDraftToForm(
  form: HTMLFormElement,
  data: Record<string, unknown>
): void {
  for (const [name, raw] of Object.entries(data)) {
    const elements = Array.from(form.elements).filter(
      (el): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
        "name" in el && (el as HTMLInputElement).name === name
    );
    if (elements.length === 0) continue;

    for (const element of elements) {
      if (element instanceof HTMLInputElement) {
        if (SKIP_INPUT_TYPES.has(element.type)) continue;
        if (element.type === "checkbox") {
          setNativeChecked(element, Boolean(raw));
          continue;
        }
        if (element.type === "radio") {
          setNativeChecked(element, element.value === raw);
          continue;
        }
      }
      if (Array.isArray(raw)) {
        if (element instanceof HTMLSelectElement) {
          for (const option of Array.from(element.options)) {
            option.selected = raw.includes(option.value);
          }
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
        continue;
      }
      if (raw == null) continue;
      setNativeValue(element, String(raw));
    }
  }
}
