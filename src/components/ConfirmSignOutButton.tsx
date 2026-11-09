"use client";

import { useEffect, useState } from "react";
import { LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { logout } from "@/lib/actions/auth.actions";
import {
  clearOfflineAppCache,
  clearTabSession,
} from "@/lib/security/tab-session-client";
import { getOfflineQueueSummary, type OfflineQueueSummary } from "@/lib/offline/store";
import { syncBeforeSignOut, endOfflineSession } from "@/lib/offline/session";
import { PRODUCT_NAME } from "@/lib/site";

/**
 * Sign-out button with an explicit confirmation step.
 *
 * Pending offline records are never deleted on sign-out. If the device is
 * online the user can synchronize first; records that still cannot be sent stay
 * in this user's isolated local database and are resumed when the same user
 * signs in again on this device.
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
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [summary, setSummary] = useState<OfflineQueueSummary | null>(null);
  const [notice, setNotice] = useState("");

  async function handleClick() {
    setNotice("");
    setOpen(true);
    setChecking(true);
    try {
      setSummary(await getOfflineQueueSummary());
    } catch {
      setSummary(null);
    } finally {
      setChecking(false);
    }
  }

  async function trySync() {
    setSyncing(true);
    setNotice("");
    try {
      const result = await syncBeforeSignOut();
      setSummary(await getOfflineQueueSummary());
      if (result.pending === 0 && result.failed === 0) {
        setNotice("All records synchronized. You can sign out now.");
      } else if (result.offline) {
        setNotice("Still offline. The records stay safely on this device.");
      } else {
        setNotice(
          `${result.pending + result.failed} record${result.pending + result.failed === 1 ? "" : "s"} still need attention. They stay on this device.`
        );
      }
    } catch {
      setNotice("Synchronization could not run. The records stay on this device.");
    } finally {
      setSyncing(false);
    }
  }

  async function confirmSignOut() {
    setBusy(true);
    try {
      // Best effort: sync what can be synced, then close local access. Pending
      // records are deliberately retained on disk.
      await syncBeforeSignOut().catch(() => null);
      endOfflineSession();
      // The request still carries this tab's handle, so the server can revoke
      // exactly this session. Only then remove the tab's local mapping.
      const result = await logout();
      await clearTabSession();
      // Remove cached pages for this account. Queued financial records are kept
      // in their scoped database and are never deleted by sign-out.
      await clearOfflineAppCache();
      window.location.assign(result.redirectTo ?? "/login");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const pending = (summary?.pending ?? 0) + (summary?.failed ?? 0);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy && !syncing) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, busy, syncing]);

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
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 id="signout-title" className="text-lg font-semibold text-gray-900">
              {checking
                ? "Checking offline records…"
                : pending > 0
                  ? `${pending} record${pending === 1 ? "" : "s"} not yet synchronized`
                  : "Sign out?"}
            </h2>

            {checking ? (
              <p className="text-sm text-gray-600 mt-2">Reading this device&apos;s offline queue.</p>
            ) : pending > 0 ? (
              <>
                <p className="text-sm text-gray-600 mt-2">
                  These records are stored safely on this device for your account.
                  Signing out will <strong>not</strong> delete them. Sign in again on
                  this device as the same user to synchronize.
                </p>
                <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
                  <ShieldAlert size={16} className="inline mr-1.5 -mt-0.5" aria-hidden />
                  They are not in {PRODUCT_NAME}&apos;s central ledger until synchronization
                  succeeds. Do not clear this browser&apos;s site data.
                </div>
                {summary && summary.failed > 0 && (
                  <p className="text-xs text-red-700 mt-2">
                    {summary.failed} record{summary.failed === 1 ? "" : "s"} need attention
                    after repeated failures. They are kept for review.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-600 mt-2">
                Are you sure you want to sign out of {PRODUCT_NAME}?
              </p>
            )}

            {notice && (
              <p className="text-sm text-slate-700 mt-3" role="status">
                {notice}
              </p>
            )}

            <div className="flex flex-col gap-2 mt-6">
              {pending > 0 && (
                <button
                  type="button"
                  onClick={trySync}
                  className="btn btn-primary w-full"
                  disabled={busy || syncing || checking}
                >
                  {syncing ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" aria-hidden /> Synchronizing…
                    </>
                  ) : (
                    "Synchronize now"
                  )}
                </button>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="btn btn-secondary flex-1"
                  disabled={busy || syncing}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmSignOut}
                  className={`btn flex-1 ${pending > 0 ? "btn-danger" : "btn-primary"}`}
                  disabled={busy || syncing || checking}
                >
                  {busy ? "Signing out…" : pending > 0 ? "Sign out and keep records" : "Sign Out"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
