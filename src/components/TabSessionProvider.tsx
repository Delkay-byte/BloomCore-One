"use client";

import { useEffect, useState } from "react";
import {
  ensureTabSessionWorker,
  tabSessionsSupported,
} from "@/lib/security/tab-session-client";

/**
 * Installs the per-tab proof-of-possession transport for every page. If the
 * browser cannot support it, authentication is refused rather than falling
 * back to a shared cookie.
 */
export default function TabSessionProvider() {
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!tabSessionsSupported()) {
        if (!cancelled) setUnsupported(true);
        return;
      }
      const registration = await ensureTabSessionWorker();
      if (!cancelled && !registration) setUnsupported(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!unsupported) return null;

  return (
    <div
      role="alert"
      data-testid="tab-session-unsupported"
      className="fixed inset-x-0 bottom-0 z-[200] border-t border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-lg"
    >
      <strong className="font-semibold">Independent tab sessions are unavailable.</strong>{" "}
      This browser cannot enable service workers or secure tab storage. Sign-in
      is disabled to protect your account. Use a current browser, allow site
      storage, and reload this page.
    </div>
  );
}
