"use client";

import { useEffect } from "react";
import { ensureTabSessionWorker } from "@/lib/security/tab-session-client";

/**
 * Installs the per-tab session transport for every page, including the public
 * login page. Registration is idempotent; the worker binds a handle only when
 * a login explicitly hands it one.
 *
 * This component deliberately renders nothing and does not gate the page. The
 * server remains the authorization authority: an unauthenticated tab is
 * redirected by middleware before this component runs.
 */
export default function TabSessionProvider() {
  useEffect(() => {
    void ensureTabSessionWorker();
  }, []);

  return null;
}
