"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter, usePathname } from "next/navigation";
import { closeCurrentOfflineSession } from "@/lib/offline/scope";

const TAB_SESSION_KEY = "bik-tab-session";
const TAB_SESSION_EVENT = "bik-tab-session-changed";

/**
 * sessionStorage as an external store. sessionStorage is tab-scoped: it is
 * NOT shared between tabs, and it is cleared when the tab is closed.
 *
 * The custom event lets login/logout (same tab) notify the store; the
 * "storage" event covers any other writer.
 */
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(TAB_SESSION_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(TAB_SESSION_EVENT, callback);
  };
}

function getSnapshot(): boolean {
  return sessionStorage.getItem(TAB_SESSION_KEY) !== null;
}

/** Server render (and hydration) always starts gated — content never leaks. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * TabSessionGuard — enforces per-tab session isolation.
 *
 * Cookies are shared across all tabs on the same origin.  To prevent a
 * copied URL from opening an authenticated session in a new tab, we also
 * require a sessionStorage flag that is only set during the login flow
 * of THIS specific tab.
 *
 * The guard GATES the page content: children are rendered only after the
 * per-tab flag is confirmed. Protected content is therefore never part of
 * the server-rendered HTML and never painted before the check — a copied
 * URL in a new tab shows only a brief loading state before being
 * redirected to /login. The dedicated administrator login page is
 * intentionally reachable without an existing session.
 */
export default function TabSessionGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const tabAuthenticated = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  const allowed = pathname === "/admin/login" || tabAuthenticated;

  useEffect(() => {
    if (!allowed) {
      // This tab never completed a login — redirect before rendering anything.
      router.replace("/login");
    }
  }, [allowed, router]);

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

  return <>{children}</>;
}

// ── Helpers used by login / logout / workspace selection ──────────────

/** Mark the current tab as authenticated.  Call after successful login. */
export function markTabAuthenticated() {
  // A new authentication context must never inherit an in-memory offline
  // scope from a previous account in this tab. Records on disk stay scoped and
  // are reopened only after the same tenant/user authenticates again.
  closeCurrentOfflineSession();
  try {
    sessionStorage.setItem(TAB_SESSION_KEY, "1");
    window.dispatchEvent(new Event(TAB_SESSION_EVENT));
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Clear the per-tab flag.  Call on logout. */
export function clearTabSession() {
  try {
    sessionStorage.removeItem(TAB_SESSION_KEY);
    window.dispatchEvent(new Event(TAB_SESSION_EVENT));
  } catch {
    /* storage unavailable — ignore */
  }
}
