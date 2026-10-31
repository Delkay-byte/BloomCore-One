"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { logout } from "@/lib/actions/auth.actions";
import { clearTabSession } from "@/components/TabSessionGuard";
import { getPendingCount } from "@/lib/offline/store";

/**
 * Sign-out button with an explicit confirmation step.
 * If there are pending offline transactions, shows a warning before sign-out.
 */
export default function ConfirmSignOutButton({
  className = "",
  label = "Sign Out",
  icon = null,
}: {
  className?: string;
  label?: string;
  icon?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [step, setStep] = useState<"confirm" | "offline-warning">("confirm");

  async function handleClick() {
    // Check for pending offline transactions before showing dialog
    try {
      const count = await getPendingCount();
      setPendingCount(count);
      if (count > 0) {
        setStep("offline-warning");
      } else {
        setStep("confirm");
      }
    } catch {
      // IndexedDB may not be available — show normal confirm
      setStep("confirm");
    }
    setOpen(true);
  }

  async function confirmSignOut() {
    setBusy(true);
    try {
      clearTabSession();
      await logout();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <>
      <button type="button" onClick={handleClick} className={className}>
        {icon === null ? <LogOut size={16} aria-hidden /> : <span className="text-lg">{icon}</span>}
        {label}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-50 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="signout-title"
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            {step === "offline-warning" ? (
              <>
                <h2 id="signout-title" className="text-lg font-semibold text-gray-900">
                  {pendingCount} collection{pendingCount !== 1 ? "s" : ""} waiting to sync
                </h2>
                <p className="text-sm text-gray-600 mt-2">
                  Signing out now will not send them to BIK Prestige. Reconnect and sync before signing out where possible.
                </p>
                <div className="flex gap-3 mt-6">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="btn btn-secondary flex-1"
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmSignOut}
                    className="btn btn-danger flex-1"
                    disabled={busy}
                  >
                    {busy ? "Signing out..." : "Sign Out Anyway"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="signout-title" className="text-lg font-semibold text-gray-900">
                  Sign out?
                </h2>
                <p className="text-sm text-gray-600 mt-2">
                  Are you sure you want to sign out of BIK Prestige Enterprise?
                </p>
                <div className="flex gap-3 mt-6">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="btn btn-secondary flex-1"
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmSignOut}
                    className="btn btn-danger flex-1"
                    disabled={busy}
                  >
                    {busy ? "Signing out..." : "Sign Out"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
