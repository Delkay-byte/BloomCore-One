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
  OfflineDeletionBlockedError,
} from "./scope";
import {
  getOfflineQueueSummary,
  getUnresolvedTransactions,
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
  syncing: number;
  failed: number;
  unresolved: number;
  message: string;
}

export const DISCARD_CONFIRMATION = "DELETE OFFLINE DATA";

/**
 * Deliberately destroy the signed-in user's offline database.
 *
 * Fails closed:
 * - an unreadable queue blocks deletion (it is never treated as empty);
 * - a record actively syncing blocks deletion while its outcome is unknown;
 * - pending and failed records require an explicit loss acknowledgement.
 *
 * Requires the exact confirmation phrase.
 */
export async function discardCurrentOfflineData(options: {
  confirmation: string;
  allowPendingLoss?: boolean;
}): Promise<DiscardResult> {
  const empty = { pending: 0, syncing: 0, failed: 0, unresolved: 0 };

  if (options.confirmation !== DISCARD_CONFIRMATION) {
    return {
      deleted: false,
      ...empty,
      message: `Type ${DISCARD_CONFIRMATION} to confirm.`,
    };
  }

  let unresolvedRecords;
  try {
    unresolvedRecords = await getUnresolvedTransactions();
  } catch {
    // An unreadable queue may contain financial records. Never guess zero.
    return {
      deleted: false,
      ...empty,
      message:
        "The offline queue could not be read. Deletion was blocked to avoid losing unsynchronized records. Close other tabs and try again.",
    };
  }

  const pending = unresolvedRecords.filter((record) => record.status === "pending_sync").length;
  const syncing = unresolvedRecords.filter((record) => record.status === "syncing").length;
  const failed = unresolvedRecords.filter((record) => record.status === "failed").length;
  const unresolved = unresolvedRecords.length;

  if (syncing > 0) {
    return {
      deleted: false,
      pending,
      syncing,
      failed,
      unresolved,
      message: `${syncing} record${syncing === 1 ? " is" : "s are"} being synchronized. Wait for the server to answer, then try again. Deletion is blocked while the outcome is unknown.`,
    };
  }

  if (unresolved > 0 && !options.allowPendingLoss) {
    return {
      deleted: false,
      pending,
      syncing,
      failed,
      unresolved,
      message: `${unresolved} unresolved record${unresolved === 1 ? "" : "s"} (${pending} pending, ${failed} failed) are stored only on this device. Synchronize first, or explicitly confirm that these records will be lost.`,
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
      syncing,
      failed,
      unresolved,
      message: unresolved
        ? "Offline data was deleted. The unsynchronized records were also removed."
        : "Offline data was deleted.",
    };
  } catch (error) {
    return {
      deleted: false,
      pending,
      syncing,
      failed,
      unresolved,
      message:
        error instanceof OfflineDeletionBlockedError
          ? "Deletion did not complete because the database is still open in another tab or connection. Close other BloomCore One tabs, then try again."
          : "The offline data could not be deleted. Deletion was not confirmed; close other tabs and try again.",
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
