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
  isDatabasePresent,
  OfflineScopeError,
  type OfflineScopeFailure,
} from "./scope";
import { activeWorkspaceModule, isOfflineModule } from "./active-module";
import type { ModuleName } from "@/lib/auth";
import { coordinateDatabaseClosure } from "./coordination";
import {
  getOfflineQueueSummary,
  getUnresolvedTransactions,
  pruneSyncedTransactions,
  recoverStaleSyncing,
  type OfflineQueueSummary,
} from "./store";
import { syncPendingTransactions } from "./sync";
import { pruneExpiredDrafts } from "./drafts";
import {
  getOfflineReadiness,
  type OfflineReadiness,
} from "./preparation";
import { clearCurrentOfflineContext } from "./device-store";

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

/**
 * Close connections and forget the in-memory scope. Records stay on disk.
 *
 * The device-level "current offline session" pointer is also cleared so an
 * explicit sign-out cannot be bypassed by reopening the app while offline.
 * Prepared, unsynchronized records remain for the same user after a future
 * online sign-in.
 */
export function endOfflineSession(): void {
  closeCurrentOfflineSession();
  void clearCurrentOfflineContext();
}

export type DiscardStatus =
  | "deleted"
  | "blocked"
  | "uncoordinated"
  | "failed"
  | "refused";

export interface DiscardResult {
  deleted: boolean;
  status: DiscardStatus;
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
      status: "refused",
      ...empty,
      message: `Type ${DISCARD_CONFIRMATION} to confirm.`,
    };
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // Coordination and deletion can still work offline, but a stale tab that
    // cannot answer would leave the delete pending forever. Deletion is not an
    // emergency; ask the user to reconnect so every tab can be told to close.
    return {
      deleted: false,
      status: "refused",
      ...empty,
      message:
        "Connect to the internet before deleting offline data so every open tab can close its database first.",
    };
  }

  let unresolvedRecords;
  try {
    unresolvedRecords = await getUnresolvedTransactions();
  } catch {
    // An unreadable queue may contain financial records. Never guess zero.
    return {
      deleted: false,
      status: "failed",
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
      status: "refused",
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
      status: "refused",
      pending,
      syncing,
      failed,
      unresolved,
      message: `${unresolved} unresolved record${unresolved === 1 ? "" : "s"} (${pending} pending, ${failed} failed) are stored only on this device. Synchronize first, or explicitly confirm that these records will be lost.`,
    };
  }

  let scope;
  try {
    scope = await getOfflineScope();
  } catch {
    return {
      deleted: false,
      status: "failed",
      pending,
      syncing,
      failed,
      unresolved,
      message:
        "The signed-in offline scope could not be confirmed. Deletion was blocked.",
    };
  }

  // Delete only this user's current tenant scope. Other scopes may contain
  // pending records that belong to a different tenant context.
  const databaseName = offlineDatabaseName(scope);

  if (!(await isDatabasePresent(databaseName))) {
    // A previous request completed after it was reported as blocked.
    return {
      deleted: true,
      status: "deleted",
      pending,
      syncing,
      failed,
      unresolved,
      message: "Offline data is no longer present on this device.",
    };
  }

  // Ask every responsive tab to close this database before issuing deletion.
  const coordination = await coordinateDatabaseClosure(databaseName);
  if (!coordination.coordinated) {
    return {
      deleted: false,
      status: "uncoordinated",
      pending,
      syncing,
      failed,
      unresolved,
      message: `${coordination.missing.length} open tab${coordination.missing.length === 1 ? " did" : "s did"} not confirm closure. Deletion was not started. Close other MaaCash tabs, then retry.`,
    };
  }

  closeCurrentOfflineSession();
  void clearCurrentOfflineContext();

  let blocked = false;
  const deletion = deleteDatabase(databaseName, {
    onBlocked: () => {
      blocked = true;
    },
  }).then(
    () => "deleted" as const,
    () => "failed" as const
  );

  // A blocked request stays queued in the browser. Report that pending state
  // quickly instead of pretending it failed or waiting forever.
  const early = await Promise.race([
    deletion,
    (async () => {
      const deadline = Date.now() + 1_200;
      while (Date.now() < deadline) {
        if (blocked) return "blocked" as const;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return "pending" as const;
    })(),
  ]);

  if (early === "deleted") {
    return {
      deleted: true,
      status: "deleted",
      pending,
      syncing,
      failed,
      unresolved,
      message: unresolved
        ? "Offline data was deleted. The unsynchronized records were also removed."
        : "Offline data was deleted.",
    };
  }

  if (early === "failed") {
    return {
      deleted: false,
      status: "failed",
      pending,
      syncing,
      failed,
      unresolved,
      message:
        "The offline data could not be deleted. The browser did not confirm deletion. Close other tabs and retry.",
    };
  }

  return {
    deleted: false,
    status: "blocked",
    pending,
    syncing,
    failed,
    unresolved,
    message:
      "The deletion request is still pending in the browser because another tab or connection holds the database open. It may complete after those tabs close. This page will check again; do not assume success until it confirms.",
  };
}

/** Confirm whether this user's offline database still exists. */
export async function isCurrentOfflineDatabasePresent(): Promise<boolean> {
  try {
    const scope = await getOfflineScope();
    return isDatabasePresent(offlineDatabaseName(scope));
  } catch {
    return true;
  }
}

export interface OfflineStatus {
  summary: OfflineQueueSummary;
  readiness: OfflineReadiness;
  /** False only when the local queue itself could not be read. */
  available: boolean;
  /**
   * Whether the authenticated tenant/user scope was confirmed. Kept separate
   * from `available`: a failed identity check is not an IndexedDB failure, and
   * neither one means records were deleted.
   */
  scope: {
    resolved: boolean;
    module: ModuleName | null;
    error: OfflineScopeFailure | null;
  };
  online: boolean;
  databaseName: string | null;
}

function emptySummary(): OfflineQueueSummary {
  return {
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
    unresolved: 0,
    lastSuccessfulSyncAt: null,
    failedRecords: [],
  };
}

/**
 * Snapshot for the offline status panel and the sign-out safeguard.
 *
 * The panel and the dashboard must use the same module scope. Passing the
 * workspace module prevents a dual-role account from reporting the other
 * module's readiness or resolving a different tab session.
 */
export async function getOfflineStatus(module?: ModuleName): Promise<OfflineStatus> {
  const requestedModule = module ?? activeWorkspaceModule() ?? undefined;
  let scope: Awaited<ReturnType<typeof getOfflineScope>> | null = null;
  let scopeError: OfflineScopeFailure | null = null;
  try {
    scope = await getOfflineScope(requestedModule);
  } catch (error) {
    scopeError =
      error instanceof OfflineScopeError ? error.code : "unavailable";
  }

  const readiness = await getOfflineReadiness(
    isOfflineModule(requestedModule) ? requestedModule : undefined
  );
  let summary: OfflineQueueSummary = emptySummary();
  let available = Boolean(scope);
  if (scope) {
    try {
      summary = await getOfflineQueueSummary();
    } catch {
      // A genuine IndexedDB read failure. Never report it as an empty queue.
      available = false;
    }
  }
  return {
    summary,
    readiness,
    available,
    scope: {
      resolved: Boolean(scope),
      module: requestedModule ?? null,
      error: scopeError,
    },
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    databaseName: scope ? offlineDatabaseName(scope) : null,
  };
}
