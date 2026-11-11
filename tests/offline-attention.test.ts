import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addTransaction,
  getOfflineQueueSummary,
  getTransaction,
  requeueRetryableFailures,
  type OfflineTransaction,
} from "@/lib/offline/store";
import {
  clearOfflineScope,
  closeCurrentOfflineSession,
  deleteDatabase,
  listOfflineDatabaseNames,
  setOfflineScope,
} from "@/lib/offline/scope";

function tx(id: string, overrides: Partial<OfflineTransaction> = {}): OfflineTransaction {
  return {
    id,
    deviceId: "device-1",
    tenantId: "tenant-1",
    userId: "user-a",
    type: "contribution",
    idempotencyKey: id,
    payload: JSON.stringify({ accountId: `acct-${id}`, amount: 10 }),
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

describe("authoritative attention count", () => {
  beforeEach(async () => {
    closeCurrentOfflineSession();
    for (const name of await listOfflineDatabaseNames()) {
      await deleteDatabase(name).catch(() => undefined);
    }
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
  });

  it("counts only genuine rejections and requeues retryable failures", async () => {
    await addTransaction(tx("pending"));
    await addTransaction(
      tx("synced", { status: "synced", syncedAt: new Date().toISOString() })
    );
    await addTransaction(
      tx("rejected", {
        status: "failed",
        failureReason: "Customer is not assigned to this collector",
        lastFailureRetryable: false,
      })
    );
    await addTransaction(
      tx("network", {
        status: "failed",
        failureReason: "No connection to MaaCash. This record will retry.",
        lastFailureRetryable: true,
      })
    );

    const summary = await getOfflineQueueSummary();
    expect(summary.attention).toBe(1);
    expect(summary.waiting).toBe(2);
    expect(summary.synced).toBe(1);
    expect(summary.failedRecords.find((item) => item.id === "rejected")?.retryable).toBe(
      false
    );

    expect(await requeueRetryableFailures()).toBe(1);
    expect((await getTransaction("network"))?.status).toBe("pending_sync");
    expect((await getTransaction("rejected"))?.status).toBe("failed");

    const after = await getOfflineQueueSummary();
    expect(after.attention).toBe(1);
    expect(after.waiting).toBe(2);
  });

  it("keeps counts scoped to the signed-in user", async () => {
    await addTransaction(tx("user-a-record", { userId: "user-a" }));
    const summaryA = await getOfflineQueueSummary();
    expect(summaryA.pending).toBe(1);

    closeCurrentOfflineSession();
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-b" });
    const summaryB = await getOfflineQueueSummary();
    expect(summaryB.pending).toBe(0);
    expect(summaryB.attention).toBe(0);
  });
});
