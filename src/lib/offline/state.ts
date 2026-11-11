/**
 * Offline presentation state.
 *
 * Connectivity, offline readiness, workspace unlock and the financial queue are
 * separate dimensions. This module combines them into one model so the
 * dashboard and the Offline records panel cannot disagree about what the user
 * is seeing. It is pure: callers pass the measured values, tests pass fixtures.
 *
 * Rules encoded here:
 * - A persisted local activation flag never proves the network is down. Online
 *   plus a prepared device is "available", not "working offline".
 * - Only a server rejection is a user-attention failure. A pending record or a
 *   retryable network error is waiting, not failed.
 * - A queue that cannot be read is never reported as empty or synced.
 */

import type { OfflineReadiness, OfflineReadinessStatus } from "./preparation";
import type {
  OfflineQueueSummary,
  OfflineTransaction,
  TransactionType,
} from "./store";

export type ConnectivityState = "online" | "offline" | "checking" | "unreachable";

export interface QueueSummaryLike {
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
  unresolved: number;
  /** Failed records with a permanent server rejection; requires a decision. */
  attention?: number;
  /** Pending records plus retryable failures waiting for another attempt. */
  waiting?: number;
  lastSuccessfulSyncAt: string | null;
  failedRecords: Array<{
    id: string;
    type: TransactionType;
    failureReason: string | null;
    createdAt: string;
    retryCount: number;
    retryable?: boolean;
  }>;
}

export interface OfflineDisplayStatus {
  connectivity: ConnectivityState;
  /** Human label for connectivity, never implying queue success. */
  connectivityLabel: string;
  /** True only when the device is genuinely offline with an unlocked workspace. */
  workingOffline: boolean;
  readiness: OfflineReadinessStatus;
  readinessLabel: string;
  /** Genuine server rejections that need a user decision. */
  attentionCount: number;
  /** Pending records plus retryable failures waiting for the next attempt. */
  waitingCount: number;
  syncingCount: number;
  syncedCount: number;
  /** Queue was readable. When false, no count may be presented as zero. */
  queueReadable: boolean;
  /** Identifiers are safe to render open only when this is true. */
  canShowQueueDetails: boolean;
  lastSuccessfulSyncAt: string | null;
  nextAction:
    | "none"
    | "setup_passphrase"
    | "prepare"
    | "unlock"
    | "reconnect"
    | "synchronize"
    | "review_rejections";
}

export interface DeriveOfflineStatusInput {
  online: boolean;
  /** Result of a bounded server reachability check; null when not checked. */
  serverReachable: boolean | null | undefined;
  readiness: Pick<OfflineReadiness, "status"> & Partial<OfflineReadiness>;
  queue: QueueSummaryLike | null;
  /** False when the tenant/user scope or the queue could not be read. */
  available: boolean;
  /** True when the offline workspace is currently unlocked. */
  unlocked: boolean;
}

const READINESS_LABEL: Record<OfflineReadinessStatus, string> = {
  preparing: "Preparing offline access",
  ready: "Offline available",
  active: "Working offline",
  preparation_required: "Offline setup required",
  unlock_required: "Offline workspace locked",
  expired: "Offline authorization expired",
  revoked: "Offline authorization revoked",
};

export function readinessLabel(status: OfflineReadinessStatus): string {
  return READINESS_LABEL[status];
}

/**
 * Server failures that are safe to retry automatically. They are not user
 * decisions, so they never raise the attention count.
 */
export function isRetryableRecord(record: {
  status?: string;
  retryable?: boolean;
}): boolean {
  return record.retryable === true || record.status === "pending_sync";
}

/** A record needs the user only when the server rejected it for a real reason. */
export function isActionableFailure(record: {
  status: string;
  retryable?: boolean;
}): boolean {
  return record.status === "failed" && record.retryable !== true;
}

export function summarizeQueueRecords(
  records: OfflineTransaction[]
): OfflineQueueSummary {
  const pending = records.filter((record) => record.status === "pending_sync");
  const syncing = records.filter((record) => record.status === "syncing");
  const synced = records.filter((record) => record.status === "synced");
  const failed = records.filter((record) => record.status === "failed");
  const lastSuccessfulSyncAt =
    synced
      .map((record) => record.syncedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

  return {
    pending: pending.length,
    syncing: syncing.length,
    synced: synced.length,
    failed: failed.length,
    unresolved: pending.length + syncing.length + failed.length,
    attention: failed.filter((record) => record.lastFailureRetryable !== true).length,
    waiting:
      pending.length +
      failed.filter((record) => record.lastFailureRetryable === true).length,
    lastSuccessfulSyncAt,
    failedRecords: failed.slice(0, 20).map((record) => ({
      id: record.id,
      type: record.type,
      failureReason: record.failureReason,
      createdAt: record.createdAt,
      retryCount: record.retryCount,
      retryable: record.lastFailureRetryable === true,
    })),
  };
}

export function countAttention(queue: QueueSummaryLike | null): number {
  if (!queue) return 0;
  if (typeof queue.attention === "number") return queue.attention;
  return queue.failedRecords.filter((record) => record.retryable !== true).length;
}

export function countWaiting(queue: QueueSummaryLike | null): number {
  if (!queue) return 0;
  if (typeof queue.waiting === "number") return queue.waiting;
  return (
    queue.pending +
    queue.failedRecords.filter((record) => record.retryable === true).length
  );
}

export function deriveOfflineDisplayStatus({
  online,
  serverReachable,
  readiness,
  queue,
  available,
  unlocked,
}: DeriveOfflineStatusInput): OfflineDisplayStatus {
  const connectivity: ConnectivityState = !online
    ? "offline"
    : serverReachable === false
      ? "unreachable"
      : serverReachable === null || serverReachable === undefined
        ? "checking"
        : "online";

  const connectivityLabel =
    connectivity === "online"
      ? "Online"
      : connectivity === "offline"
        ? "Offline"
        : connectivity === "unreachable"
          ? "Server unreachable"
          : "Checking connection";

  const queueReadable = available && queue !== null;
  const attentionCount = countAttention(queue);
  const waitingCount = queueReadable ? countWaiting(queue) : 0;

  // "Working offline" requires a real network loss, a prepared workspace and an
  // unlocked local key. A stale activation flag alone is not enough.
  const workingOffline =
    connectivity === "offline" &&
    unlocked &&
    (readiness.status === "active" || readiness.status === "ready");

  let nextAction: OfflineDisplayStatus["nextAction"] = "none";
  if (!queueReadable) {
    nextAction = "none";
  } else if (readiness.status === "expired" || readiness.status === "revoked") {
    nextAction = "reconnect";
  } else if (readiness.status === "unlock_required") {
    nextAction = "unlock";
  } else if (
    readiness.status === "preparation_required" &&
    connectivity === "online" &&
    !unlocked
  ) {
    nextAction = "setup_passphrase";
  } else if (readiness.status === "preparation_required") {
    nextAction = connectivity === "online" ? "prepare" : "reconnect";
  } else if (attentionCount > 0 && connectivity === "online") {
    nextAction = "review_rejections";
  } else if (waitingCount > 0 && connectivity === "online") {
    nextAction = "synchronize";
  }

  return {
    connectivity,
    connectivityLabel,
    workingOffline,
    readiness: readiness.status,
    readinessLabel: READINESS_LABEL[readiness.status],
    attentionCount,
    waitingCount,
    syncingCount: queueReadable ? queue!.syncing : 0,
    syncedCount: queueReadable ? queue!.synced : 0,
    queueReadable,
    canShowQueueDetails: queueReadable && unlocked,
    lastSuccessfulSyncAt: queueReadable ? queue!.lastSuccessfulSyncAt : null,
    nextAction,
  };
}
