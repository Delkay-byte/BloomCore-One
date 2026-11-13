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
import { prepareOfflineAccess, reconcileOfflineConnectivity } from "@/lib/offline/preparation";
import { getCurrentOfflineContext } from "@/lib/offline/device-store";
import { getOfflineQueueSummary } from "@/lib/offline/store";
import { isOfflineModule } from "@/lib/offline/active-module";
import {
  checkConnectivity,
  summarizeSyncOutcome,
  syncPendingTransactions,
} from "@/lib/offline/sync";
import { isOfflineUnlocked } from "@/lib/offline/unlock";
import { deriveOfflineDisplayStatus } from "@/lib/offline/state";
import type { ModuleName } from "@/lib/auth";
import { Skeleton } from "@/components/ui/Skeletons";

/**
 * Offline readiness, queue status and safe retry.
 *
 * Connectivity, device preparation, workspace unlock and queue synchronization
 * are shown as separate facts. A record saved locally is never described as a
 * successful posting; only a server acknowledgement is "synced". A transient
 * network failure is "waiting", not "needs attention".
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
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getOfflineStatus(module);
      setStatus(next);
      const context = await getCurrentOfflineContext();
      setUnlocked(context ? isOfflineUnlocked(context) : false);
    } catch {
      setStatus(null);
      setUnlocked(false);
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

  /**
   * Reconcile connectivity on real events only. A bounded server check proves
   * the backend actually answers; `navigator.onLine` alone does not.
   */
  const syncConnectivity = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setServerReachable(null);
      await reconcileOfflineConnectivity(
        isOfflineModule(module) ? module : undefined
      ).catch(() => undefined);
      return;
    }
    const reachable = await checkConnectivity().catch(() => false);
    setServerReachable(reachable);
    if (reachable) {
      // Clear a stale local activation flag; the device is online and ready.
      await reconcileOfflineConnectivity(
        isOfflineModule(module) ? module : undefined
      ).catch(() => undefined);
    }
  }, [module]);

  useEffect(() => {
    void (async () => {
      await refresh();
      await syncConnectivity();
      await refresh();
    })();

    const onConnectivityChange = () => {
      setNotice("");
      void (async () => {
        await syncConnectivity();
        await refresh();
      })();
    };
    const onStatusChange = () => {
      setNotice("");
      void refresh();
    };
    const onUnlockChange = () => {
      setNotice("");
      void refresh();
    };
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void (async () => {
        await syncConnectivity();
        await refresh();
      })();
    };

    window.addEventListener("online", onConnectivityChange);
    window.addEventListener("offline", onConnectivityChange);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("maacash-offline-status", onStatusChange);
    window.addEventListener("maacash-offline-unlock-changed", onUnlockChange);
    return () => {
      window.removeEventListener("online", onConnectivityChange);
      window.removeEventListener("offline", onConnectivityChange);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("maacash-offline-status", onStatusChange);
      window.removeEventListener("maacash-offline-unlock-changed", onUnlockChange);
    };
  }, [refresh, syncConnectivity]);

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
      const results = await syncPendingTransactions({ retryExhausted: true });
      const outcome = summarizeSyncOutcome(results);
      await refresh();
      if (outcome.confirmed > 0) {
        setNotice(
          `Collection synchronized successfully. ${outcome.confirmed} record${
            outcome.confirmed === 1 ? "" : "s"
          } confirmed by the server.`
        );
      } else if (outcome.authExpired) {
        setNotice("Your session expired. Sign in again to synchronize.");
      } else if (outcome.locked) {
        setNotice("Unlock the offline workspace before synchronizing.");
      } else if (outcome.rejected.length > 0) {
        setNotice(
          `${outcome.rejected.length} record${
            outcome.rejected.length === 1 ? " was" : "s were"
          } rejected by the server. See the reason below.`
        );
      } else if (outcome.transient > 0) {
        setNotice("No connection to MaaCash. The records stay on this device and will retry.");
      } else {
        const remaining = await getOfflineQueueSummary().catch(() => null);
        setNotice(
          remaining && remaining.pending > 0
            ? "Synchronization did not run. Another tab may be syncing, or the queue could not be read. Try again."
            : "Nothing to synchronize right now."
        );
      }
    } catch {
      setNotice(
        "Synchronization could not run. Your saved records are still on this device and will retry."
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
      if (result.requiresUnlockSetup) {
        window.dispatchEvent(new Event("maacash-offline-unlock-setup"));
      }
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

  const { summary, readiness, available, scope } = status;
  const display = deriveOfflineDisplayStatus({
    online: status.online,
    serverReachable,
    readiness,
    queue: summary,
    available,
    unlocked,
  });

  const lastSuccessfulSyncLabel = display.lastSuccessfulSyncAt
    ? new Date(display.lastSuccessfulSyncAt).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const lastVerifiedLabel = readiness.context?.authorizedAt
    ? new Date(readiness.context.authorizedAt).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const tone = !available
    ? "bg-amber-50 text-amber-900"
    : display.readiness === "revoked" || display.readiness === "expired"
      ? "bg-red-50 text-red-800"
      : display.workingOffline || display.readiness === "unlock_required"
        ? "bg-amber-50 text-amber-900"
        : display.readiness === "preparation_required"
          ? "bg-slate-50 text-slate-800"
          : "bg-emerald-50 text-emerald-900";

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

  const identityLine = (() => {
    if (!scope.resolved) return null;
    if (!status.online) {
      return lastVerifiedLabel
        ? `Last verified online at ${lastVerifiedLabel}. Offline authorization remains valid until ${
            readiness.expiresAt
              ? new Date(readiness.expiresAt).toLocaleString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "the saved expiry"
          }.`
        : "Using saved device preparation. Reconnect to verify the online session.";
    }
    if (scope.source === "server") {
      return "Online identity verified by the server for this page.";
    }
    return "Workspace loaded from your signed-in server page. Live identity was not re-checked.";
  })();

  const actionable = summary.failedRecords.filter(
    (record) => record.retryable !== true
  );

  return (
    <section className={`card ${className}`} aria-labelledby="offline-status-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="offline-status-title" className="text-sm font-semibold text-slate-900">
            Offline records
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Saved on this device · scoped to your account
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {display.readiness === "preparation_required" && status.online && (
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
          {display.readiness === "unlock_required" && (
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new Event("maacash-offline-unlock-required"))
              }
              className="btn btn-primary btn-sm"
            >
              <ShieldCheck size={14} aria-hidden />
              Unlock offline workspace
            </button>
          )}
          {status.online &&
            (display.waitingCount > 0 ||
              summary.failedRecords.some(
                (record) => record.classification === "exhausted"
              )) && (
            <button
              type="button"
              onClick={retry}
              className="btn btn-secondary btn-sm"
              disabled={syncing}
              aria-busy={syncing}
            >
              <RefreshCw size={14} className={syncing ? "animate-spin" : ""} aria-hidden />
              {syncing ? "Synchronizing…" : "Sync now"}
            </button>
          )}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        <div className="rounded-control bg-slate-50 px-3 py-2">
          <dt className="text-slate-500">Connection</dt>
          <dd className="mt-0.5 font-semibold text-slate-900">
            {display.connectivityLabel}
          </dd>
        </div>
        <div className="rounded-control bg-slate-50 px-3 py-2">
          <dt className="text-slate-500">Device</dt>
          <dd className="mt-0.5 font-semibold text-slate-900">
            {display.readinessLabel}
          </dd>
        </div>
        <div className="col-span-2 rounded-control bg-slate-50 px-3 py-2 sm:col-span-1">
          <dt className="text-slate-500">Offline queue</dt>
          <dd className="mt-0.5 font-semibold text-slate-900">
            {!display.queueReadable
              ? "Unreadable"
              : display.syncingCount > 0
                ? `${display.syncingCount} synchronizing`
                : display.attentionCount > 0
                  ? `${display.attentionCount} need attention`
                  : display.waitingCount > 0
                    ? `${display.waitingCount} waiting to sync`
                    : "Nothing waiting"}
          </dd>
        </div>
      </dl>

      <div className={`mt-3 rounded-control p-3 text-sm ${tone}`} role="status">
        <p className="font-semibold">{display.readinessLabel}</p>
        <p className="mt-1">{readiness.message}</p>
        {identityLine && <p className="mt-1 text-xs opacity-80">{identityLine}</p>}
        {lastSuccessfulSyncLabel && (
          <p className="mt-1 text-xs opacity-80">
            Last successful synchronization: {lastSuccessfulSyncLabel}.
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
      ) : display.readiness === "unlock_required" ? (
        <div className="mt-3 rounded-control bg-slate-50 p-3 text-sm text-slate-700" role="status">
          Queue details are hidden while the workspace is locked. The records are
          preserved on this device and cannot be read without the offline passphrase.
        </div>
      ) : display.attentionCount > 0 ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="badge badge-red">
              <AlertTriangle size={12} aria-hidden /> {display.attentionCount} need attention
            </span>
            {display.waitingCount > 0 && (
              <span className="badge badge-yellow">
                <CloudOff size={12} aria-hidden /> {display.waitingCount} waiting to sync
              </span>
            )}
          </div>
          <p className="rounded-control bg-red-50 px-3 py-2 text-xs text-red-800">
            <strong>Server rejected.</strong> These records stay on this device
            until the reason is resolved. They are not in the central ledger.
            {display.reviewCount > 0
              ? ` ${display.reviewCount} older record${display.reviewCount === 1 ? " has" : "s have"} no conclusive saved reason and need explicit review.`
              : ""}
          </p>
          <ul className="space-y-1.5 text-xs text-red-800">
            {actionable.map((record) => (
              <li key={record.id} className="rounded-control bg-red-50 px-2.5 py-1.5">
                <span className="font-medium">
                  {record.type === "contribution" ? "Contribution" : "Daily account draft"}
                </span>{" "}
                · record {record.id.slice(0, 8)} ·{" "}
                {record.classification === "unknown"
                  ? "Older record: the saved reason is inconclusive. Review before retrying."
                  : record.classification === "exhausted"
                    ? `${record.failureReason ?? "Repeated connection failure"} — retry when the connection is stable.`
                    : record.failureReason ?? "Rejected by the server"}
              </li>
            ))}
          </ul>
        </div>
      ) : display.waitingCount > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-control bg-amber-50 p-3 text-sm text-amber-900" role="status">
          <CloudOff size={16} className="mt-0.5 flex-none" aria-hidden />
          <p>
            {display.waitingCount} collection{display.waitingCount === 1 ? " is" : "s are"}{" "}
            saved on this device and waiting to synchronize. They are not in the
            central ledger yet.
          </p>
        </div>
      ) : (
        <div className="mt-3 flex items-start gap-2 rounded-control bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
          <CheckCircle2 size={16} className="mt-0.5 flex-none" aria-hidden />
          <p>
            {display.syncedCount === 0
              ? "No unsynchronized offline records on this device."
              : `All ${display.syncedCount} offline record${
                  display.syncedCount === 1 ? " has" : "s have"
                } been confirmed by the server.`}
          </p>
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
