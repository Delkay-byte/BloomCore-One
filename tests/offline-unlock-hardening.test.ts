import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_PASSPHRASE_LENGTH,
  createUnlockRecord,
  decryptString,
  encryptString,
  unlockWithRecord,
  unlockWithRecoveryCode,
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
  setupOfflineUnlock,
  unlockOfflineWorkspace,
} from "@/lib/offline/unlock";
import {
  CUSTOMER_STORE,
  LEGACY_CUSTOMER_STORE,
  addTransaction,
  cacheCustomers,
  getCachedCustomers,
  getOfflineQueueSummary,
  getTransaction,
  migrateOfflineRecordsToProtected,
  needsOfflineEncryptionMigration,
  openOfflineDatabase,
  openTransactionPayload,
  type CachedCustomer,
  type OfflineTransaction,
} from "@/lib/offline/store";
import { syncPendingTransactions } from "@/lib/offline/sync";
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
    const { record } = await createUnlockRecord(PASSPHRASE);
    expect(PASSPHRASE.length).toBeGreaterThanOrEqual(MIN_PASSPHRASE_LENGTH);
    expect(JSON.stringify(record)).not.toContain(PASSPHRASE);
    const key = await unlockWithRecord(PASSPHRASE, record);
    expect(key).toBeTruthy();
  });

  it("rejects a wrong passphrase without changing the verifier", async () => {
    const { record } = await createUnlockRecord(PASSPHRASE);
    const before = JSON.stringify(record.verifier);
    await expect(unlockWithRecord(OTHER_PASSPHRASE, record)).rejects.toMatchObject({
      code: "invalid_passphrase",
    });
    expect(JSON.stringify(record.verifier)).toBe(before);
  });

  it("unlocks with the one-time recovery code and rejects a wrong one", async () => {
    const { record, recoveryCode } = await createUnlockRecord(PASSPHRASE);
    expect(recoveryCode).toMatch(/^MAA-/);
    const key = await unlockWithRecoveryCode(recoveryCode, record);
    expect(await decryptString(key, record.verifier)).toBe(
      "maacash-offline-unlock:v1"
    );
    await expect(
      unlockWithRecoveryCode("MAA-WRONG-WRONG-WRONG-WRONG", record)
    ).rejects.toMatchObject({ code: "invalid_passphrase" });
  });

  it("uses a unique IV and authenticates ciphertext", async () => {
    const { record } = await createUnlockRecord(PASSPHRASE);
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
    const { record } = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);

    const tx = transaction("tx-secret", ctx.tenantId, ctx.userId);
    await addTransaction(tx);
    await cacheCustomers([customer]);

    const storedTx = await rawRecords<OfflineTransaction>("transactions");
    const storedCustomers = await rawRecords<Record<string, unknown>>(CUSTOMER_STORE);
    expect(storedTx[0].payload).toBe("");
    expect(JSON.stringify(storedTx)).not.toContain("Secret Customer");
    expect(JSON.stringify(storedTx)).not.toContain("acct-secret");
    expect(JSON.stringify(storedCustomers)).not.toContain("Secret Customer");
    expect(JSON.stringify(storedCustomers)).not.toContain("C-SECRET");
    // The account number is not an object key or index value any more.
    expect(JSON.stringify(storedCustomers)).not.toContain("acct-secret");
    expect(storedCustomers[0].id).not.toBe("acct-secret");

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

  it("does not serve legacy plaintext records while a configured workspace is locked", async () => {
    const ctx = context(`legacy-locked-${Date.now()}`);
    await savePreparedContext(ctx);
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    await addTransaction(transaction("tx-legacy", ctx.tenantId, ctx.userId));
    const [legacy] = await (
      await import("@/lib/offline/store")
    ).getPendingTransactions();

    const { record } = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    lockOfflineWorkspace();

    await expect(openTransactionPayload(legacy)).rejects.toMatchObject({
      name: "OfflineLockedError",
    });
  });

  it("does not burn queue retries while the workspace is locked", async () => {
    const ctx = context(`locked-sync-${Date.now()}`);
    const { record } = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    await addTransaction(transaction("tx-locked", ctx.tenantId, ctx.userId));
    lockOfflineWorkspace();

    const results = await syncPendingTransactions();
    expect(results[0]?.error).toMatch(/locked/i);
    const stored = await getTransaction("tx-locked");
    expect(stored?.status).toBe("pending_sync");
    expect(stored?.retryCount).toBe(0);
  });

  it("persists progressive cooldown after repeated wrong attempts", async () => {
    const ctx = context(`cooldown-${Date.now()}`);
    const { record } = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    lockOfflineWorkspace();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        unlockOfflineWorkspace(
          (await getCurrentOfflineContext())!,
          OTHER_PASSPHRASE
        )
      ).rejects.toBeTruthy();
    }
    const current = await getCurrentOfflineContext();
    expect(current?.unlockFailures).toBe(3);
    expect(current?.unlockBlockedUntil).toBeTruthy();
    await expect(
      unlockOfflineWorkspace(current!, PASSPHRASE)
    ).rejects.toMatchObject({ code: "invalid_passphrase" });
  });

  it("does not delete records after a wrong unlock attempt", async () => {
    const ctx = context(`wrong-${Date.now()}`);
    const { record } = await createUnlockRecord(PASSPHRASE);
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
    const { record } = await createUnlockRecord(PASSPHRASE);
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

  it("refuses to overwrite an existing unlock record", async () => {
    const ctx = context(`overwrite-${Date.now()}`);
    await savePreparedContext(ctx);
    await setupOfflineUnlock(ctx, PASSPHRASE);
    const currentBefore = await getCurrentOfflineContext();
    lockOfflineWorkspace();
    await expect(
      setupOfflineUnlock(ctx, OTHER_PASSPHRASE)
    ).rejects.toMatchObject({ code: "unsupported" });
    const current = await getCurrentOfflineContext();
    expect(current?.unlock?.salt).toBe(currentBefore?.unlock?.salt);
  });

  it("does not share an unlock key across tenant/user scopes", async () => {
    const a = context(`scope-a-${Date.now()}`);
    const b = context(`scope-b-${Date.now()}`);
    const { record: recordA } = await createUnlockRecord(PASSPHRASE);
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

    const { record } = await createUnlockRecord(PASSPHRASE);
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
    // Simulate a pre-hardening plaintext draft record. New online drafts are
    // session-only and never reach IndexedDB.
    const legacyDb = await openOfflineDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({
        id: "collector:draft",
        draftKey: "collector:draft",
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        workflow: "collector.contribution",
        schemaVersion: 2,
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        data: { customerName: "Secret Customer", amount: 50 },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacyDb.close();
    expect(await needsOfflineEncryptionMigration()).toBe(false); // no unlock yet

    const { record } = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    await cacheCustomers([customer]);
    expect(await needsOfflineEncryptionMigration()).toBe(true);

    const summary = await migrateOfflineRecordsToProtected();
    expect(summary).toMatchObject({
      migrated: true,
      transactions: 1,
      customers: 0,
      drafts: 1,
    });

    const storedTx = await rawRecords<OfflineTransaction>("transactions");
    expect(storedTx).toHaveLength(1);
    expect(storedTx[0].id).toBe("tx-migrate");
    expect(storedTx[0].idempotencyKey).toBe("tx-migrate");
    expect(storedTx[0].protectedPayload).toBeTruthy();
    expect(JSON.stringify(storedTx)).not.toContain("Secret Customer");
    const storedCustomers = await rawRecords<Record<string, unknown>>(CUSTOMER_STORE);
    expect(JSON.stringify(storedCustomers)).not.toContain("acct-secret");
    expect(JSON.stringify(storedCustomers)).not.toContain("Secret Customer");
    expect(await rawRecords("transactions_legacy_v2")).toHaveLength(0);
    expect(await rawRecords("drafts_legacy_v2")).toHaveLength(0);

    const second = await migrateOfflineRecordsToProtected();
    expect(second.alreadyProtected).toBe(true);
    expect(await rawRecords("transactions")).toHaveLength(1);
  });

  it("moves a v3 plaintext customer cache to opaque encrypted keys without data loss", async () => {
    const ctx = context(`legacy-customers-${Date.now()}`);
    setOfflineScope({ tenantId: ctx.tenantId, userId: ctx.userId });
    const scope = { tenantId: ctx.tenantId, userId: ctx.userId };
    const databaseName = (await import("@/lib/offline/scope")).offlineDatabaseName(scope);

    // Recreate the v3 shape: the account number was the object-store key.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("transactions", { keyPath: "id" });
        const customers = db.createObjectStore(LEGACY_CUSTOMER_STORE, {
          keyPath: "accountId",
        });
        customers.createIndex("lastSynced", "lastSynced", { unique: false });
        db.createObjectStore("drafts", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(LEGACY_CUSTOMER_STORE, "readwrite");
        tx.objectStore(LEGACY_CUSTOMER_STORE).put({
          ...customer,
          accountId: "acct-secret",
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const { record } = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...ctx, unlock: record });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);

    const summary = await migrateOfflineRecordsToProtected();
    expect(summary.customers).toBe(1);

    const raw = await rawRecords<Record<string, unknown>>(CUSTOMER_STORE);
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain("acct-secret");
    expect(JSON.stringify(raw)).not.toContain("Secret Customer");
    expect(raw[0].id).toBeTypeOf("string");
    expect(raw[0].id).not.toBe("acct-secret");
    expect(await rawRecords(LEGACY_CUSTOMER_STORE)).toHaveLength(0);

    const [restored] = await getCachedCustomers();
    expect(restored.accountId).toBe("acct-secret");
    expect(restored.customerName).toBe("Secret Customer");

    lockOfflineWorkspace();
    await expect(getCachedCustomers()).rejects.toMatchObject({
      name: "OfflineLockedError",
    });
  });
});
