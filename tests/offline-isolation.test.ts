/**
 * Offline IndexedDB isolation tests.
 *
 * Uses fake-indexeddb to prove that scopes are physically separated and that
 * sign-out deletes the current scope's database.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTransaction,
  cacheCustomers,
  getCachedCustomers,
  getPendingTransactions,
  updateTransaction,
} from "@/lib/offline/store";
import {
  clearOfflineScope,
  closeCurrentOfflineSession,
  deleteDatabase,
  isDeletionPending,
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
import { createUnlockRecord } from "@/lib/offline/crypto";
import {
  clearCurrentOfflineContext,
  getCurrentOfflineContext,
  savePreparedContext,
} from "@/lib/offline/device-store";
import { lockOfflineWorkspace, unlockOfflineWorkspace } from "@/lib/offline/unlock";

const PASSPHRASE = "tenant isolation passphrase";

async function prepareTenantOneUserA(): Promise<void> {
  const now = new Date().toISOString();
  const { record } = await createUnlockRecord(PASSPHRASE);
  await savePreparedContext({
    tenantId: "tenant-1",
    userId: "user-a",
    userName: "User A",
    role: "collector",
    modules: ["susu"],
    moduleStates: { susu: { deviceId: "device-1", preparedAt: now, lastSyncedAt: now } },
    unlock: record,
    preparedAt: now,
    authorizedAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    lastSyncedAt: now,
    active: false,
    activeModule: null,
  });
  await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
}

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a distinct database name per tenant and user", () => {
    const a = offlineDatabaseName({ tenantId: "t1", userId: "u1" });
    const b = offlineDatabaseName({ tenantId: "t1", userId: "u2" });
    const c = offlineDatabaseName({ tenantId: "t2", userId: "u1" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("does not expose one user's cache or queued transactions to another", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await prepareTenantOneUserA();
    await addTransaction(tx("tx-a", "user-a"));
    await cacheCustomers([customer]);

    expect(await getPendingTransactions()).toHaveLength(1);
    expect(await getCachedCustomers()).toHaveLength(1);

    lockOfflineWorkspace();
    await clearCurrentOfflineContext();
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-b" });

    expect(await getPendingTransactions()).toHaveLength(0);
    expect(await getCachedCustomers()).toHaveLength(0);

    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    expect(await getPendingTransactions()).toHaveLength(1);
    // The cached customer is still encrypted under user A's own database.
    await expect(getCachedCustomers()).rejects.toMatchObject({
      name: "OfflineLockedError",
    });
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

  it("refuses explicit deletion while failed records exist", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-failed", "user-a"));
    await updateTransaction("tx-failed", {
      status: "failed",
      failureReason: "Account not active",
    });

    const refused = await discardCurrentOfflineData({
      confirmation: DISCARD_CONFIRMATION,
    });
    expect(refused.deleted).toBe(false);
    expect(refused.failed).toBe(1);
    expect(refused.unresolved).toBe(1);

    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    expect(await getPendingTransactions()).toHaveLength(0);
    const { getFailedTransactions } = await import("@/lib/offline/store");
    expect(await getFailedTransactions()).toHaveLength(1);
  });

  it("blocks deletion while a record is actively synchronizing, even with acknowledgement", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-syncing", "user-a"));
    await updateTransaction("tx-syncing", {
      status: "syncing",
      syncStartedAt: new Date().toISOString(),
    });

    const refused = await discardCurrentOfflineData({
      confirmation: DISCARD_CONFIRMATION,
      allowPendingLoss: true,
    });
    expect(refused.deleted).toBe(false);
    expect(refused.syncing).toBe(1);
    expect(refused.message).toContain("synchronized");

    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    const { getSyncingTransactions } = await import("@/lib/offline/store");
    expect(await getSyncingTransactions()).toHaveLength(1);
  });

  it("blocks deletion when the queue cannot be read", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-unreadable", "user-a"));

    // No scope and no reachable /api/auth/me: the queue read must fail.
    clearOfflineScope();
    const refused = await discardCurrentOfflineData({
      confirmation: DISCARD_CONFIRMATION,
      allowPendingLoss: true,
    });
    expect(refused.deleted).toBe(false);
    expect(refused.message.toLowerCase()).toContain("could not be read");

    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    expect(await getPendingTransactions()).toHaveLength(1);
  });

  it("reports a blocked IndexedDB deletion as pending, never success", async () => {
    const fakeRequest = {
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
      onblocked: null as null | (() => void),
      error: new Error("blocked"),
    };
    vi.spyOn(indexedDB, "deleteDatabase").mockImplementation(() => {
      queueMicrotask(() => fakeRequest.onblocked?.());
      return fakeRequest as unknown as IDBOpenDBRequest;
    });

    let blocked = false;
    const deletion = deleteDatabase("blocked-db", {
      onBlocked: () => {
        blocked = true;
      },
    });
    let settled = false;
    deletion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(blocked).toBe(true);
    expect(settled).toBe(false);

    // The browser may complete the request after other tabs close.
    fakeRequest.onsuccess?.();
    await deletion;
    expect(isDeletionPending("blocked-db")).toBe(false);
  });

  it("does not report success when deletion is blocked", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    const fakeRequest = {
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
      onblocked: null as null | (() => void),
      error: new Error("blocked"),
    };
    vi.spyOn(indexedDB, "deleteDatabase").mockImplementation(() => {
      queueMicrotask(() => fakeRequest.onblocked?.());
      return fakeRequest as unknown as IDBOpenDBRequest;
    });

    const result = await discardCurrentOfflineData({
      confirmation: DISCARD_CONFIRMATION,
      allowPendingLoss: true,
    });
    expect(result.deleted).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.message.toLowerCase()).toContain("pending");

    fakeRequest.onsuccess?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("deletes only the signed-in user's database and leaves another user untouched", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-a-keep", "user-a"));

    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-b" });
    await addTransaction(tx("tx-b-delete", "user-b"));

    const result = await discardCurrentOfflineData({
      confirmation: DISCARD_CONFIRMATION,
      allowPendingLoss: true,
    });
    expect(result.deleted).toBe(true);

    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    expect(await getPendingTransactions()).toHaveLength(1);

    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-b" });
    expect(await getPendingTransactions()).toHaveLength(0);
  });

  it("sign-out preserves pending, failed and syncing records", async () => {
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    await addTransaction(tx("tx-pending", "user-a"));
    await addTransaction(tx("tx-failed", "user-a"));
    await addTransaction(tx("tx-syncing", "user-a"));
    await updateTransaction("tx-failed", { status: "failed" });
    await updateTransaction("tx-syncing", {
      status: "syncing",
      syncStartedAt: new Date().toISOString(),
    });

    endOfflineSession();

    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
    const { getOfflineQueueSummary } = await import("@/lib/offline/store");
    const summary = await getOfflineQueueSummary();
    expect(summary.pending).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.syncing).toBe(1);
    expect(summary.unresolved).toBe(3);
  });
});
