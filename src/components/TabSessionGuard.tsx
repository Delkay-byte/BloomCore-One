"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, usePathname } from "next/navigation";
import { closeCurrentOfflineSession } from "@/lib/offline/scope";
import { classifyIdentityChange } from "@/lib/offline/session-identity";

const TAB_SESSION_KEY = "bik-tab-session";
const TAB_SESSION_EVENT = "bik-tab-session-changed";
const TAB_IDENTITY_KEY = "bik-tab-identity";
const SESSION_CHANNEL = "bloomcore-one-session-v1";
const REVALIDATE_THROTTLE_MS = 10_000;

type Verification = "pending" | "ok" | "blocked";

/**
 * sessionStorage as an external store. sessionStorage is tab-scoped: it is
 * NOT shared between tabs, and it is cleared when the tab is closed.
 *
 * Only the same-tab custom event is used here. Cross-tab notification is done
 * with BroadcastChannel, not storage events.
 */
function subscribe(callback: () => void) {
  window.addEventListener(TAB_SESSION_EVENT, callback);
  return () => window.removeEventListener(TAB_SESSION_EVENT, callback);
}

function getSnapshot(): boolean {
  return sessionStorage.getItem(TAB_SESSION_KEY) !== null;
}

/** Server render (and hydration) always starts gated — content never leaks. */
function getServerSnapshot(): boolean {
  return false;
}

function moduleForPath(pathname: string): "admin" | "momo" | "susu" | null {
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/worker")) return "momo";
  if (pathname.startsWith("/susu") || pathname.startsWith("/collector")) return "susu";
  return null;
}

function readIdentity(): string | null {
  try {
    return sessionStorage.getItem(TAB_IDENTITY_KEY);
  } catch {
    return null;
  }
}

function writeIdentity(userId: string): void {
  try {
    sessionStorage.setItem(TAB_IDENTITY_KEY, userId);
  } catch {
    /* storage unavailable — verification still runs in memory */
  }
}

function forgetIdentity(): void {
  try {
    sessionStorage.removeItem(TAB_IDENTITY_KEY);
  } catch {
    /* ignore */
  }
}

let channel: BroadcastChannel | null = null;

/** Tell other tabs that the shared authentication context may have changed. */
function broadcastSessionChanged(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    if (!channel) channel = new BroadcastChannel(SESSION_CHANNEL);
    // Non-sensitive signal only: no user id, tenant, token or personal data.
    channel.postMessage({ type: "session-changed" });
  } catch {
    // BroadcastChannel unavailable — focus/visibility revalidation still runs.
  }
}

/**
 * TabSessionGuard — enforces per-tab session isolation.
 *
 * Cookies are shared across all tabs on the same origin, so a copied URL must
 * not open an authenticated session in a new tab. A sessionStorage flag, set
 * only by this tab's login flow, gates the shell.
 *
 * Cookies can also change while a tab is open: another tab may sign in as a
 * different user. Login/logout broadcast a non-sensitive signal. On receipt the
 * tab closes its offline connections and revalidates the server identity. If
 * the identity changed, the tab clears its per-tab flag and leaves the page
 * before any cached record can render. If revalidation cannot complete (for
 * example the device is offline), the tab fails closed and shows a reconnect
 * notice instead of the previous user's content.
 */
export default function TabSessionGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const tabAuthenticated = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
  const [verification, setVerification] = useState<Verification>("pending");
  // sessionStorage is not available during server rendering. Wait for the
  // client store to hydrate before deciding the tab is unauthenticated;
  // otherwise a normal full-page load would race the hydration and redirect an
  // already-authenticated tab to /login.
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("");
  const lastChecked = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    setHydrated(true);
  }, []);
  const allowed = pathname === "/admin/login" || (hydrated && tabAuthenticated);
  const sessionModule = moduleForPath(pathname);

  const verify = useCallback(
    async (options: { force?: boolean; reason?: "signal" | "focus" | "initial" } = {}) => {
      if (inFlight.current) return;
      if (
        !options.force &&
        Date.now() - lastChecked.current < REVALIDATE_THROTTLE_MS
      ) {
        return;
      }
      inFlight.current = true;
      if (options.reason !== "initial") setVerification("pending");

      try {
        const response = await fetch(
          `/api/auth/me${sessionModule ? `?module=${sessionModule}` : ""}`,
          { cache: "no-store", credentials: "same-origin" }
        );
        if (!mounted.current) return;

        if (!response.ok) {
          closeCurrentOfflineSession();
          forgetIdentity();
          clearTabSession();
          setVerification("blocked");
          setNotice("Your session has ended. Sign in again to continue.");
          router.replace("/login?reason=session_expired");
          return;
        }

        const data = (await response.json()) as { userId?: string };
        if (!data.userId) {
          closeCurrentOfflineSession();
          forgetIdentity();
          clearTabSession();
          setVerification("blocked");
          router.replace("/login?reason=session_expired");
          return;
        }

        const previous = readIdentity();
        const identityChange = classifyIdentityChange(previous, data.userId);
        if (identityChange === "changed") {
          // A different account now owns the shared cookie. Never render or
          // synchronize the previous user's cached records in this tab.
          closeCurrentOfflineSession();
          forgetIdentity();
          clearTabSession();
          setVerification("blocked");
          setNotice(
            "A different account signed in on this browser. This tab was closed for safety."
          );
          router.replace("/workspace?reason=account_changed");
          return;
        }

        writeIdentity(data.userId);
        lastChecked.current = Date.now();
        setNotice("");
        setVerification("ok");
      } catch {
        if (!mounted.current) return;
        // Offline or server unreachable: fail closed rather than showing the
        // previous user's data under an unverified session.
        closeCurrentOfflineSession();
        setVerification("blocked");
        setNotice(
          "We need a connection to confirm this tab's session before showing your data."
        );
      } finally {
        inFlight.current = false;
      }
    },
    [sessionModule, router]
  );

  useEffect(() => {
    mounted.current = true;
    if (!allowed) return;

    void verify({ reason: "initial", force: true });

    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        bc = new BroadcastChannel(SESSION_CHANNEL);
        bc.onmessage = (event: MessageEvent) => {
          if (event.data?.type !== "session-changed") return;
          // Close local access before waiting for the server answer.
          closeCurrentOfflineSession();
          void verify({ reason: "signal", force: true });
        };
      } catch {
        bc = null;
      }
    }

    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void verify({ reason: "focus" });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void verify({ reason: "focus", force: true });
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = setInterval(onFocus, 60_000);

    return () => {
      mounted.current = false;
      bc?.close();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [allowed, verify]);

  useEffect(() => {
    if (!hydrated) return;
    if (!allowed) {
      // This tab never completed a login — redirect before rendering anything.
      router.replace("/login");
    }
  }, [allowed, hydrated, router]);

  if (!allowed) {
    return (
      <div
        className="min-h-screen bg-slate-100 flex items-center justify-center"
        role="status"
        aria-label="Checking session"
      >
        <div className="spinner"></div>
      </div>
    );
  }

  if (verification === "blocked") {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-12" role="alert">
        <div className="mx-auto w-full max-w-md">
          <div className="card text-center">
            <h1 className="text-lg font-semibold text-slate-900">
              Session check required
            </h1>
            <p className="mt-2 text-sm text-slate-600">{notice}</p>
            <p className="mt-2 text-xs text-slate-500">
              Cached offline records stay on this device and are not shown until
              your account is confirmed.
            </p>
            <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => verify({ reason: "focus", force: true })}
                className="btn btn-primary btn-sm"
              >
                Check again
              </button>
              <button
                type="button"
                onClick={() => window.location.assign("/login")}
                className="btn btn-secondary btn-sm"
              >
                Go to sign in
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (verification !== "ok") {
    return (
      <div
        className="min-h-screen bg-slate-100 flex items-center justify-center"
        role="status"
        aria-label="Confirming session"
      >
        <div className="text-center">
          <div className="spinner mx-auto mb-3"></div>
          <p className="text-sm text-slate-500">Confirming your session…</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

// ── Helpers used by login / logout / workspace selection ──────────────

/** Mark the current tab as authenticated.  Call after successful login. */
export function markTabAuthenticated() {
  // A new authentication context must never inherit an in-memory offline
  // scope from a previous account in this tab. Records on disk stay scoped and
  // are reopened only after the same tenant/user authenticates again.
  closeCurrentOfflineSession();
  forgetIdentity();
  try {
    sessionStorage.setItem(TAB_SESSION_KEY, "1");
    window.dispatchEvent(new Event(TAB_SESSION_EVENT));
  } catch {
    /* storage unavailable — ignore */
  }
  broadcastSessionChanged();
  // The login server action may still be setting the cookie when this helper is
  // called optimistically. Repeat the signal shortly after so other tabs cannot
  // miss the identity change.
  setTimeout(broadcastSessionChanged, 1_000);
  setTimeout(broadcastSessionChanged, 3_000);
}

/** Clear the per-tab flag.  Call on logout. */
export function clearTabSession() {
  try {
    sessionStorage.removeItem(TAB_SESSION_KEY);
    window.dispatchEvent(new Event(TAB_SESSION_EVENT));
  } catch {
    /* storage unavailable — ignore */
  }
  broadcastSessionChanged();
}
