"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { activeTokenForAction } from "@/lib/security/turnstile-actions";

/**
 * Cloudflare Turnstile widget.
 *
 * The component only renders when NEXT_PUBLIC_TURNSTILE_SITE_KEY is present.
 * The server independently enforces TURNSTILE_ENABLED, so hiding or removing
 * this component in the browser never disables verification.
 *
 * The widget exposes loading, success, failure and expiry states. Both `action`
 * and `resetSignal` are part of the widget identity: changing either unmounts
 * the old challenge and mounts a fresh one.
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

type WidgetStatus = "loading" | "ready" | "error";

/**
 * Owns exactly one Turnstile widget. The parent keys this component by action
 * and reset signal, so a change unmounts the old widget (and its challenge)
 * before the replacement is rendered. No duplicate widget can survive.
 */
function TurnstileRenderer({
  action,
  siteKey,
  onToken,
  onStatus,
}: {
  action: string;
  siteKey: string;
  onToken: (token: string) => void;
  onStatus: (status: WidgetStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          size: "flexible",
          callback: (value) => {
            if (cancelled) return;
            onToken(value);
            onStatus("ready");
          },
          "expired-callback": () => {
            if (!cancelled) onToken("");
          },
          "timeout-callback": () => {
            if (!cancelled) onToken("");
          },
          "error-callback": () => {
            if (cancelled) return;
            onToken("");
            onStatus("error");
          },
        });
        onStatus("ready");
      })
      .catch(() => {
        if (!cancelled) onStatus("error");
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Already removed by Cloudflare; nothing else to clean up.
        }
        widgetId = null;
      }
    };
  }, [action, siteKey, onToken, onStatus]);

  return <div ref={containerRef} />;
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
  // Token and status are tagged with the action and reset generation that
  // produced them. A role change or reset can therefore never submit the
  // previous challenge, even before React finishes the remount.
  const [challenge, setChallenge] = useState<{
    action: string;
    resetSignal: number;
    token: string;
  }>({ action, resetSignal, token: "" });
  const [statusState, setStatusState] = useState<{
    action: string;
    resetSignal: number;
    status: WidgetStatus;
  }>({ action, resetSignal, status: "loading" });
  const [identity, setIdentity] = useState({ action, resetSignal });

  // React's "adjust state when a prop changes" pattern. Switching roles (or
  // resetting) must permanently discard the previous challenge: returning to
  // the earlier role must not resurrect its old token.
  if (identity.action !== action || identity.resetSignal !== resetSignal) {
    setIdentity({ action, resetSignal });
    setChallenge({ action, resetSignal, token: "" });
    setStatusState({ action, resetSignal, status: "loading" });
  }

  const token =
    challenge.action === action && challenge.resetSignal === resetSignal
      ? activeTokenForAction(challenge.action, challenge.token, action)
      : "";
  const status =
    statusState.action === action && statusState.resetSignal === resetSignal
      ? statusState.status
      : "loading";
  const statusId = useId();

  const handleToken = useCallback(
    (value: string) => {
      setChallenge({ action, resetSignal, token: value });
    },
    [action, resetSignal]
  );
  const handleStatus = useCallback(
    (next: WidgetStatus) => {
      setStatusState({ action, resetSignal, status: next });
    },
    [action, resetSignal]
  );

  if (!siteKey) return null;

  return (
    <div
      className="turnstile-wrap"
      data-turnstile-action={action}
      data-turnstile-state={status}
    >
      <TurnstileRenderer
        key={`${action}:${resetSignal}`}
        action={action}
        siteKey={siteKey}
        onToken={handleToken}
        onStatus={handleStatus}
      />
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
