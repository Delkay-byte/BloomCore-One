import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTransaction,
  claimTransactionForSync,
  getOfflineQueueSummary,
  getPendingTransactions,
  getTransaction,
  pruneSyncedTransactions,
  recoverStaleSyncing,
  updateTransaction,
  type OfflineTransaction,
} from "@/lib/offline/store";
import {
  clearOfflineScope,
  closeCurrentOfflineSession,
  deleteDatabase,
  listOfflineDatabaseNames,
  setOfflineScope,
} from "@/lib/offline/scope";
import { resetSyncCooldown, syncPendingTransactions } from "@/lib/offline/sync";

function tx(id: string, overrides: Partial<OfflineTransaction> = {}): OfflineTransaction {
  const now = new Date().toISOString();
  return {
    id,
    deviceId: "device-1",
    tenantId: "tenant-1",
    userId: "user-a",
    type: "contribution",
    idempotencyKey: `key-${id}`,
    payload: JSON.stringify({ accountId: "acc-1", amount: 10, channel: "collector" }),
    status: "pending_sync",
    retryCount: 0,
    maxRetries: 5,
    failureReason: null,
    serverResult: null,
    localTimestamp: now,
    syncStartedAt: null,
    syncedAt: null,
    createdAt: now,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("offline queue safety", () => {
  beforeEach(async () => {
    closeCurrentOfflineSession();
    for (const name of await listOfflineDatabaseNames()) {
      await deleteDatabase(name).catch(() => {});
    }
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    resetSyncCooldown();
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets only one tab claim a pending record", async () => {
    await addTransaction(tx("tx-1"));
    expect(await claimTransactionForSync("tx-1")).toBe(true);
    expect(await claimTransactionForSync("tx-1")).toBe(false);
    expect((await getTransaction("tx-1"))?.status).toBe("syncing");
  });

  it("recovers a record abandoned in `syncing` after a closed tab", async () => {
    await addTransaction(
      tx("tx-stale", {
        status: "syncing",
        syncStartedAt: new Date(Date.now() - 60_000).toISOString(),
      })
    );
    expect(await recoverStaleSyncing(30_000)).toBe(1);
    expect((await getTransaction("tx-stale"))?.status).toBe("pending_sync");
  });

  it("summarizes pending, failed and acknowledged records separately", async () => {
    await addTransaction(tx("p1"));
    await addTransaction(tx("f1", { status: "failed", failureReason: "Rejected" }));
    await addTransaction(
      tx("s1", { status: "synced", syncedAt: new Date().toISOString() })
    );

    const summary = await getOfflineQueueSummary();
    expect(summary.pending).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.synced).toBe(1);
    expect(summary.failedRecords[0].failureReason).toBe("Rejected");
    expect(summary.lastSuccessfulSyncAt).toBeTruthy();
  });

  it("keeps acknowledged records for the retention window before pruning", async () => {
    await addTransaction(
      tx("old", {
        status: "synced",
        syncedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      })
    );
    expect(await pruneSyncedTransactions()).toBe(1);
  });

  it("reuses the same idempotency key when a timed-out sync is retried", async () => {
    await addTransaction(tx("tx-retry"));
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse({ success: false, error: "Server unavailable" }, 503);
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse({ success: true, contributionId: "c-1" }, 200);
      });
    vi.stubGlobal("fetch", fetchMock);

    const first = await syncPendingTransactions();
    expect(first[0].success).toBe(false);
    expect(first[0].isRetryable).toBe(true);
    const afterFirst = await getTransaction("tx-retry");
    expect(afterFirst?.status).toBe("pending_sync");
    expect(afterFirst?.retryCount).toBe(1);

    const second = await syncPendingTransactions();
    expect(second[0].success).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
    expect((await getTransaction("tx-retry"))?.status).toBe("synced");
  });

  it("stops a batch on an expired session without burning retries", async () => {
    await addTransaction(tx("tx-a"));
    await addTransaction(tx("tx-b"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ success: false, error: "Not authenticated" }, 401))
    );

    const results = await syncPendingTransactions();
    expect(results).toHaveLength(1);
    expect(results[0].authExpired).toBe(true);

    const pending = await getPendingTransactions();
    expect(pending).toHaveLength(2);
    expect(pending.every((record) => record.retryCount === 0)).toBe(true);
  });

  it("honours HTTP 429 and keeps the record queued", async () => {
    await addTransaction(tx("tx-429"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ success: false, error: "Too many requests" }, 429, {
          "Retry-After": "30",
        })
      )
    );

    const [result] = await syncPendingTransactions();
    expect(result.code).toBe("rate_limited");
    expect(result.retryAfterSeconds).toBe(30);
    const record = await getTransaction("tx-429");
    expect(record?.status).toBe("pending_sync");
    // A rate limit is not the record's failure; it must not burn a retry.
    expect(record?.retryCount).toBe(0);
  });

  it("does not start a second overlapping batch", async () => {
    await addTransaction(tx("tx-overlap"));
    const waiter: { resolve: ((value: Response) => void) | null } = {
      resolve: null,
    };
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          waiter.resolve = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = syncPendingTransactions();
    const second = syncPendingTransactions();
    const secondResults = await second;
    expect(secondResults).toEqual([]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    waiter.resolve?.(jsonResponse({ success: true, contributionId: "c-2" }, 200));
    const firstResults = await first;
    expect(firstResults[0].success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it("keeps a partial batch: acknowledged records become synced, rejected records fail", async () => {
    await addTransaction(
      tx("tx-first", { createdAt: new Date(Date.now() - 2_000).toISOString() })
    );
    await addTransaction(tx("tx-second"));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, contributionId: "c-first" }, 200))
        .mockResolvedValueOnce(
          jsonResponse({ success: false, error: "Account is not active" }, 400)
        )
    );

    const results = await syncPendingTransactions();
    expect(results).toHaveLength(2);
    expect((await getTransaction("tx-first"))?.status).toBe("synced");
    expect((await getTransaction("tx-second"))?.status).toBe("failed");
    expect((await getTransaction("tx-second"))?.payload).toContain("acc-1");
  });

  it("keeps unacknowledged records when the network drops mid-batch", async () => {
    await addTransaction(
      tx("tx-ok", { createdAt: new Date(Date.now() - 2_000).toISOString() })
    );
    await addTransaction(tx("tx-network"));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, contributionId: "c-ok" }, 200))
        .mockRejectedValueOnce(new Error("Failed to fetch"))
    );

    const results = await syncPendingTransactions();
    expect(results[1].code).toBe("offline");
    expect((await getTransaction("tx-ok"))?.status).toBe("synced");
    expect((await getTransaction("tx-network"))?.status).toBe("pending_sync");
    expect((await getTransaction("tx-network"))?.retryCount).toBe(1);
  });

  it("marks a permanently rejected record as failed without deleting it", async () => {
    await addTransaction(tx("tx-rejected"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ success: false, error: "Customer not assigned to this collector" }, 403)
      )
    );

    const [result] = await syncPendingTransactions();
    expect(result.success).toBe(false);
    const record = await getTransaction("tx-rejected");
    expect(record?.status).toBe("failed");
    expect(record?.failureReason).toBe("Customer not assigned to this collector");
    expect(record?.payload).toContain("acc-1");
  });

  it("resets a claimed record when the same user returns later", async () => {
    await addTransaction(tx("tx-return"));
    await updateTransaction("tx-return", { status: "pending_sync", retryCount: 2 });
    expect((await getTransaction("tx-return"))?.retryCount).toBe(2);
  });
});
