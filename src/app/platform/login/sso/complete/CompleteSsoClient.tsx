"use client";

import { useEffect, useState } from "react";
import { claimSsoSession } from "./actions";
import { completeTabLogin } from "@/lib/security/tab-session-client";

export default function CompleteSsoClient() {
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await claimSsoSession();
      if (cancelled) return;
      if (!result.success || !result.sessionToken || !result.redirectTo) {
        setError(result.error || "Single sign-on could not be completed.");
        return;
      }
      const ok = await completeTabLogin(result.sessionToken, result.redirectTo);
      if (!ok && !cancelled) {
        // completeTabLogin either reloads (pending handoff) or failed hard.
        setError(
          "This browser could not establish an isolated tab session. Use a current browser and try again."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-950 px-4">
      <div className="text-center text-white" role="status">
        <div className="spinner mx-auto mb-4" />
        <p className="text-sm">
          {error || "Completing secure single sign-on…"}
        </p>
        {error && (
          <a href="/platform/login" className="mt-4 inline-block text-gold-300 underline text-sm">
            Back to sign in
          </a>
        )}
      </div>
    </div>
  );
}
