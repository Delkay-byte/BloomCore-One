"use client";

import { useEffect, useState } from "react";
import { switchWorkspace } from "@/lib/actions/auth.actions";
import { completeTabLogin } from "@/lib/security/tab-session-client";

interface MePayload {
  userId: string;
  role: string;
  modules?: string[];
}

/**
 * Visible module switch for dual-role (MoMo + Susu) users.
 * Renders only when the authenticated account is registered for both modules.
 */
export default function WorkspaceSwitcher({ current }: { current: "momo" | "susu" }) {
  const [bothModules, setBothModules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me: MePayload | null) => {
        if (!cancelled && me?.modules?.includes("momo") && me.modules.includes("susu")) {
          setBothModules(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!bothModules) return null;

  const target: "momo" | "susu" = current === "momo" ? "susu" : "momo";
  const targetLabel = target === "momo" ? "MoMo" : "Susu";
  const currentLabel = current === "momo" ? "MoMo" : "Susu";

  async function handleSwitch() {
    setBusy(true);
    try {
      const result = await switchWorkspace(target);
      if (result.success && result.sessionToken) {
        const ready = await completeTabLogin(
          result.sessionToken,
          result.redirectTo ??
            (target === "momo" ? "/worker/dashboard" : "/collector/dashboard")
        );
        if (!ready) {
          setError("Reload this page before switching workspace.");
        }
      } else if (result.error) {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-400 hidden sm:inline">Workspace:</span>
      <span className="font-medium text-gray-600">{currentLabel}</span>
      <button
        type="button"
        onClick={handleSwitch}
        disabled={busy}
        className="px-2 py-1 rounded-md border border-green-200 bg-green-50 text-green-700 font-medium hover:bg-green-100 transition-colors disabled:opacity-50"
      >
        {busy ? "Switching..." : `Switch to ${targetLabel}`}
      </button>
      {error && (
        <span role="alert" className="text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}
