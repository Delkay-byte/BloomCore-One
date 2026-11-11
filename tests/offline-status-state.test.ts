import { describe, expect, it } from "vitest";
import {
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
