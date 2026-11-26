"use client";

import { useEffect } from "react";
import {
  getCurrentOfflineContext,
  offlineContextExpired,
  type OfflineModule,
} from "@/lib/offline/device-store";
import { switchWorkspace } from "@/lib/actions/auth.actions";
import {
  ensureTabSessionWorker,
  registerTabSession,
} from "@/lib/security/tab-session-client";

/**
 * Fail closed when a protected dashboard is restored from the offline page
 * cache but the device no longer holds a valid prepared session.
 *
 * This is a safety net for sign-out and account changes. It never creates a
 * session; it only sends the browser back to the local login/offline prompt.
 *
 * The check is deliberately a load-time decision, not a connectivity reaction. A
 * connection that drops while a page is open must never navigate away from work in
 * progress; the failing save is reported in place instead.
 */
function currentModule(): OfflineModule | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname;
  if (path.startsWith("/collector")) return "susu";
  if (path.startsWith("/worker")) return "momo";
  return null;
}

/**
 * Reconcile the tab's server session with the module whose cached page is open.
 *
 * A dual-role user can switch dashboards locally while offline. When the network
 * returns, the tab may still carry the server session for the previous module.
 * The switch is re-verified by the server and the new credential is bound to
 * this tab before synchronization continues.
 */
async function reconcileModuleSession(module: OfflineModule): Promise<void> {
  try {
    // The tab proof is attached by the worker. On a cold start it may not be
    // controlling yet, so wait for it briefly before deciding the session is
    // missing.
    await ensureTabSessionWorker();
    const response = await fetch(`/api/auth/me?module=${module}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.ok) return;
    if (response.status !== 401) return;
    const switched = await switchWorkspace(module);
    if (switched.success && switched.sessionToken) {
      await registerTabSession(switched.sessionToken);
    }
  } catch {
    // The next reconnect attempt can try again. Unsynchronized records stay.
  }
}

export default function OfflineSessionGuard() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const activeModule = currentModule();
    if (!activeModule) return;

    let cancelled = false;

    async function guardOffline() {
      if (navigator.onLine) return;
      const context = await getCurrentOfflineContext().catch(() => null);
      if (cancelled) return;
      if (
        !context ||
        offlineContextExpired(context) ||
        !context.modules.includes(activeModule!)
      ) {
        window.location.replace("/login");
      }
    }

    async function reconcile() {
      if (!navigator.onLine) return;
      await reconcileModuleSession(activeModule!);
    }

    // The fail-closed check runs once, against the page as delivered. A live page that
    // merely loses its connection is not a restored cache: the agent may be halfway
    // through a day, and sending them to the login screen there would discard typed
    // figures. A save attempted while offline already fails with its own message and
    // keeps the values, which is the behaviour this product promises.
    void guardOffline();
    const onOnline = () => {
      void reconcile();
    };
    window.addEventListener("online", onOnline);
    // The page may have opened from cache while the browser still reports
    // "online"; reconcile immediately as well.
    void reconcile();
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
