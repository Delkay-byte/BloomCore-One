"use client";

import { useEffect, useRef } from "react";
import { useToast, type ToastType } from "@/components/ui/Toast";

/**
 * Raise any existing message state as a toast, once per distinct message.
 *
 * Some screens already render a rich inline banner (an offline sync summary
 * with an icon, a recovery code panel) that cannot sensibly become a plain
 * toast. This hook keeps that markup and still guarantees the popup, so the
 * owner sees the outcome without scrolling to the top.
 *
 * Passing an empty value resets the guard, so the same message can be raised
 * again by a later action.
 */
export function useNoticeToast(message: string | null | undefined, type: ToastType): void {
  const toast = useToast();
  const last = useRef<string | null>(null);

  useEffect(() => {
    const text = String(message ?? "").trim();
    if (!text) {
      last.current = null;
      return;
    }
    if (last.current === text) return;
    last.current = text;
    toast.push(type, text);
  }, [message, type, toast]);
}
