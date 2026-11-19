"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from "lucide-react";
import {
  enqueueToast,
  MAX_VISIBLE_TOASTS,
  type ToastRecord,
  type ToastType,
} from "./toast-queue";

/**
 * The app's single notification system.
 *
 * Mounted once in the root layout. Any client component calls
 *
 *     const toast = useToast();
 *     toast.push("error", "That did not work.");
 *
 * and the message appears in a fixed, bottom-right stack — visible regardless
 * of where the page is scrolled. Errors stay until dismissed (or until the
 * owner navigates); success and informational toasts clear themselves. The
 * stack is capped so a burst of messages can never cover the checkout controls
 * it is describing.
 *
 * Accessibility: each toast is its own live region (`role="alert"` assertive
 * for errors, `role="status"` polite otherwise), dismissal is a real button
 * reachable by keyboard, and the dismiss control names the message type.
 *
 * A duplicate of a message that is already on screen is not pushed again; the
 * existing toast is simply kept alive. That is what stops a double click from
 * producing two identical popups.
 */

export type { ToastType } from "./toast-queue";

type ToastList = ToastRecord[];

interface ToastApi {
  push: (type: ToastType, message: string) => void;
  dismiss: (id: number) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi>({
  push: () => {},
  dismiss: () => {},
  clear: () => {},
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/** Visible at once. Older toasts are dropped before the cap is exceeded. */
const MAX_VISIBLE = MAX_VISIBLE_TOASTS;

/** Errors persist; everything else clears itself. */
const AUTO_DISMISS_MS: Record<ToastType, number | null> = {
  success: 4500,
  info: 6000,
  warning: 9000,
  error: null,
};

const STYLES: Record<
  ToastType,
  { cls: string; Icon: typeof Info; label: string; accent: string }
> = {
  success: {
    cls: "banner-success",
    Icon: CheckCircle2,
    label: "Success",
    accent: "text-emerald-700",
  },
  error: { cls: "banner-error", Icon: AlertCircle, label: "Error", accent: "text-red-700" },
  info: { cls: "banner-info", Icon: Info, label: "Notice", accent: "text-blue-700" },
  warning: {
    cls: "banner-warning",
    Icon: AlertTriangle,
    label: "Warning",
    accent: "text-amber-700",
  },
};

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastList>([]);
  const listRef = useRef<ToastList>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    listRef.current = listRef.current.filter((toast) => toast.id !== id);
    setToasts(listRef.current);
  }, []);

  const push = useCallback((type: ToastType, message: string) => {
    const text = String(message ?? "").trim();
    if (!text) return;
    const result = enqueueToast(listRef.current, { id: nextId.current++, type, message: text }, MAX_VISIBLE);
    if (!result.added) return;
    for (const droppedId of result.dropped) {
      const timer = timers.current.get(droppedId);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(droppedId);
      }
    }
    listRef.current = result.list;
    setToasts(result.list);
    const added = result.list[result.list.length - 1];
    const delay = AUTO_DISMISS_MS[type];
    if (delay != null && added) {
      timers.current.set(
        added.id,
        setTimeout(() => {
          timers.current.delete(added.id);
          listRef.current = listRef.current.filter((toast) => toast.id !== added.id);
          setToasts(listRef.current);
        }, delay)
      );
    }
  }, []);

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    listRef.current = [];
    setToasts([]);
  }, []);

  // Never leave a timer behind after unmount (route change, logout).
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  const api = useMemo(() => ({ push, dismiss, clear }), [push, dismiss, clear]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        data-toast-region="true"
        className="pointer-events-none fixed inset-x-3 bottom-3 z-[110] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[26rem] sm:max-w-[calc(100vw-3rem)]"
        aria-label="Notifications"
      >
        {toasts.map((toast) => {
          const { cls, Icon, label, accent } = STYLES[toast.type];
          return (
            <div
              key={toast.id}
              role={toast.type === "error" ? "alert" : "status"}
              aria-atomic="true"
              data-toast-type={toast.type}
              className={`banner toast ${cls} pointer-events-auto items-start shadow-[0_10px_30px_rgb(15_23_42/0.18)]`}
            >
              <Icon size={18} className={`mt-0.5 flex-none ${accent}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide opacity-80">{label}</p>
                <p className="mt-0.5 break-words">{toast.message}</p>
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="ml-1 flex-none rounded p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                aria-label={`Dismiss ${label.toLowerCase()}: ${toast.message.slice(0, 80)}`}
              >
                <X size={15} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
