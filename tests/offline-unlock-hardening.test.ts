import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_PASSPHRASE_LENGTH,
  createUnlockRecord,
  decryptString,
  encryptString,
  unlockWithRecord,
} from "@/lib/offline/crypto";
import {
  clearCurrentOfflineContext,
  getCurrentOfflineContext,
  savePreparedContext,
  type OfflinePreparedContext,
} from "@/lib/offline/device-store";
import {
  OFFLINE_BACKGROUND_LOCK_MS,
  OFFLINE_IDLE_LOCK_MS,
  checkOfflineIdleLock,
  isOfflineUnlocked,
  lockOfflineWorkspace,
  markOfflineActivity,
  markOfflineBackground,
  markOfflineForeground,
  requireOfflineKey,
  unlockOfflineWorkspace,
} from "@/lib/offline/unlock";
import {
  addTransaction,
  cacheCustomers,
  getCachedCustomers,
  getOfflineQueueSummary,
  migrateOfflineRecordsToProtected,
  needsOfflineEncryptionMigration,
  openOfflineDatabase,
  openTransactionPayload,
  type CachedCustomer,
  type OfflineTransaction,
} from "@/lib/offline/store";
import { saveDraft } from "@/lib/offline/drafts";
import {
  clearOfflineScope,
  closeCurrentOfflineSession,
  deleteDatabase,
  listOfflineDatabaseNames,
  setOfflineScope,
} from "@/lib/offline/scope";

const PASSPHRASE = "correct horse battery staple";
const OTHER_PASSPHRASE = "wrong passphrase value";

function context(
  suffix: string,
  overrides: Partial<OfflinePreparedContext> = {}
): OfflinePreparedContext {
  const now = new Date();
  return {
    tenantId: `tenant-${suffix}`,
    userId: `user-${suffix}`,
    userName: "Test Collector",
    role: "collector",
    modules: ["susu"],
    moduleStates: {
      susu: {
        deviceId: `device-${suffix}`,
        preparedAt: now.toISOString(),
        lastSyncedAt: now.toISOString(),
      },
    },
    preparedAt: now.toISOString(),
    authorizedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    lastSyncedAt: now.toISOString(),
    active: false,
    activeModule: null,
    ...overrides,
  };
}

function transaction(id: string, tenantId: string, userId: string): OfflineTransaction {
  return {
    id,
    deviceId: "device-1",
    tenantId,
    userId,
    type: "contribution",
    idempotencyKey: id,
    payload: JSON.stringify({
      accountId: "acct-secret",
      amount: 50,
      customerName: "Secret Customer",
    }),
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

const customer: CachedCustomer = {
  accountId: "acct-secret",
  customerName: "Secret Customer",
  customerIdCode: "C-SECRET",
  dailyContribution: 10,
  outstandingDays: 2,
  expectedAmount: 20,
  lastSynced: new Date().toISOString(),
};

async function rawRecords<T>(storeName: string): Promise<T[]> {
  const db = await openOfflineDatabase();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  lockOfflineWorkspace();
  closeCurrentOfflineSession();
  clearOfflineScope();
  await clearCurrentOfflineContext();
  for (const name of await listOfflineDatabaseNames()) {
    await deleteDatabase(name).catch(() => undefined);
  }
  clearOfflineScope();
});

describe("offline unlock cryptography", () => {
  it("rejects a short passphrase and accepts a strong one", async () => {
    await expect(createUnlockRecord("1234")).rejects.toMatchObject({
      code: "weak_passphrase",
    });
    const record = await createUnlockRecord(PASSPHRASE);
    expect(PASSPHRASE.length).toBeGreaterThanOrEqual(MIN_PASSPHRASE_LENGTH);
    expect(JSON.stringify(record)).not.toContain(PASSPHRASE);
    const key = await unlockWithRecord(PASSPHRASE, record);
    expect(key).toBeTruthy();
  });

  it("rejects a wrong passphrase without changing the verifier", async () => {
    const record = await createUnlockRecord(PASSPHRASE);
    const before = JSON.stringify(record.verifier);
    await expect(unlockWithRecord(OTHER_PASSPHRASE, record)).rejects.toMatchObject({
      code: "invalid_passphrase",
    });
    expect(JSON.stringify(record.verifier)).toBe(before);
  });

  it("uses a unique IV and authenticates ciphertext", async () => {
    const record = await createUnlockRecord(PASSPHRASE);
    const key = await unlockWithRecord(PASSPHRASE, record);
    const a = await encryptString(key, "same value");
    const b = await encryptString(key, "same value");
    expect(a.iv).not.toBe(b.iv);
    expect(await decryptString(key, a)).toBe("same value");
    await expect(
      decryptString(key, { ...a, ct: a.ct.slice(0, -2) })
    ).rejects.toBeTruthy();
  });
});

describe("encrypted offline storage", () => {
  it("stores queues and customers encrypted and reads them only unlocked", async () => {
    const ctx = context(`encrypted-${Date.now()}`);
    const record = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);

    const tx = transaction("tx-secret", ctx.tenantId, ctx.userId);
    await addTransaction(tx);
    await cacheCustomers([customer]);

    const storedTx = await rawRecords<OfflineTransaction>("transactions");
    const storedCustomers = await rawRecords<Record<string, unknown>>("customers");
    expect(storedTx[0].payload).toBe("");
    expect(JSON.stringify(storedTx)).not.toContain("Secret Customer");
    expect(JSON.stringify(storedTx)).not.toContain("50");
    expect(JSON.stringify(storedCustomers)).not.toContain("Secret Customer");
    expect(JSON.stringify(storedCustomers)).not.toContain("C-SECRET");

    const [read] = await (await import("@/lib/offline/store")).getPendingTransactions();
    expect(await openTransactionPayload(read)).toContain("Secret Customer");
    expect((await getCachedCustomers())[0].customerName).toBe("Secret Customer");

    lockOfflineWorkspace();
    await expect(getCachedCustomers()).rejects.toMatchObject({
      name: "OfflineLockedError",
    });
    await expect(openTransactionPayload(read)).rejects.toMatchObject({
      name: "OfflineLockedError",
    });
    // Locking did not touch the queue.
    expect((await getOfflineQueueSummary()).pending).toBe(1);
  });

  it("does not delete records after a wrong unlock attempt", async () => {
    const ctx = context(`wrong-${Date.now()}`);
    const record = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    await addTransaction(transaction("tx-keep", ctx.tenantId, ctx.userId));
    lockOfflineWorkspace();

    await expect(
      unlockOfflineWorkspace((await getCurrentOfflineContext())!, OTHER_PASSPHRASE)
    ).rejects.toBeTruthy();
    expect((await getOfflineQueueSummary()).pending).toBe(1);
    const current = await getCurrentOfflineContext();
    expect(current?.unlockFailures).toBe(1);
  });
});

describe("offline lock lifecycle", () => {
  it("locks after inactivity and after a long background period", async () => {
    const ctx = context(`idle-${Date.now()}`);
    const record = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    expect(isOfflineUnlocked(ctx)).toBe(true);

    markOfflineActivity(1_000);
    expect(checkOfflineIdleLock(1_000 + OFFLINE_IDLE_LOCK_MS + 1)).toBe(true);
    expect(isOfflineUnlocked(ctx)).toBe(false);

    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    markOfflineBackground(2_000);
    expect(
      markOfflineForeground(2_000 + OFFLINE_BACKGROUND_LOCK_MS + 1)
    ).toBe(true);
    expect(isOfflineUnlocked(ctx)).toBe(false);
  });

  it("does not share an unlock key across tenant/user scopes", async () => {
    const a = context(`scope-a-${Date.now()}`);
    const b = context(`scope-b-${Date.now()}`);
    const recordA = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...a, unlock: recordA });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);

    expect(() =>
      requireOfflineKey({ tenantId: b.tenantId, userId: b.userId })
    ).toThrow(/different account/);
    lockOfflineWorkspace();
    expect(() => requireOfflineKey({ tenantId: a.tenantId, userId: a.userId }))
      .toThrow(/locked/);
  });
});

describe("legacy plaintext migration", () => {
  it("preserves failed and syncing statuses through migration", async () => {
    const ctx = context(`status-${Date.now()}`);
    await savePreparedContext(ctx);
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    const failed = transaction("tx-failed", ctx.tenantId, ctx.userId);
    failed.status = "failed";
    failed.failureReason = "Rejected by server";
    failed.retryCount = 3;
    const syncing = transaction("tx-syncing", ctx.tenantId, ctx.userId);
    syncing.status = "syncing";
    syncing.syncStartedAt = new Date().toISOString();
    await addTransaction(failed);
    await addTransaction(syncing);

    const record = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    await migrateOfflineRecordsToProtected();

    const stored = await rawRecords<OfflineTransaction>("transactions");
    const byId = new Map(stored.map((item) => [item.id, item]));
    expect(byId.get("tx-failed")?.status).toBe("failed");
    expect(byId.get("tx-failed")?.retryCount).toBe(3);
    expect(byId.get("tx-syncing")?.status).toBe("syncing");
    expect(byId.get("tx-syncing")?.idempotencyKey).toBe("tx-syncing");
  });

  it("preserves counts, ids and idempotency keys through migration", async () => {
    const ctx = context(`migration-${Date.now()}`);
    await savePreparedContext(ctx);
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    await addTransaction(transaction("tx-migrate", ctx.tenantId, ctx.userId));
    await cacheCustomers([customer]);
    await saveDraft("collector:draft", "collector.contribution", {
      customerName: "Secret Customer",
      amount: 50,
    });
    expect(await needsOfflineEncryptionMigration()).toBe(false); // no unlock yet

    const record = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    expect(await needsOfflineEncryptionMigration()).toBe(true);

    const summary = await migrateOfflineRecordsToProtected();
    expect(summary).toMatchObject({
      migrated: true,
      transactions: 1,
      customers: 1,
      drafts: 1,
    });

    const storedTx = await rawRecords<OfflineTransaction>("transactions");
    expect(storedTx).toHaveLength(1);
    expect(storedTx[0].id).toBe("tx-migrate");
    expect(storedTx[0].idempotencyKey).toBe("tx-migrate");
    expect(storedTx[0].protectedPayload).toBeTruthy();
    expect(JSON.stringify(storedTx)).not.toContain("Secret Customer");
    expect(await rawRecords("transactions_legacy_v2")).toHaveLength(0);
    expect(await rawRecords("customers_legacy_v2")).toHaveLength(0);
    expect(await rawRecords("drafts_legacy_v2")).toHaveLength(0);

    const second = await migrateOfflineRecordsToProtected();
    expect(second.alreadyProtected).toBe(true);
    expect(await rawRecords("transactions")).toHaveLength(1);
  });
});
