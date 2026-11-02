/**
 * Offline IndexedDB isolation tests.
 *
 * Uses fake-indexeddb to prove that scopes are physically separated and that
 * sign-out deletes the current scope's database.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addTransaction,
  cacheCustomers,
  getCachedCustomers,
  getPendingTransactions,
} from "@/lib/offline/store";
import {
  clearOfflineScope,
  closeCurrentOfflineSession,
  deleteDatabase,
  listOfflineDatabaseNames,
  offlineDatabaseName,
  setOfflineScope,
} from "@/lib/offline/scope";
import {
  DISCARD_CONFIRMATION,
  discardCurrentOfflineData,
  endOfflineSession,
} from "@/lib/offline/session";
import type { OfflineTransaction } from "@/lib/offline/store";

function tx(id: string, userId: string): OfflineTransaction {
  return {
    id,
    deviceId: "device-1",
    tenantId: "tenant-1",
    userId,
    type: "contribution",
    idempotencyKey: id,
    payload: "{}",
    status: "pending_sync",
    retryCount: 0,
    maxRetries: 5,
    failureReason: null,
    serverResult: null,
    localTimestamp: new Date().toISOString(),
    syncStartedAt: null,
    syncedAt: null,
    createdAt: new Date().toISOString(),
  };
}

const customer = {
  accountId: "account-1",
  customerName: "Test Customer",
  customerIdCode: "C-1",
  dailyContribution: 10,
  outstandingDays: 2,
  expectedAmount: 20,
  lastSynced: new Date().toISOString(),
};

describe("offline IndexedDB isolation", () => {
  beforeEach(async () => {
    closeCurrentOfflineSession();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    for (const name of await listOfflineDatabaseNames()) {
      await deleteDatabase(name).catch(() => {});
    }
    clearOfflineScope();
  });

  it("uses a distinct database name per tenant and user", () => {
    const a = offlineDatabaseName({ tenantId: "t1", userId: "u1" });
    const b = offlineDatabaseName({ tenantId: "t1", userId: "u2" });
    const c = offlineDatabaseName({ tenantId: "t2", userId: "u1" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("does not expose one user's cache or queued transactions to another", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-a", "user-a"));
    await cacheCustomers([customer]);

    expect(await getPendingTransactions()).toHaveLength(1);
    expect(await getCachedCustomers()).toHaveLength(1);

    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-b" });

    expect(await getPendingTransactions()).toHaveLength(0);
    expect(await getCachedCustomers()).toHaveLength(0);

    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    expect(await getPendingTransactions()).toHaveLength(1);
  });

  it("preserves pending records when the session ends", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-b", "user-a"));
    expect(await getPendingTransactions()).toHaveLength(1);

    endOfflineSession();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });

    expect(await getPendingTransactions()).toHaveLength(1);
  });

  it("refuses explicit deletion while pending records exist", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-c", "user-a"));

    const refused = await discardCurrentOfflineData({
      confirmation: DISCARD_CONFIRMATION,
    });
    expect(refused.deleted).toBe(false);
    expect(refused.pending).toBe(1);

    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    expect(await getPendingTransactions()).toHaveLength(1);
  });

  it("deletes only when the user types the confirmation and accepts pending loss", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-d", "user-a"));

    const result = await discardCurrentOfflineData({
      confirmation: DISCARD_CONFIRMATION,
      allowPendingLoss: true,
    });
    expect(result.deleted).toBe(true);

    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    expect(await getPendingTransactions()).toHaveLength(0);
  });
});
