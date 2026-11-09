"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { getOfflineStatus, type OfflineStatus } from "@/lib/offline/session";
import { prepareOfflineAccess } from "@/lib/offline/preparation";
import { syncPendingTransactions } from "@/lib/offline/sync";
import { Skeleton } from "@/components/ui/Skeletons";

/**
 * Offline readiness, queue status and safe retry.
 *
 * A record saved locally is never labelled as successful. `pending` means the
 * record is on this device only; `synced` means the server acknowledged it. A
 * missing server connection never turns a locally readable status into
 * "unavailable".
 */
export default function OfflineSyncStatus({ className = "" }: { className?: string }) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [preparing, setPreparing] = useState(false);
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
    const onConnectivityChange = () => void refresh();
    const onStatusChange = () => void refresh();
    window.addEventListener("online", onConnectivityChange);
    window.addEventListener("offline", onConnectivityChange);
    window.addEventListener("maacash-offline-status", onStatusChange);
    return () => {
      window.removeEventListener("online", onConnectivityChange);
      window.removeEventListener("offline", onConnectivityChange);
      window.removeEventListener("maacash-offline-status", onStatusChange);
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
          `Synced. ${synced} record${synced === 1 ? "" : "s"} confirmed by the server.`
        );
      } else if (results.some((result) => result.authExpired)) {
        setNotice("Your session expired. Sign in again to synchronize.");
      } else if (results.length === 0) {
        setNotice("Nothing to synchronize right now.");
      } else {
        setNotice(
          "Sync Failed. Some collections could not be synchronized. Your saved records are still on this device."
        );
      }
    } catch {
      setNotice(
        "Sync Failed. Synchronization could not run. Your saved records are still on this device."
      );
    } finally {
      setSyncing(false);
    }
  }

  async function prepareNow() {
    setPreparing(true);
    setNotice("");
    try {
      const result = await prepareOfflineAccess();
      await refresh();
      setNotice(result.message);
    } catch {
      setNotice(
        "Offline preparation could not finish. Check the connection and try again."
      );
    } finally {
      setPreparing(false);
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
        <p className="mt-1 text-sm text-slate-600">
          The local offline status could not be read. Saved records are not deleted.
          Reload the page and try again.
        </p>
      </div>
    );
  }

  const { summary, readiness, online, available } = status;
  const attention = summary.pending + summary.failed;
  const lastSync = summary.lastSuccessfulSyncAt ?? readiness.lastSyncedAt;
  const lastSyncLabel = lastSync
    ? new Date(lastSync).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const readinessTone =
    readiness.status === "active"
      ? "bg-amber-50 text-amber-900"
      : readiness.status === "ready"
        ? "bg-emerald-50 text-emerald-900"
        : "bg-red-50 text-red-800";

  return (
    <section className={`card ${className}`} aria-labelledby="offline-status-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="offline-status-title" className="text-sm font-semibold text-slate-900">
            Offline records
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {online ? "Connected" : "Offline"} · saved for this account on this device
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {online &&
            (readiness.status === "preparation_required" ||
              readiness.status === "expired" ||
              readiness.status === "revoked") && (
              <button
                type="button"
                onClick={prepareNow}
                className="btn btn-primary btn-sm"
                disabled={preparing}
                aria-busy={preparing}
              >
                <ShieldCheck size={14} aria-hidden />
                {preparing ? "Preparing…" : "Prepare offline access"}
              </button>
            )}
          {online && attention > 0 && (
            <button
              type="button"
              onClick={retry}
              className="btn btn-secondary btn-sm"
              disabled={syncing}
              aria-busy={syncing}
            >
              <RefreshCw size={14} className={syncing ? "animate-spin" : ""} aria-hidden />
              {syncing ? "Syncing…" : "Retry synchronization"}
            </button>
          )}
        </div>
      </div>

      <div className={`mt-3 rounded-control p-3 text-sm ${readinessTone}`} role="status">
        <p className="font-semibold">
          {readiness.status === "preparing"
            ? "Preparing offline access"
            : readiness.status === "ready"
              ? "Offline Ready"
              : readiness.status === "active"
                ? "Offline Active"
                : readiness.status === "expired"
                  ? "Offline authorization expired"
                  : readiness.status === "revoked"
                    ? "Offline authorization revoked"
                    : "Preparation Required"}
        </p>
        <p className="mt-1">{readiness.message}</p>
        {lastSyncLabel && (
          <p className="mt-1 text-xs opacity-80">
            Last successful synchronization: {lastSyncLabel}.
          </p>
        )}
        {readiness.expiresAt &&
          readiness.status !== "expired" &&
          readiness.status !== "revoked" && (
          <p className="mt-1 text-xs opacity-80">
            Offline authorization valid until{" "}
            {new Date(readiness.expiresAt).toLocaleString("en-GB", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </p>
        )}
      </div>

      {nearLimit && (
        <div className="mt-3 rounded-control bg-amber-50 p-3 text-xs text-amber-900" role="status">
          Device storage is nearly full. Synchronize pending records and free space
          before collecting more offline.
        </div>
      )}

      {!available ? (
        <p className="mt-3 text-sm text-slate-600" role="status">
          Saved-record details could not be read on this device. Your records are not
          deleted. Reload and try again before clearing site data.
        </p>
      ) : attention === 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-control bg-emerald-50 p-3 text-sm text-emerald-900">
          <CheckCircle2 size={16} className="mt-0.5 flex-none" aria-hidden />
          <p>
            {summary.synced === 0
              ? "Synced. No unsynchronized offline records on this device."
              : `Synced. All ${summary.synced} offline record${
                  summary.synced === 1 ? " has" : "s have"
                } been confirmed by the server.`}
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3 text-sm">
            {summary.pending > 0 && (
              <span className="badge badge-yellow">
                <CloudOff size={12} aria-hidden /> {summary.pending} saved on device
              </span>
            )}
            {summary.failed > 0 && (
              <span className="badge badge-red">
                <AlertTriangle size={12} aria-hidden /> {summary.failed} need attention
              </span>
            )}
            {summary.syncing > 0 && (
              <span className="badge badge-blue">{summary.syncing} syncing</span>
            )}
          </div>
          {summary.failed > 0 && (
            <p className="rounded-control bg-red-50 px-3 py-2 text-xs text-red-800">
              <strong>Sync Failed.</strong> Some collections could not be
              synchronized. Your saved records are still on this device.
            </p>
          )}
          <p className="text-xs text-slate-600">
            Records marked <strong>Saved on Device — Not Yet Synced</strong> have not
            reached the central ledger. Keep this browser&apos;s site data until they
            synchronize; clearing it removes them permanently.
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
