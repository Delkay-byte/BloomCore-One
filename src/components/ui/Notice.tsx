"use client";

import { useEffect, useRef } from "react";
import { useToast, type ToastType } from "./Toast";

/**
 * The single notice primitive for the whole app.
 *
 * It renders the message where it belongs in the flow AND raises the same
 * message as a toast, so an action result is visible even when the owner has
 * scrolled away from the top of the page. Every surface therefore uses one
 * visual language: `.banner banner-{type}` inline, and the shared toast stack
 * for the popup.
 *
 * A notice is raised once per distinct message. Re-rendering the same failure
 * (a double click, a router refresh) never produces a second popup.
 */
export default function Notice({
  type,
  children,
  message,
  className = "",
  popup = true,
  role,
}: {
  type: ToastType;
  children?: React.ReactNode;
  /** Popup text. Defaults to string/number children. */
  message?: string;
  className?: string;
  /** Set false for a purely contextual panel that must not interrupt. */
  popup?: boolean;
  role?: "alert" | "status";
}) {
  const toast = useToast();
  const text = message ?? (typeof children === "string" ? children : "");
  const last = useRef<string | null>(null);

  useEffect(() => {
    const value = text.trim();
    if (!popup || !value) {
      if (!value) last.current = null;
      return;
    }
    if (last.current === value) return;
    last.current = value;
    toast.push(type, value);
  }, [popup, text, toast, type]);

  const resolvedRole = role ?? (type === "error" ? "alert" : "status");

  return (
    <div role={resolvedRole} className={`banner banner-${type} ${className}`.trim()}>
      {children ?? text}
    </div>
  );
}
