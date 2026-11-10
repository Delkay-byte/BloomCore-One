"use client";

import { useEffect } from "react";
import {
  getCurrentOfflineContext,
  offlineContextExpired,
} from "@/lib/offline/device-store";
import { prepareOfflineAccess } from "@/lib/offline/preparation";
import {
  activeWorkspaceModule,
  isOfflineModule,
} from "@/lib/offline/active-module";

const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
let lastAttemptAt = 0;

/**
 * Keep a prepared device prepared during normal online use.
 *
 * This is deliberately silent and non-blocking. It never grants access by
 * itself: the server session is still required, and offline activation remains
 * a separate local action. A failure leaves any earlier preparation intact.
 */
export default function OfflineBootstrap() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function prepareIfNeeded(force = false) {
      if (!navigator.onLine) return;
      if (!force && Date.now() - lastAttemptAt < 60_000) return;
      lastAttemptAt = Date.now();
      const workspace = activeWorkspaceModule();
      if (!isOfflineModule(workspace)) return;
      try {
        const response = await fetch(`/api/auth/me?module=${workspace}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) return;
        const me = (await response.json()) as {
          userId?: string;
          role?: string;
          module?: string;
          tenant?: { id?: string } | null;
        };
        if (!me.userId || !me.tenant?.id) return;
        if (me.module && me.module !== workspace) return;
        if (me.role !== "worker" && me.role !== "collector") return;

        const current = await getCurrentOfflineContext();
        const sameIdentity =
          current?.tenantId === me.tenant.id && current?.userId === me.userId;
        const stale =
          !sameIdentity ||
          offlineContextExpired(current) ||
          !current?.preparedAt ||
          Date.now() - new Date(current.preparedAt).getTime() > REFRESH_AFTER_MS;
        if (!stale && !force) return;
        if (cancelled) return;
        await prepareOfflineAccess(workspace);
      } catch {
        // Offline preparation is best effort while online. Existing local
        // readiness and unsynchronized records are never weakened here.
      }
    }

    void prepareIfNeeded();
    const onOnline = () => void prepareIfNeeded(true);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
