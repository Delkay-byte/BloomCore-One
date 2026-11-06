/**
 * Sync Manager — handles offline-to-online transaction synchronization.
 *
 * Guarantees:
 * - One transaction is submitted by one tab at a time (atomic claim + Web Lock
 *   where available). The server idempotency key is the final guard.
 * - The same idempotency key is reused on every retry. A retry never creates a
 *   new key, so a timed-out request cannot post twice.
 * - A batch stops on an expired session instead of burning retries.
 * - Partial success is preserved: acknowledged records become `synced`; the
 *   rest stay pending or failed with their original payload.
 */

import {
  claimTransactionForSync,
  getPendingTransactions,
  getSyncingTransactions,
  openOfflineDatabase,
  recoverStaleSyncing,
  updateTransaction,
  type OfflineTransaction,
} from "./store";
import { getOfflineScope, offlineDatabaseName } from "./scope";
import type { AppErrorCode } from "@/lib/errors/friendly";

// ── Offline Authorization Timeout ──────────────────────────────────────

const OFFLINE_AUTH_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUTH_CACHE_KEY = "offline-authorized-at";
let offlineAuthorizedAt: number | null = null;

async function readPersistedAuthorization(): Promise<number | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openOfflineDatabase();
    return await new Promise<number | null>((resolve) => {
      const request = db
        .transaction("meta", "readonly")
        .objectStore("meta")
        .get(AUTH_CACHE_KEY);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function persistAuthorization(timestamp: number): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openOfflineDatabase();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ key: AUTH_CACHE_KEY, value: timestamp });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Authorization still works for this page session.
  }
}

/**
 * Set the offline authorization timestamp (from server enrollment response).
 * Persisted so a reload does not silently extend the 24-hour window.
 */
export function setOfflineAuthorizedAt(timestamp: number | Date): void {
  const value =
    typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
  offlineAuthorizedAt = value;
  void persistAuthorization(value);
}

/** Load the persisted window once (used by the dashboard status display). */
export async function hydrateOfflineAuthorization(): Promise<void> {
  if (offlineAuthorizedAt !== null) return;
  offlineAuthorizedAt = await readPersistedAuthorization();
}

/** Check if offline authorization has expired. */
export function isOfflineAuthExpired(): boolean {
  if (!offlineAuthorizedAt) return false; // No enrollment yet
  return Date.now() - offlineAuthorizedAt > OFFLINE_AUTH_TIMEOUT_MS;
}

/** Seconds until offline authorization expires (0 when expired/unknown). */
export function secondsUntilOfflineAuthExpiry(): number {
  if (!offlineAuthorizedAt) return 0;
  const remaining = OFFLINE_AUTH_TIMEOUT_MS - (Date.now() - offlineAuthorizedAt);
  return Math.max(0, Math.floor(remaining / 1000));
}

// ── Retry Policy ───────────────────────────────────────────────────────

const MAX_RETRIES = 5;

// ── Sync Result ────────────────────────────────────────────────────────

export interface SyncResult {
  transactionId: string;
  success: boolean;
  serverResult?: unknown;
  error?: string;
  isRetryable: boolean;
  code?: AppErrorCode;
  retryAfterSeconds?: number;
  authExpired?: boolean;
}

// ── Server Submission ──────────────────────────────────────────────────

/**
 * Send one transaction to the server. Retries reuse `transaction.idempotencyKey`.
 */
async function submitToServer(transaction: OfflineTransaction): Promise<SyncResult> {
  try {
    const response = await fetch("/api/offline/sync-contribution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        idempotencyKey: transaction.idempotencyKey,
        payload: transaction.payload,
        deviceId: transaction.deviceId,
      }),
    });

    let data: { success?: boolean; error?: string; [key: string]: unknown } = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (response.ok && data.success) {
      return {
        transactionId: transaction.id,
        success: true,
        serverResult: data,
        isRetryable: false,
      };
    }

    if (response.status === 401) {
      return {
        transactionId: transaction.id,
        success: false,
        error: "Your session has expired. Sign in again to synchronize.",
        isRetryable: false,
        code: "session_expired",
        authExpired: true,
      };
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      return {
        transactionId: transaction.id,
        success: false,
        error: "Synchronization is temporarily paused. It will retry shortly.",
        isRetryable: true,
        code: "rate_limited",
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      };
    }

    const isRetryable =
      response.status >= 500 || response.status === 408 || response.status === 0;
    return {
      transactionId: transaction.id,
      success: false,
      error: data.error || "The record could not be synchronized.",
      isRetryable,
      code:
        response.status === 409
          ? "duplicate"
          : response.status === 403
            ? "permission_denied"
            : response.status === 400
              ? "validation"
              : response.status === 404
                ? "not_found"
                : response.status >= 500
                  ? "internal"
                  : "unknown",
    };
  } catch {
    return {
      transactionId: transaction.id,
      success: false,
      error: "No connection to MaaCash. This record will retry.",
      isRetryable: true,
      code: "offline",
    };
  }
}

// ── Sync Engine ────────────────────────────────────────────────────────

let syncInProgress = false;
let rateLimitedUntil = 0;

/** Reset the client-side cooldown. Exposed for tests. */
export function resetSyncCooldown(): void {
  rateLimitedUntil = 0;
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<T>
  ): Promise<T | null>;
}

/**
 * Run a sync under a browser-wide lock so two tabs cannot post the same record.
 * Falls back to a module flag where the Web Locks API is unavailable.
 */
async function withSyncLock<T>(run: () => Promise<T>): Promise<T | null> {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (locks?.request) {
    return locks.request("bloomcore-offline-sync", { ifAvailable: true }, async (lock) =>
      lock ? run() : null
    );
  }
  if (syncInProgress) return null;
  syncInProgress = true;
  try {
    return await run();
  } finally {
    syncInProgress = false;
  }
}

async function syncBatch(): Promise<SyncResult[]> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return [];
  if (rateLimitedUntil > Date.now()) return [];
  if (isOfflineAuthExpired()) {
    return [
      {
        transactionId: "offline-auth",
        success: false,
        error: "Offline access has expired. Sign in again to synchronize.",
        isRetryable: false,
        code: "session_expired",
        authExpired: true,
      },
    ];
  }

  // A previous tab/browser close may have left a record claimed.
  await recoverStaleSyncing();

  const pending = await getPendingTransactions();
  const results: SyncResult[] = [];

  for (const tx of pending) {
    const claimed = await claimTransactionForSync(tx.id);
    if (!claimed) continue; // another tab owns this record

    const result = await submitToServer(tx);
    results.push(result);

    const retryCount = tx.retryCount + (result.isRetryable ? 1 : 0);

    if (result.success) {
      await updateTransaction(tx.id, {
        status: "synced",
        syncedAt: new Date().toISOString(),
        serverResult: JSON.stringify(result.serverResult),
        failureReason: null,
        syncStartedAt: null,
      });
    } else if (result.authExpired) {
      // Preserve the record untouched; the user must sign in again first.
      await updateTransaction(tx.id, {
        status: "pending_sync",
        syncStartedAt: null,
        failureReason: result.error ?? null,
      });
      break;
    } else if (result.code === "rate_limited") {
      // Honour Retry-After: leave the record queued, do not burn a retry, and
      // stop the batch so the remaining records are not refused too.
      rateLimitedUntil = Date.now() + (result.retryAfterSeconds ?? 60) * 1000;
      await updateTransaction(tx.id, {
        status: "pending_sync",
        syncStartedAt: null,
        failureReason: result.error ?? null,
      });
      break;
    } else if (result.isRetryable && retryCount < MAX_RETRIES) {
      await updateTransaction(tx.id, {
        status: "pending_sync",
        retryCount,
        failureReason: result.error ?? null,
        syncStartedAt: null,
      });
    } else {
      await updateTransaction(tx.id, {
        status: "failed",
        retryCount,
        failureReason: result.error || "Max retries exceeded",
        syncStartedAt: null,
      });
    }
  }

  return results;
}

/**
 * Sync all pending transactions, oldest first. Re-entrant calls return an empty
 * result rather than starting a second batch.
 */
export async function syncPendingTransactions(): Promise<SyncResult[]> {
  try {
    const result = await withSyncLock(syncBatch);
    return result ?? [];
  } catch {
    syncInProgress = false;
    return [];
  }
}

/** Put a stale claimed record back into the queue. Exposed for tests/tools. */
export async function resetStaleClaims(): Promise<number> {
  return recoverStaleSyncing();
}

/** Check connectivity without assuming the app server is healthy. */
export async function checkConnectivity(): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  try {
    const response = await fetch("/api/health", {
      method: "GET",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── Auto Sync ──────────────────────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;
let onlineHandler: (() => void) | null = null;

export function startAutoSync(callback?: (results: SyncResult[]) => void): void {
  if (typeof window === "undefined") return;
  if (syncInterval) return;

  onlineHandler = () => {
    void (async () => {
      if (await checkConnectivity()) {
        callback?.(await syncPendingTransactions());
      }
    })();
  };
  window.addEventListener("online", onlineHandler);

  syncInterval = setInterval(() => {
    if (navigator.onLine) {
      void (async () => {
        if (await checkConnectivity()) {
          callback?.(await syncPendingTransactions());
        }
      })();
    }
  }, 30_000);
}

export function stopAutoSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (onlineHandler && typeof window !== "undefined") {
    window.removeEventListener("online", onlineHandler);
  }
  onlineHandler = null;
}

/** Include the database name in diagnostics without exposing its contents. */
export async function currentOfflineDatabaseName(): Promise<string | null> {
  try {
    const scope = await getOfflineScope();
    return offlineDatabaseName(scope);
  } catch {
    return null;
  }
}

/** Counts for a caller that wants to know whether a sync is currently active. */
export async function getSyncingCount(): Promise<number> {
  return (await getSyncingTransactions()).length;
}
