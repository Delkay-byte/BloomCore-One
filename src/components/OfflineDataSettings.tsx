"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, HardDrive, RefreshCw } from "lucide-react";
import {
  DISCARD_CONFIRMATION,
  discardCurrentOfflineData,
  getOfflineStatus,
  isCurrentOfflineDatabasePresent,
  type OfflineStatus,
} from "@/lib/offline/session";
import { syncPendingTransactions } from "@/lib/offline/sync";
import { Skeleton } from "@/components/ui/Skeletons";

/**
 * Deliberate offline-data cleanup for the signed-in collector.
 *
 * This is not part of sign-out. Deletion requires the exact confirmation
 * phrase, and pending records additionally require an explicit acknowledgement
 * that they will be lost. Another user's database can never be targeted: the
 * scope comes from the server session.
 */
export default function OfflineDataSettings() {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState("");
  const [acceptLoss, setAcceptLoss] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getOfflineStatus());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function syncNow() {
    setBusy(true);
    setNotice("");
    try {
      await syncPendingTransactions();
      await refresh();
      setNotice("Synchronization attempt finished. Review the counts above.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setNotice("");
    try {
      const result = await discardCurrentOfflineData({
        confirmation,
        allowPendingLoss: acceptLoss,
      });
      setNotice(result.message);
      if (result.deleted) {
        setConfirmOpen(false);
        setConfirmation("");
        setAcceptLoss(false);
        await refresh();
      } else if (result.status === "blocked") {
        // The browser request is still queued. Never call that success; poll
        // until it actually completes or the wait budget expires.
        setNotice(`${result.message} Checking again…`);
        for (let attempt = 0; attempt < 15; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          if (!(await isCurrentOfflineDatabasePresent())) {
            setNotice("The browser confirmed deletion after the other tabs closed.");
            setConfirmOpen(false);
            setConfirmation("");
            setAcceptLoss(false);
            await refresh();
            return;
          }
        }
        setNotice(
          "Deletion is still pending in the browser. Close every other BloomCore One tab, then use Retry synchronization or reload this page to check again."
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="card space-y-3" aria-busy="true">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-20 w-full rounded-control" />
      </div>
    );
  }

  const pending = status?.summary.pending ?? 0;
  const syncing = status?.summary.syncing ?? 0;
  const failed = status?.summary.failed ?? 0;
  const unresolved = pending + syncing + failed;
  const removalBlocked = syncing > 0;

  return (
    <section className="space-y-4 border-t border-line pt-6" aria-labelledby="offline-data-title">
      <div className="flex items-start gap-3">
        <HardDrive size={20} className="mt-0.5 text-brand-700" aria-hidden />
        <div>
          <h3 id="offline-data-title" className="text-sm font-semibold text-slate-900">
            Offline records on this device
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {unresolved > 0
              ? `${unresolved} unresolved record${unresolved === 1 ? "" : "s"}: ${pending} waiting, ${syncing} synchronizing, ${failed} failed.`
              : "No records are waiting to synchronize."}
            {status?.summary.lastSuccessfulSyncAt
              ? ` Last confirmed ${new Date(status.summary.lastSuccessfulSyncAt).toLocaleString("en-GB")}.`
              : ""}
          </p>
          {failed > 0 && (
            <p className="mt-1 text-xs text-red-700">
              Failed records are kept for review. They are not in the central ledger.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-control border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <AlertTriangle size={16} className="mr-1.5 inline -mt-0.5" aria-hidden />
        Clearing this browser&apos;s site data, or using the removal option below, permanently
        deletes records that have not synchronized. Signing out does not delete them.
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={syncNow}
          className="btn btn-secondary btn-sm"
          disabled={busy || !status?.online}
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} aria-hidden /> Retry synchronization
        </button>
        {!confirmOpen && !removalBlocked && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="btn btn-danger btn-sm"
          >
            Remove offline data…
          </button>
        )}
      </div>

      {removalBlocked && (
        <p className="text-sm text-amber-800" role="status">
          {syncing} record{syncing === 1 ? " is" : "s are"} being synchronized. Removal stays
          blocked until the server answers.
        </p>
      )}

      {confirmOpen && (
        <div className="rounded-control border border-red-200 bg-red-50 p-4 space-y-3">
          <p className="text-sm text-red-900">
            This permanently removes this account&apos;s offline database from this device.
            {unresolved > 0
              ? ` ${unresolved} unresolved record${unresolved === 1 ? "" : "s"} (${pending} waiting, ${failed} failed) will be lost.`
              : ""}
          </p>
          <label className="block text-sm font-medium text-red-900">
            Type {DISCARD_CONFIRMATION} to confirm
            <input
              type="text"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              className="mt-1 w-full"
            />
          </label>
          {unresolved > 0 && (
            <label className="flex items-start gap-2 text-sm text-red-900">
              <input
                type="checkbox"
                checked={acceptLoss}
                onChange={(event) => setAcceptLoss(event.target.checked)}
                className="mt-0.5"
              />
              I understand these unresolved records will be permanently lost.
            </label>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={remove}
              className="btn btn-danger btn-sm"
              disabled={
                busy ||
                confirmation !== DISCARD_CONFIRMATION ||
                (unresolved > 0 && !acceptLoss)
              }
            >
              {busy ? "Removing…" : "Remove offline data"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                setConfirmation("");
                setAcceptLoss(false);
              }}
              className="btn btn-secondary btn-sm"
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p className="text-sm text-slate-700" role="status" aria-live="polite">
          {notice}
        </p>
      )}
    </section>
  );
}
