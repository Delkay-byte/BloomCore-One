"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { getOfflineStatus, type OfflineStatus } from "@/lib/offline/session";
import { prepareOfflineAccess } from "@/lib/offline/preparation";
import { isOfflineModule } from "@/lib/offline/active-module";
import { syncPendingTransactions } from "@/lib/offline/sync";
import type { ModuleName } from "@/lib/auth";
import { Skeleton } from "@/components/ui/Skeletons";

/**
 * Offline readiness, queue status and safe retry.
 *
 * A record saved locally is never labelled as successful. `pending` means the
 * record is on this device only; `synced` means the server acknowledged it. A
 * missing server connection never turns a locally readable status into
 * "unavailable", and a failed identity check is never presented as deleted
 * records.
 */
export default function OfflineSyncStatus({
  className = "",
  module,
}: {
  className?: string;
  module?: ModuleName;
}) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState("");
  const [nearLimit, setNearLimit] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getOfflineStatus(module));
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
    // Storage pressure is advisory. A failure here must not hide a readable
    // queue or turn the panel into a false "records unreadable" state.
    try {
      if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const ratio =
          estimate.quota && estimate.usage ? estimate.usage / estimate.quota : 0;
        setNearLimit(ratio >= 0.8);
      }
    } catch {
      setNearLimit(false);
    }
  }, [module]);

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

  // A cold first load can race the service worker that attaches the tab
  // credential. Retry the same authenticated check once; a genuine denial still
  // fails closed on the retry and is reported truthfully.
  const scopeRetried = useRef(false);
  useEffect(() => {
    if (loading || !status || status.scope.resolved || scopeRetried.current) return;
    if (!status.online) return;
    scopeRetried.current = true;
    const timer = setTimeout(() => void refresh(), 1_500);
    return () => clearTimeout(timer);
  }, [loading, status, refresh]);

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
      const result = await prepareOfflineAccess(
        isOfflineModule(module) ? module : undefined
      );
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

  const { summary, readiness, online, available, scope } = status;
  const attention = summary.pending + summary.failed;
  // A cached prepared context keeps offline work available, but it does not
  // prove the current online session. Only a fresh server answer (or the
  // server-rendered page identity) may be described as verified.
  const identityVerified =
    scope.resolved &&
    (!online || scope.source === "server" || scope.source === "seeded");
  // The queue's own last acknowledged sync is authoritative. When the queue is
  // unreadable, say so instead of presenting the preparation timestamp as a
  // successful synchronization.
  const lastSuccessfulSyncLabel = summary.lastSuccessfulSyncAt
    ? new Date(summary.lastSuccessfulSyncAt).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const lastPreparedLabel =
    !available && readiness.lastSyncedAt
      ? new Date(readiness.lastSyncedAt).toLocaleString("en-GB", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  // A valid local preparation is real, but it does not prove the current
  // service session. When identity or the queue cannot be confirmed, do not use
  // a green success tone.
  const healthy = available && identityVerified;
  const readinessTone = !healthy
    ? "bg-amber-50 text-amber-900"
    : readiness.status === "active"
      ? "bg-amber-50 text-amber-900"
      : readiness.status === "ready"
        ? "bg-emerald-50 text-emerald-900"
        : "bg-red-50 text-red-800";

  const scopeFailureMessage =
    scope.error === "unauthenticated"
      ? "Your online session could not be verified for this workspace. Sign in again. Saved records are not deleted."
      : scope.error === "no_tenant"
        ? "The signed-in business could not be confirmed for this workspace. Saved records are not deleted."
        : scope.error === "module_mismatch"
          ? "This device is prepared for a different workspace than the one open. Reconnect and sign in to that workspace. Saved records are not deleted."
          : scope.error === "offline_expired"
            ? "Offline authorization has expired. Reconnect and sign in again. Saved records are not deleted."
            : scope.error === "network" || scope.error === "timeout"
              ? "The online business session could not be checked. Reconnect to verify it. Saved records remain on this device."
              : "The saved-record scope could not be confirmed. Saved records are not deleted. Reload and try again before clearing site data.";

  const savedRecordMessage = !scope.resolved
    ? scopeFailureMessage
    : "Saved-record details could not be read on this device. Your records are not deleted. Reload and try again before clearing site data.";

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
              ? healthy
                ? "Offline Ready"
                : "Device prepared"
              : readiness.status === "active"
                ? "Offline Active"
                : readiness.status === "expired"
                  ? "Offline authorization expired"
                  : readiness.status === "revoked"
                    ? "Offline authorization revoked"
                    : "Preparation Required"}
        </p>
        <p className="mt-1">{readiness.message}</p>
        {identityVerified ? (
          <p className="mt-1 text-xs opacity-80">
            {online
              ? scope.source === "server"
                ? "Current online business session verified."
                : "Workspace identity confirmed by the server when this page loaded."
              : "Saved offline authorization is active. The online session is not being checked."}
          </p>
        ) : (
          <p className="mt-1 text-xs opacity-80">
            {online
              ? "Current online business session could not be verified."
              : "Using saved device preparation. Reconnect to verify the online session."}
          </p>
        )}
        {lastSuccessfulSyncLabel && (
          <p className="mt-1 text-xs opacity-80">
            Last successful synchronization: {lastSuccessfulSyncLabel}.
          </p>
        )}
        {lastPreparedLabel && (
          <p className="mt-1 text-xs opacity-80">
            Last device preparation: {lastPreparedLabel}.
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
        <div className="mt-3 rounded-control bg-amber-50 p-3 text-sm text-amber-900" role="status">
          <p>{savedRecordMessage}</p>
          <p className="mt-2 text-xs">
            This is a read or identity failure, not proof that your records were
            deleted. Do not clear site data.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="btn btn-secondary btn-sm mt-2"
          >
            <RefreshCw size={14} aria-hidden />
            Retry reading saved records
          </button>
        </div>
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
