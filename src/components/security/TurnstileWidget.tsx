"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Cloudflare Turnstile widget.
 *
 * The component only renders when NEXT_PUBLIC_TURNSTILE_SITE_KEY is present.
 * The server independently enforces TURNSTILE_ENABLED, so hiding or removing
 * this component in the browser never disables verification.
 *
 * The widget exposes loading, success, failure and expiry states and resets
 * itself after an unsuccessful submission via the `resetSignal` prop.
 */

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      theme?: "light" | "dark" | "auto";
      size?: "normal" | "compact" | "flexible";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      "timeout-callback"?: () => void;
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __bloomcoreTurnstileLoading?: Promise<void>;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (window.__bloomcoreTurnstileLoading) {
    return window.__bloomcoreTurnstileLoading;
  }

  window.__bloomcoreTurnstileLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject();
    document.head.appendChild(script);
  });

  return window.__bloomcoreTurnstileLoading;
}

export interface TurnstileWidgetProps {
  action: string;
  /** Increment after a failed submission to request a fresh token. */
  resetSignal?: number;
}

export default function TurnstileWidget({
  action,
  resetSignal = 0,
}: TurnstileWidgetProps) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [token, setToken] = useState("");
  const statusId = useId();

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        if (widgetId.current) {
          window.turnstile.remove(widgetId.current);
        }
        widgetId.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          size: "flexible",
          callback: (value) => {
            setToken(value);
            setStatus("ready");
          },
          "expired-callback": () => setToken(""),
          "timeout-callback": () => setToken(""),
          "error-callback": () => {
            setToken("");
            setStatus("error");
          },
        });
        setStatus((current) => (current === "error" ? current : "ready"));
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey, action]);

  useEffect(() => {
    if (!resetSignal || !window.turnstile || !widgetId.current) return;
    window.turnstile.reset(widgetId.current);
    setToken("");
  }, [resetSignal]);

  if (!siteKey) return null;

  return (
    <div className="turnstile-wrap">
      <div ref={containerRef} />
      <input type="hidden" name="turnstileToken" value={token} />
      <p
        id={statusId}
        className="turnstile-status"
        role="status"
        aria-live="polite"
      >
        {status === "error"
          ? "Security check could not load. Refresh the page or contact support."
          : token
            ? "Security check complete."
            : "Complete the security check to continue."}
      </p>
      <noscript>
        <p className="turnstile-status">
          JavaScript is required to complete the security check.
        </p>
      </noscript>
    </div>
  );
}
