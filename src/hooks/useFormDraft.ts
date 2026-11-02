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
 * - Restores values on mount and announces that a draft was restored.
 * - Skips password/file controls: credentials are never persisted.
 * - Clears the draft only when the caller confirms a successful submit.
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
  const [status, setStatus] = useState<DraftStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoring = useRef(true);
  const mounted = useRef(true);

  const clearDraft = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    setLastSavedAt(null);
    setStatus("idle");
    await deleteDraft(draftKey);
  }, [draftKey]);

  useEffect(() => {
    mounted.current = true;
    restoring.current = true;

    if (!enabled) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    (async () => {
      setStatus("restoring");
      const draft = await loadDraft<Record<string, unknown>>(draftKey);
      if (cancelled || !mounted.current) return;
      const form = formRef.current;

      if (draft && form && draft.data && Object.keys(draft.data).length > 0) {
        applyDraftToForm(form, draft.data);
        setLastSavedAt(draft.updatedAt);
        setStatus("restored");
        onRestored?.(draft.updatedAt);
      } else if (draft && !form) {
        // Form not mounted yet (conditional render). Keep the draft; a later
        // mount restores it through the same effect when `enabled` changes.
        setStatus("idle");
      } else {
        setStatus("idle");
      }

      // Let React finish any state updates triggered by restored fields before
      // the change listener starts writing again.
      setTimeout(() => {
        restoring.current = false;
      }, 0);
    })();

    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draftKey, enabled, formRef, onRestored]);

  useEffect(() => {
    const form = formRef.current;
    if (!enabled || !form) return;

    const schedule = () => {
      if (restoring.current) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const data = collectFormData(form);
        if (!data || Object.keys(data).length === 0) return;
        setStatus("saving");
        try {
          const record = await saveDraft(draftKey, workflow, data);
          if (!mounted.current) return;
          setLastSavedAt(record.updatedAt);
          setStatus("saved");
        } catch {
          if (!mounted.current) return;
          setStatus("unavailable");
        }
      }, debounceMs);
    };

    form.addEventListener("input", schedule);
    form.addEventListener("change", schedule);
    return () => {
      form.removeEventListener("input", schedule);
      form.removeEventListener("change", schedule);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draftKey, debounceMs, enabled, formRef, workflow]);

  return {
    status,
    lastSavedAt,
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
