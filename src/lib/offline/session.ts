/**
 * Offline session lifecycle: sign-out, account switch and explicit cleanup.
 *
 * Sign-out must stay possible for security, but it must never destroy queued
 * financial records. The database is named for the tenant and user, so closing
 * the session hides the data from the next account without deleting it. Only a
 * deliberate, typed confirmation in the offline settings deletes the current
 * user's database, and even then pending records block it unless the user
 * explicitly acknowledges their loss.
 */

import {
  deleteDatabase,
  getOfflineScope,
  closeCurrentOfflineSession,
  offlineDatabaseName,
} from "./scope";
import {
  getOfflineQueueSummary,
  getPendingTransactions,
  pruneSyncedTransactions,
  recoverStaleSyncing,
  type OfflineQueueSummary,
} from "./store";
import { syncPendingTransactions } from "./sync";
import { pruneExpiredDrafts } from "./drafts";

export interface SignOutSummary {
  pending: number;
  failed: number;
  synced: number;
  attemptedSync: boolean;
  offline: boolean;
  authExpired: boolean;
}

/**
 * Try to synchronize before sign-out, then close the local session. The
 * database is never deleted here.
 */
export async function syncBeforeSignOut(): Promise<SignOutSummary> {
  const before = await getOfflineQueueSummary();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  let attemptedSync = false;
  let authExpired = false;

  if (!offline && before.pending > 0) {
    attemptedSync = true;
    await recoverStaleSyncing();
    const results = await syncPendingTransactions();
    authExpired = results.some((result) => result.authExpired);
  }

  await pruneSyncedTransactions();
  await pruneExpiredDrafts();

  const after = await getOfflineQueueSummary();
  return {
    pending: after.pending,
    failed: after.failed,
    synced: after.synced,
    attemptedSync,
    offline,
    authExpired,
  };
}

/** Close connections and forget the in-memory scope. Records stay on disk. */
export function endOfflineSession(): void {
  closeCurrentOfflineSession();
}

export interface DiscardResult {
  deleted: boolean;
  pending: number;
  message: string;
}

export const DISCARD_CONFIRMATION = "DELETE OFFLINE DATA";

/**
 * Deliberately destroy the signed-in user's offline database.
 *
 * Requires the exact confirmation phrase. When pending financial records exist,
 * a second explicit acknowledgement is required; otherwise the operation is
 * refused so ordinary cleanup cannot destroy unposted business records.
 */
export async function discardCurrentOfflineData(options: {
  confirmation: string;
  allowPendingLoss?: boolean;
}): Promise<DiscardResult> {
  if (options.confirmation !== DISCARD_CONFIRMATION) {
    return {
      deleted: false,
      pending: 0,
      message: `Type ${DISCARD_CONFIRMATION} to confirm.`,
    };
  }

  let pending = 0;
  try {
    pending = (await getPendingTransactions()).length;
  } catch {
    pending = 0;
  }

  if (pending > 0 && !options.allowPendingLoss) {
    return {
      deleted: false,
      pending,
      message: `${pending} record${pending === 1 ? " is" : "s are"} still waiting to synchronize. Synchronize first, or explicitly confirm that these records will be lost.`,
    };
  }

  try {
    const scope = await getOfflineScope();
    closeCurrentOfflineSession();
    // Delete only this user's current tenant scope. Other scopes may contain
    // pending records that belong to a different tenant context and must not be
    // destroyed by this action.
    await deleteDatabase(offlineDatabaseName(scope));

    return {
      deleted: true,
      pending,
      message: pending
        ? "Offline data was deleted. The unsynchronized records were also removed."
        : "Offline data was deleted.",
    };
  } catch {
    return {
      deleted: false,
      pending,
      message: "The offline data could not be deleted. Close other tabs and try again.",
    };
  }
}

export interface OfflineStatus {
  summary: OfflineQueueSummary;
  online: boolean;
  databaseName: string | null;
}

/** Snapshot for the offline status panel and the sign-out safeguard. */
export async function getOfflineStatus(): Promise<OfflineStatus> {
  const summary = await getOfflineQueueSummary();
  let databaseName: string | null = null;
  try {
    databaseName = offlineDatabaseName(await getOfflineScope());
  } catch {
    databaseName = null;
  }
  return {
    summary,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    databaseName,
  };
}
