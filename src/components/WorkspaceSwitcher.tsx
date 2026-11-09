"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, Loader2 } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { switchWorkspace } from "@/lib/actions/auth.actions";
import { completeTabLogin } from "@/lib/security/tab-session-client";
import { flushActiveDrafts } from "@/hooks/useObjectDraft";

interface MePayload {
  userId: string;
  role: string;
  modules?: string[];
}

const LABELS = {
  momo: "MoMo Agent",
  susu: "Susu Collector",
} as const;

/**
 * Prominent workspace switch for dual-role (MoMo + Susu) users.
 *
 * The current tab's authenticated identity is reused. The switch is confirmed
 * in an accessible in-app dialog, active drafts are flushed first, and the
 * destination role is re-verified on the server before any route changes.
 */
export default function WorkspaceSwitcher({
  current,
  bothModules: bothModulesProp,
}: {
  current: "momo" | "susu";
  bothModules?: boolean;
}) {
  const [bothModules, setBothModules] = useState(bothModulesProp ?? false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (bothModulesProp !== undefined) return;
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
  }, [bothModulesProp]);

  if (!bothModules) return null;

  const target: "momo" | "susu" = current === "momo" ? "susu" : "momo";
  const currentLabel = LABELS[current];
  const targetLabel = LABELS[target];

  async function handleSwitch() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Preserve any draft in progress before the document navigates.
      const draftsSaved = await flushActiveDrafts();
      if (!draftsSaved) {
        setError(
          "We could not save your draft on this device. Stay here and try again before switching."
        );
        return;
      }

      const result = await switchWorkspace(target);
      if (result.success && result.sessionToken) {
        const ready = await completeTabLogin(
          result.sessionToken,
          result.redirectTo ??
            (target === "momo" ? "/worker/dashboard" : "/collector/dashboard")
        );
        if (!ready) {
          setError("Reload this page before switching dashboard.");
        }
        return;
      }
      if (result.success) {
        window.location.assign(
          target === "momo" ? "/worker/dashboard" : "/collector/dashboard"
        );
        return;
      }
      setError(result.error ?? "Could not switch dashboard.");
    } catch {
      setError("Could not switch dashboard. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="border-b border-brand-800 bg-brand-900 text-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold-300">
              Current dashboard
            </p>
            <p className="mt-0.5 text-base font-bold leading-tight sm:text-lg">
              {currentLabel} Dashboard
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setError("");
              setConfirmOpen(true);
            }}
            disabled={busy}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-white bg-white px-4 py-2.5 text-sm font-bold text-brand-900 transition-colors hover:bg-gold-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-300 disabled:opacity-60 sm:w-auto"
          >
            <ArrowLeftRight size={17} aria-hidden />
            Switch to {targetLabel}
          </button>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!busy) setConfirmOpen(false);
        }}
        title={`Switch to ${targetLabel}?`}
        description={`You are currently using the ${currentLabel} dashboard.`}
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="btn btn-secondary"
              disabled={busy}
            >
              Stay Here
            </button>
            <button
              type="button"
              onClick={handleSwitch}
              className="btn btn-primary"
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? (
                <>
                  <Loader2 size={15} className="animate-spin" aria-hidden />
                  Switching…
                </>
              ) : (
                "Yes, Switch"
              )}
            </button>
          </>
        }
      >
        <p>
          Your existing signed-in account will be used. You will not need your
          password or authenticator code again.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Any saved draft in this dashboard stays on this device and is restored
          when you return.
        </p>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
