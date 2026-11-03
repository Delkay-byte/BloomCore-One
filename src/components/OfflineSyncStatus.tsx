"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudOff, RefreshCw } from "lucide-react";
import { getOfflineStatus, type OfflineStatus } from "@/lib/offline/session";
import { syncPendingTransactions } from "@/lib/offline/sync";
import { Skeleton } from "@/components/ui/Skeletons";

/**
 * Offline queue status and safe retry.
 *
 * It never labels a locally stored record as successful. `pending` means the
 * record is on this device only; `synced` means the server acknowledged it.
 */
export default function OfflineSyncStatus({ className = "" }: { className?: string }) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState("");
  const [nearLimit, setNearLimit] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getOfflineStatus());
      if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const ratio =
          estimate.quota && estimate.usage ? estimate.usage / estimate.quota : 0;
        setNearLimit(ratio >= 0.8);
      }
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onOnline = () => void refresh();
    const onOffline = () => void refresh();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refresh]);

  async function retry() {
    setSyncing(true);
    setNotice("");
    try {
      const results = await syncPendingTransactions();
      await refresh();
      const synced = results.filter((result) => result.success).length;
      if (synced > 0) {
        setNotice(
          `${synced} record${synced === 1 ? "" : "s"} confirmed by the server.`
        );
      } else if (results.some((result) => result.authExpired)) {
        setNotice("Your session expired. Sign in again to synchronize.");
      } else if (results.length === 0) {
        setNotice("Nothing to synchronize right now.");
      } else {
        setNotice("Synchronization did not complete. The records are still on this device.");
      }
    } catch {
      setNotice("Synchronization could not run. The records are still on this device.");
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <div className={`card space-y-3 ${className}`} aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full rounded-control" />
      </div>
    );
  }

  if (!status) {
    return (
      <div className={`card ${className}`}>
        <h2 className="text-sm font-semibold text-slate-900">Offline records</h2>
        <p className="text-sm text-slate-500 mt-1">
          Offline status is unavailable on this device.
        </p>
      </div>
    );
  }

  const { summary, online } = status;
  const attention = summary.pending + summary.failed;
  const lastSync = summary.lastSuccessfulSyncAt
    ? new Date(summary.lastSuccessfulSyncAt).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <section className={`card ${className}`} aria-labelledby="offline-status-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="offline-status-title" className="text-sm font-semibold text-slate-900">
            Offline records
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {online ? "Connected" : "Offline"} · saved for this account on this device
          </p>
        </div>
        <button
          type="button"
          onClick={retry}
          className="btn btn-secondary btn-sm"
          disabled={syncing || !online}
        >
          <RefreshCw size={14} className={syncing ? "animate-spin" : ""} aria-hidden />
          {syncing ? "Synchronizing…" : "Retry synchronization"}
        </button>
      </div>

      {nearLimit && (
        <div className="mt-3 rounded-control bg-amber-50 p-3 text-xs text-amber-900" role="status">
          Device storage is nearly full. Synchronize pending records and free space before
          collecting more offline.
        </div>
      )}

      {attention === 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-control bg-emerald-50 p-3 text-sm text-emerald-900">
          <CheckCircle2 size={16} className="mt-0.5 flex-none" aria-hidden />
          <p>
            {summary.synced === 0
              ? "No offline records on this device."
              : `All ${summary.synced} offline record${summary.synced === 1 ? " has" : "s have"} been confirmed by the server.`}
            {lastSync ? ` Last synchronized ${lastSync}.` : ""}
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3 text-sm">
            {summary.pending > 0 && (
              <span className="badge badge-yellow">
                <CloudOff size={12} aria-hidden /> {summary.pending} waiting to sync
              </span>
            )}
            {summary.failed > 0 && (
              <span className="badge badge-red">
                <AlertTriangle size={12} aria-hidden /> {summary.failed} need attention
              </span>
            )}
            {summary.syncing > 0 && (
              <span className="badge badge-blue">{summary.syncing} synchronizing</span>
            )}
          </div>
          <p className="text-xs text-slate-600">
            Waiting records have not reached the central ledger. Keep this browser&apos;s
            site data until they synchronize; clearing it removes them permanently.
          </p>
          {summary.failedRecords.length > 0 && (
            <ul className="space-y-1.5 text-xs text-red-800">
              {summary.failedRecords.map((record) => (
                <li key={record.id} className="rounded-control bg-red-50 px-2.5 py-1.5">
                  <span className="font-medium">
                    {record.type === "contribution" ? "Contribution" : "Daily account draft"}
                  </span>{" "}
                  · {record.failureReason ?? "Rejected by the server"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {notice && (
        <p className="mt-3 text-xs text-slate-700" role="status" aria-live="polite">
          {notice}
        </p>
      )}
    </section>
  );
}
