"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";

/**
 * Lightweight toast notifications — the app's first shared notification
 * system. Mount <ToastProvider> once (root layout); call useToast().push()
 * from any client component. Toasts are aria-live so screen readers announce
 * them, and auto-dismiss after 4.5s (errors stay until dismissed).
 */

type ToastType = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastApi {
  push: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const STYLES: Record<ToastType, { cls: string; Icon: typeof Info; label: string }> = {
  success: { cls: "banner-success", Icon: CheckCircle2, label: "Success" },
  error: { cls: "banner-error", Icon: AlertCircle, label: "Error" },
  info: { cls: "banner-info", Icon: Info, label: "Notice" },
  warning: { cls: "banner-warning", Icon: AlertTriangle, label: "Warning" },
};

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((type: ToastType, message: string) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, type, message }]);
    if (type !== "error") {
      setTimeout(() => {
        setToasts((list) => list.filter((t) => t.id !== id));
      }, 4500);
    }
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Screen-reader announcements even before the region is visually seen */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {toasts.map((t) => `${STYLES[t.type].label}: ${t.message}`)}
      </div>
      <div className="fixed bottom-4 right-4 z-[110] flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] sm:w-auto">
        {toasts.map((t) => {
          const { cls, Icon, label } = STYLES[t.type];
          return (
            <div key={t.id} role="status" className={`banner ${cls} shadow-[0_4px_12px_rgb(15_23_42/0.12)]`}>
              <Icon size={18} className="flex-none mt-0.5" aria-hidden />
              <span className="flex-1">
                <span className="sr-only">{label}: </span>
                {t.message}
              </span>
              <button
                type="button"
                onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
                className="text-sm underline underline-offset-2 flex-none"
                aria-label={`Dismiss ${label.toLowerCase()}`}
              >
                Dismiss
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
