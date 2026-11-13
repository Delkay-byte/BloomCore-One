import { describe, expect, it } from "vitest";
import {
  classifyStoredFailure,
  countAttention,
  countWaiting,
  deriveOfflineDisplayStatus,
  summarizeQueueRecords,
} from "@/lib/offline/state";
import type { OfflineTransaction } from "@/lib/offline/store";

function record(overrides: Partial<OfflineTransaction>): OfflineTransaction {
  return {
    id: "tx-1",
    deviceId: "device-1",
    tenantId: "tenant-1",
    userId: "user-a",
    type: "contribution",
    idempotencyKey: "key-1",
    payload: "",
    status: "pending_sync",
    retryCount: 0,
    maxRetries: 5,
    failureReason: null,
    serverResult: null,
    localTimestamp: new Date().toISOString(),
    syncStartedAt: null,
    syncedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const ready = { status: "ready" as const };

describe("offline queue attention rules", () => {
  it("reports zero attention when there are no records", () => {
    const summary = summarizeQueueRecords([]);
    expect(summary.attention).toBe(0);
    expect(summary.waiting).toBe(0);
  });

  it("treats a pending record as waiting, not as a manual attention failure", () => {
    const summary = summarizeQueueRecords([record({ status: "pending_sync" })]);
    expect(countAttention(summary)).toBe(0);
    expect(countWaiting(summary)).toBe(1);
  });

  it("does not count a successfully synced record", () => {
    const summary = summarizeQueueRecords([
      record({ status: "synced", syncedAt: new Date().toISOString() }),
    ]);
    expect(countAttention(summary)).toBe(0);
    expect(countWaiting(summary)).toBe(0);
    expect(summary.synced).toBe(1);
  });

  it("counts a genuine server rejection once, with its reason", () => {
    const summary = summarizeQueueRecords([
      record({
        status: "failed",
        failureReason: "Customer is not assigned to this collector",
        lastFailureRetryable: false,
      }),
    ]);
    expect(countAttention(summary)).toBe(1);
    expect(summary.failedRecords[0].failureReason).toMatch(/not assigned/);
  });

  it("does not classify a retryable network failure as permanent", () => {
    const summary = summarizeQueueRecords([
      record({
        status: "failed",
        failureReason: "No connection to MaaCash. This record will retry.",
        lastFailureRetryable: true,
      }),
    ]);
    expect(countAttention(summary)).toBe(0);
    expect(countWaiting(summary)).toBe(1);
  });
});

describe("historical failed record compatibility", () => {
  it("treats an older network failure without the new flag as retryable", () => {
    expect(
      classifyStoredFailure({
        failureReason: "No connection to MaaCash. This record will retry.",
      })
    ).toBe("retryable");
    expect(
      classifyStoredFailure({ failureReason: "Synchronization timed out" })
    ).toBe("retryable");
  });

  it("treats a clear validation reason as a rejection", () => {
    expect(
      classifyStoredFailure({ failureReason: "Customer is not assigned to this collector" })
    ).toBe("rejected");
    expect(classifyStoredFailure({ failureReason: "Invalid amount" })).toBe("rejected");
  });

  it("keeps an inconclusive older failure for explicit review", () => {
    expect(classifyStoredFailure({ failureReason: null })).toBe("unknown");
    expect(classifyStoredFailure({ failureReason: "Unexpected server answer" })).toBe(
      "unknown"
    );
    const summary = summarizeQueueRecords([
      record({ status: "failed", failureReason: null }),
    ]);
    expect(summary.attention).toBe(1);
    expect(summary.review).toBe(1);
    expect(summary.waiting).toBe(0);
  });

  it("does not requeue an unknown historical failure", () => {
    const summary = summarizeQueueRecords([
      record({ status: "failed", failureReason: "Unexpected answer" }),
    ]);
    expect(summary.failedRecords[0].classification).toBe("unknown");
    expect(summary.waiting).toBe(0);
  });

  it("marks a transient failure at its retry ceiling as exhausted review", () => {
    expect(
      classifyStoredFailure({
        lastFailureRetryable: true,
        failureReason: "Synchronization timed out",
        retryCount: 5,
        maxRetries: 5,
      })
    ).toBe("exhausted");
    expect(
      classifyStoredFailure({
        lastFailureRetryable: true,
        failureReason: "Synchronization timed out",
        retryCount: 2,
        maxRetries: 5,
      })
    ).toBe("retryable");
  });
});

describe("offline display status", () => {
  it("shows online availability without claiming offline activity", () => {
    const display = deriveOfflineDisplayStatus({
      online: true,
      serverReachable: true,
      readiness: { ...ready, status: "active" },
      queue: summarizeQueueRecords([]),
      available: true,
      unlocked: true,
    });
    expect(display.connectivity).toBe("online");
    expect(display.workingOffline).toBe(false);
    expect(display.readinessLabel).toBe("Working offline");
  });

  it("shows working offline only when the network is actually down", () => {
    const display = deriveOfflineDisplayStatus({
      online: false,
      serverReachable: null,
      readiness: { ...ready, status: "active" },
      queue: summarizeQueueRecords([]),
      available: true,
      unlocked: true,
    });
    expect(display.connectivity).toBe("offline");
    expect(display.workingOffline).toBe(true);
  });

  it("shows synchronization after reconnection, not offline activity", () => {
    const display = deriveOfflineDisplayStatus({
      online: true,
      serverReachable: true,
      readiness: ready,
      queue: summarizeQueueRecords([record({ status: "pending_sync" })]),
      available: true,
      unlocked: true,
    });
    expect(display.waitingCount).toBe(1);
    expect(display.nextAction).toBe("synchronize");
  });

  it("never reports an unreadable queue as synced or empty", () => {
    const display = deriveOfflineDisplayStatus({
      online: true,
      serverReachable: true,
      readiness: ready,
      queue: null,
      available: false,
      unlocked: false,
    });
    expect(display.queueReadable).toBe(false);
    expect(display.attentionCount).toBe(0);
    expect(display.waitingCount).toBe(0);
    expect(display.syncedCount).toBe(0);
    expect(display.nextAction).toBe("none");
    expect(display.canShowQueueDetails).toBe(false);
  });

  it("does not expose a stale attention count when the queue is unavailable", () => {
    const staleQueue = summarizeQueueRecords([
      record({
        status: "failed",
        failureReason: "Customer is not assigned to this collector",
        lastFailureRetryable: false,
      }),
    ]);
    const display = deriveOfflineDisplayStatus({
      online: true,
      serverReachable: true,
      readiness: ready,
      queue: staleQueue,
      available: false,
      unlocked: true,
    });
    expect(display.queueReadable).toBe(false);
    expect(display.queueUnavailable).toBe(true);
    expect(display.attentionCount).toBe(0);
    expect(display.canShowQueueDetails).toBe(false);
  });

  it("restores the accurate count when the queue becomes readable again", () => {
    const readableQueue = summarizeQueueRecords([
      record({
        status: "failed",
        failureReason: "Customer is not assigned to this collector",
        lastFailureRetryable: false,
      }),
    ]);
    const display = deriveOfflineDisplayStatus({
      online: true,
      serverReachable: true,
      readiness: ready,
      queue: readableQueue,
      available: true,
      unlocked: true,
    });
    expect(display.queueReadable).toBe(true);
    expect(display.attentionCount).toBe(1);
    expect(display.canShowQueueDetails).toBe(true);
  });

  it("hides queue details while locked", () => {
    const display = deriveOfflineDisplayStatus({
      online: false,
      serverReachable: null,
      readiness: { ...ready, status: "unlock_required" },
      queue: summarizeQueueRecords([
        record({ status: "failed", failureReason: "Rejected", lastFailureRetryable: false }),
      ]),
      available: true,
      unlocked: false,
    });
    expect(display.canShowQueueDetails).toBe(false);
    expect(display.nextAction).toBe("unlock");
  });

  it("distinguishes an unreachable backend from a browser online event", () => {
    const display = deriveOfflineDisplayStatus({
      online: true,
      serverReachable: false,
      readiness: ready,
      queue: summarizeQueueRecords([]),
      available: true,
      unlocked: true,
    });
    expect(display.connectivity).toBe("unreachable");
    expect(display.connectivityLabel).toBe("Server unreachable");
    expect(display.nextAction).toBe("none");
  });
});
