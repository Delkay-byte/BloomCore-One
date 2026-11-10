/**
 * IndexedDB-backed offline transaction store.
 *
 * Each transaction has a unique idempotency key and tracks sync status. The
 * database is scoped per tenant/user, but it is ordinary browser storage: it is
 * not encrypted and not protected against someone who controls the device. The
 * UI never claims otherwise.
 *
 * This is NOT localStorage — IndexedDB provides structured storage, larger
 * capacity, and better suitability for financial data queues.
 */

import {
  getOfflineScope,
  offlineDatabaseName,
  purgeLegacyOfflineDatabase,
  registerOfflineConnection,
} from "./scope";
import {
  getCurrentOfflineContext,
  type OfflinePreparedContext,
} from "./device-store";
import {
  OfflineCryptoError,
  protectValue,
  unprotectValue,
  type ProtectedPayload,
} from "./crypto";
import { OfflineLockedError, requireOfflineKey } from "./unlock";
import { OfflineStorageError } from "@/lib/errors/friendly";
// Register the cross-tab coordination handler wherever offline storage is used.
import "./coordination";

/**
 * Bump this when a new object store or index is added. Every opener in the
 * offline layer uses the same version: opening the same database with a lower
 * version throws `VersionError` and would strand queued records.
 */
export const OFFLINE_DB_VERSION = 3;

export const LEGACY_BACKUP_STORES = {
  transactions: "transactions_legacy_v2",
  customers: "customers_legacy_v2",
  drafts: "drafts_legacy_v2",
} as const;

// ── Types ──────────────────────────────────────────────────────────────

export type TransactionType = "contribution" | "daily_account_draft";
export type SyncStatus = "pending_sync" | "syncing" | "synced" | "failed";

export interface OfflineTransaction {
  id: string;
  deviceId: string;
  tenantId?: string;
  userId: string;
  type: TransactionType;
  idempotencyKey: string;
  payload: string; // JSON payload of the queued transaction (plaintext only while unprotected)
  /**
   * Populated when the device has an offline unlock credential. The plaintext
   * `payload` is then empty and all sensitive content lives in this envelope.
   */
  protectedPayload?: ProtectedPayload;
  protectionVersion?: 1;
  status: SyncStatus;
  retryCount: number;
  maxRetries: number;
  failureReason: string | null;
  serverResult: string | null;
  localTimestamp: string; // ISO
  syncStartedAt: string | null;
  syncedAt: string | null;
  createdAt: string;
}

export interface CachedCustomer {
  accountId: string;
  customerName: string;
  customerIdCode: string;
  dailyContribution: number;
  outstandingDays: number;
  expectedAmount: number;
  lastSynced: string;
}

interface StoredCustomer {
  accountId: string;
  protectionVersion?: 1;
  protectedData?: ProtectedPayload;
  customerName?: string;
  customerIdCode?: string;
  dailyContribution?: number;
  outstandingDays?: number;
  expectedAmount?: number;
  lastSynced?: string;
}

// ── Encryption ─────────────────────────────────────────────────────────

const cryptoKeys = new Map<string, CryptoKey>();

/**
 * Derive an AES-GCM key from a passphrase using PBKDF2.
 * The passphrase is derived from the user's session data.
 */
async function getOrCreateKey(passphrase: string): Promise<CryptoKey> {
  const cached = cryptoKeys.get(passphrase);
  if (cached) return cached;

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const derived = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("bik-prestige-offline-salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  cryptoKeys.set(passphrase, derived);
  return derived;
}

export async function encryptData(data: string, passphrase: string): Promise<string> {
  const key = await getOrCreateKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  // Combine IV + ciphertext, base64-encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptData(encryptedBase64: string, passphrase: string): Promise<string> {
  const key = await getOrCreateKey(passphrase);
  const combined = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// ── IndexedDB Operations ───────────────────────────────────────────────

export async function openOfflineDatabase(): Promise<IDBDatabase> {
  await purgeLegacyOfflineDatabase();
  const scope = await getOfflineScope();
  const name = offlineDatabaseName(scope);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("transactions")) {
        const store = db.createObjectStore("transactions", { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("type", "type", { unique: false });
        store.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("userId", "userId", { unique: false });
        store.createIndex("tenantId", "tenantId", { unique: false });
      }
      if (!db.objectStoreNames.contains("customers")) {
        const store = db.createObjectStore("customers", { keyPath: "accountId" });
        store.createIndex("lastSynced", "lastSynced", { unique: false });
      }
      // Drafts (and the device id in `meta`) share the scoped database so a
      // second account can never open the first account's unfinished work.
      if (!db.objectStoreNames.contains("drafts")) {
        const store = db.createObjectStore("drafts", { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("workflow", "workflow", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      // Plaintext backups for interrupted encryption migration. These exist
      // only while a migration is incomplete; the migration deletes them after
      // verification. They are never used as the live queue.
      if (!db.objectStoreNames.contains(LEGACY_BACKUP_STORES.transactions)) {
        db.createObjectStore(LEGACY_BACKUP_STORES.transactions, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LEGACY_BACKUP_STORES.customers)) {
        db.createObjectStore(LEGACY_BACKUP_STORES.customers, {
          keyPath: "accountId",
        });
      }
      if (!db.objectStoreNames.contains(LEGACY_BACKUP_STORES.drafts)) {
        db.createObjectStore(LEGACY_BACKUP_STORES.drafts, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      registerOfflineConnection(db, name);
      resolve(db);
    };
    request.onblocked = () =>
      reject(
        new OfflineStorageError(
          "storage_unavailable",
          "Another MaaCash tab is holding an older offline database open. Close other tabs and retry."
        )
      );
    request.onerror = () => reject(toStorageError(request.error));
  });
}

function toStorageError(error: unknown): OfflineStorageError {
  if (error instanceof OfflineStorageError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new OfflineStorageError("storage_full");
  }
  return new OfflineStorageError("write_failed");
}

async function withStore<T>(
  mode: IDBTransactionMode,
  storeName: string,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openOfflineDatabase();
  return new Promise<T>((resolve, reject) => {
    let request: IDBRequest<T>;
    try {
      request = run(db.transaction(storeName, mode).objectStore(storeName));
    } catch (error) {
      reject(toStorageError(error));
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toStorageError(request.error));
  });
}

// ── Protected field helpers ────────────────────────────────────────────

async function protectionContext(): Promise<OfflinePreparedContext | null> {
  const context = await getCurrentOfflineContext();
  return context?.unlock ? context : null;
}

async function requireMatchingProtectionScope(): Promise<OfflinePreparedContext | null> {
  const context = await protectionContext();
  if (!context) return null;
  const scope = await getOfflineScope();
  if (
    context.tenantId !== scope.tenantId ||
    context.userId !== scope.userId
  ) {
    throw new OfflineLockedError(
      "The offline unlock belongs to a different account than this database."
    );
  }
  return context;
}

export async function isOfflineProtectionActive(): Promise<boolean> {
  return Boolean(await protectionContext());
}

async function protectTransactionPayload(
  transaction: OfflineTransaction
): Promise<OfflineTransaction> {
  const context = await requireMatchingProtectionScope();
  if (!context) return transaction;
  if (
    transaction.tenantId &&
    (transaction.tenantId !== context.tenantId ||
      transaction.userId !== context.userId)
  ) {
    throw new OfflineLockedError(
      "This transaction belongs to a different offline account."
    );
  }
  if (transaction.protectionVersion === 1 && transaction.protectedPayload) {
    return transaction;
  }
  const key = requireOfflineKey(context);
  const protectedPayload = await protectValue(key, transaction.payload);
  return {
    ...transaction,
    payload: "",
    protectedPayload,
    protectionVersion: 1,
  };
}

/** Decrypt a queued payload only after the workspace is unlocked. */
export async function openTransactionPayload(
  transaction: OfflineTransaction
): Promise<string> {
  const current = await getCurrentOfflineContext();
  if (current?.unlock && !requireOfflineKeySafe(current)) {
    throw new OfflineLockedError();
  }
  if (!transaction.protectedPayload) {
    if (transaction.payload) return transaction.payload;
    throw new OfflineCryptoError(
      "corrupt_data",
      "This saved transaction has no readable payload. It was not deleted."
    );
  }
  if (!current?.unlock) {
    throw new OfflineLockedError();
  }
  const key = requireOfflineKey(current);
  return unprotectValue<string>(key, transaction.protectedPayload);
}

function requireOfflineKeySafe(context: OfflinePreparedContext): boolean {
  try {
    requireOfflineKey(context);
    return true;
  } catch {
    return false;
  }
}

// ── Transaction Operations ─────────────────────────────────────────────

export async function addTransaction(tx: OfflineTransaction): Promise<void> {
  const protectedTransaction = await protectTransactionPayload(tx);
  await withStore("readwrite", "transactions", (store) =>
    store.add(protectedTransaction)
  );
}

export async function getTransaction(id: string): Promise<OfflineTransaction | undefined> {
  return withStore<OfflineTransaction | undefined>(
    "readonly",
    "transactions",
    (store) => store.get(id)
  );
}

export async function updateTransaction(id: string, updates: Partial<OfflineTransaction>): Promise<void> {
  const existing = await getTransaction(id);
  if (!existing) return;
  const updated = { ...existing, ...updates };
  await withStore("readwrite", "transactions", (store) => store.put(updated));
}

/**
 * Atomically claim a pending transaction for this tab.
 *
 * Two tabs (or two sync loops) can read the same pending list at the same
 * time. Only the caller that flips `pending_sync → syncing` inside one
 * read-write IndexedDB transaction may submit it. The server idempotency key
 * remains the final guard; this prevents needless duplicate requests.
 */
export async function claimTransactionForSync(id: string): Promise<boolean> {
  try {
    const db = await openOfflineDatabase();
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction("transactions", "readwrite");
      const store = tx.objectStore("transactions");
      const request = store.get(id);
      let claimed = false;

      request.onsuccess = () => {
        const existing = request.result as OfflineTransaction | undefined;
        if (!existing || existing.status !== "pending_sync") {
          claimed = false;
          return;
        }
        claimed = true;
        store.put({
          ...existing,
          status: "syncing",
          syncStartedAt: new Date().toISOString(),
        });
      };
      request.onerror = () => reject(toStorageError(request.error));
      tx.oncomplete = () => resolve(claimed);
      tx.onerror = () => reject(toStorageError(tx.error));
      tx.onabort = () => reject(toStorageError(tx.error));
    });
  } catch {
    return false;
  }
}

export async function getPendingTransactions(): Promise<OfflineTransaction[]> {
  const results = await withStore<OfflineTransaction[]>(
    "readonly",
    "transactions",
    (store) => store.index("status").getAll("pending_sync")
  );
  return results.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export async function getSyncingTransactions(): Promise<OfflineTransaction[]> {
  return withStore<OfflineTransaction[]>("readonly", "transactions", (store) =>
    store.index("status").getAll("syncing")
  );
}

export async function getSyncedTransactions(): Promise<OfflineTransaction[]> {
  return withStore<OfflineTransaction[]>("readonly", "transactions", (store) =>
    store.index("status").getAll("synced")
  );
}

export async function getFailedTransactions(): Promise<OfflineTransaction[]> {
  return withStore<OfflineTransaction[]>("readonly", "transactions", (store) =>
    store.index("status").getAll("failed")
  );
}

export async function getAllTransactions(): Promise<OfflineTransaction[]> {
  const all = await withStore<OfflineTransaction[]>("readonly", "transactions", (store) =>
    store.getAll()
  );
  return all.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * A tab can close in the middle of a sync. A record left in `syncing` would
 * otherwise never be retried. Reset only stale claims: a live tab keeps its
 * claim while the request is in flight.
 */
export async function recoverStaleSyncing(
  staleAfterMs = 5 * 60 * 1000
): Promise<number> {
  const syncing = await getSyncingTransactions();
  const cutoff = Date.now() - staleAfterMs;
  let recovered = 0;
  for (const tx of syncing) {
    const started = tx.syncStartedAt ? new Date(tx.syncStartedAt).getTime() : 0;
    if (!started || started < cutoff) {
      await updateTransaction(tx.id, {
        status: "pending_sync",
        syncStartedAt: null,
      });
      recovered += 1;
    }
  }
  return recovered;
}

/**
 * Retention policy for acknowledged records: keep a short local audit trail,
 * then remove only records the server has already confirmed. Pending and
 * failed records are never touched.
 */
export async function pruneSyncedTransactions(
  retentionMs = 7 * 24 * 60 * 60 * 1000
): Promise<number> {
  const synced = await getSyncedTransactions();
  const cutoff = Date.now() - retentionMs;
  let removed = 0;
  for (const tx of synced) {
    const syncedAt = tx.syncedAt ? new Date(tx.syncedAt).getTime() : 0;
    if (syncedAt && syncedAt < cutoff) {
      await withStore("readwrite", "transactions", (store) => store.delete(tx.id));
      removed += 1;
    }
  }
  return removed;
}

// ── Customer Cache ─────────────────────────────────────────────────────

export async function cacheCustomers(customers: CachedCustomer[]): Promise<void> {
  const context = await requireMatchingProtectionScope();
  let stored: StoredCustomer[];
  if (context) {
    const key = requireOfflineKey(context);
    stored = await Promise.all(
      customers.map(async (customer) => ({
        accountId: customer.accountId,
        protectionVersion: 1 as const,
        protectedData: await protectValue(key, customer),
      }))
    );
  } else {
    stored = customers;
  }

  const db = await openOfflineDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("customers", "readwrite");
    const store = tx.objectStore("customers");
    store.clear();
    for (const c of stored) {
      store.add(c);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(toStorageError(tx.error));
    tx.onabort = () => reject(toStorageError(tx.error));
  });
}

export async function getCachedCustomers(): Promise<CachedCustomer[]> {
  const stored = await withStore<StoredCustomer[]>("readonly", "customers", (store) =>
    store.getAll()
  );
  const context = await requireMatchingProtectionScope();
  if (!context) {
    if (stored.some((customer) => customer.protectedData)) {
      throw new OfflineLockedError();
    }
    return stored as CachedCustomer[];
  }
  const key = requireOfflineKey(context);
  return Promise.all(
    stored.map(async (customer) => {
      if (!customer.protectedData) return customer as CachedCustomer;
      return unprotectValue<CachedCustomer>(key, customer.protectedData);
    })
  );
}

// ── Legacy plaintext migration ─────────────────────────────────────────

const MIGRATION_META_KEY = "offline-encryption-migration";

export interface OfflineMigrationSummary {
  migrated: boolean;
  transactions: number;
  customers: number;
  drafts: number;
  alreadyProtected: boolean;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toStorageError(request.error));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(toStorageError(tx.error));
    tx.onabort = () => reject(toStorageError(tx.error));
  });
}

async function readStore<T>(db: IDBDatabase, name: string): Promise<T[]> {
  const tx = db.transaction(name, "readonly");
  return requestToPromise(tx.objectStore(name).getAll()) as Promise<T[]>;
}

async function writeProtectedRecords(
  db: IDBDatabase,
  stores: {
    transactions: OfflineTransaction[];
    customers: StoredCustomer[];
    drafts: Array<Record<string, unknown>>;
  }
): Promise<void> {
  const names = ["transactions", "customers", "drafts"];
  const tx = db.transaction(names, "readwrite");
  for (const record of stores.transactions) {
    tx.objectStore("transactions").put(record);
  }
  for (const record of stores.customers) {
    tx.objectStore("customers").put(record);
  }
  for (const record of stores.drafts) {
    tx.objectStore("drafts").put(record);
  }
  await transactionDone(tx);
}

async function backupLegacyRecords(
  db: IDBDatabase,
  transactions: OfflineTransaction[],
  customers: StoredCustomer[],
  drafts: Array<Record<string, unknown>>
): Promise<void> {
  const names = [
    LEGACY_BACKUP_STORES.transactions,
    LEGACY_BACKUP_STORES.customers,
    LEGACY_BACKUP_STORES.drafts,
  ];
  const tx = db.transaction(names, "readwrite");
  for (const record of transactions) {
    tx.objectStore(LEGACY_BACKUP_STORES.transactions).put(record);
  }
  for (const record of customers) {
    tx.objectStore(LEGACY_BACKUP_STORES.customers).put(record);
  }
  for (const record of drafts) {
    tx.objectStore(LEGACY_BACKUP_STORES.drafts).put(record);
  }
  await transactionDone(tx);
}

async function clearLegacyBackups(db: IDBDatabase): Promise<void> {
  const names = [
    LEGACY_BACKUP_STORES.transactions,
    LEGACY_BACKUP_STORES.customers,
    LEGACY_BACKUP_STORES.drafts,
  ];
  const tx = db.transaction(names, "readwrite");
  for (const name of names) tx.objectStore(name).clear();
  await transactionDone(tx);
}

/**
 * Migrate legacy plaintext records to the protected representation.
 *
 * Steps are deliberately separate because WebCrypto is asynchronous and an
 * IndexedDB transaction cannot stay open across an await. Plaintext backups are
 * kept until every protected record has been read back and decrypted. A failed
 * or interrupted run is recoverable and idempotent.
 */
export async function migrateOfflineRecordsToProtected(): Promise<OfflineMigrationSummary> {
  const context = await requireMatchingProtectionScope();
  if (!context) {
    throw new OfflineLockedError(
      "Set up and unlock the offline passphrase before migrating saved records."
    );
  }
  const key = requireOfflineKey(context);
  const db = await openOfflineDatabase();

  const existingMeta = await new Promise<{ value?: { version?: number } } | undefined>(
    (resolve, reject) => {
      const req = db
        .transaction("meta", "readonly")
        .objectStore("meta")
        .get(MIGRATION_META_KEY);
      req.onsuccess = () => resolve(req.result as { value?: { version?: number } });
      req.onerror = () => reject(toStorageError(req.error));
    }
  );
  if (existingMeta?.value?.version === 1) {
    return {
      migrated: false,
      transactions: 0,
      customers: 0,
      drafts: 0,
      alreadyProtected: true,
    };
  }

  const transactions = await readStore<OfflineTransaction>(db, "transactions");
  const customers = await readStore<StoredCustomer>(db, "customers");
  const drafts = await readStore<Record<string, unknown>>(db, "drafts");
  const legacyTransactions = transactions.filter((record) => !record.protectedPayload);
  const legacyCustomers = customers.filter((record) => !record.protectedData);
  const legacyDrafts = drafts.filter((record) => !record.protectedData);

  if (
    legacyTransactions.length === 0 &&
    legacyCustomers.length === 0 &&
    legacyDrafts.length === 0
  ) {
    // A previous run may have encrypted records and crashed before clearing
    // the plaintext backups. Verify the live protected records decrypt BEFORE
    // removing the only recoverable plaintext copy.
    const liveTransactions = await readStore<OfflineTransaction>(db, "transactions");
    const liveCustomers = await readStore<StoredCustomer>(db, "customers");
    const liveDrafts = await readStore<Record<string, unknown>>(db, "drafts");
    for (const record of liveTransactions) {
      if (record.protectedPayload) {
        await unprotectValue<string>(key, record.protectedPayload);
      }
    }
    for (const record of liveCustomers) {
      if (record.protectedData) {
        await unprotectValue(key, record.protectedData);
      }
    }
    for (const record of liveDrafts) {
      const protectedData = record.protectedData as ProtectedPayload | undefined;
      if (protectedData) await unprotectValue(key, protectedData);
    }
    await clearLegacyBackups(db);
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({
      key: MIGRATION_META_KEY,
      value: {
        version: 1,
        migratedAt: new Date().toISOString(),
        transactions: liveTransactions.length,
        customers: liveCustomers.length,
        drafts: liveDrafts.length,
      },
    });
    await transactionDone(tx);
    return {
      migrated: false,
      transactions: liveTransactions.length,
      customers: liveCustomers.length,
      drafts: liveDrafts.length,
      alreadyProtected: false,
    };
  }

  await backupLegacyRecords(db, legacyTransactions, legacyCustomers, legacyDrafts);

  const protectedTransactions: OfflineTransaction[] = [];
  for (const record of legacyTransactions) {
    protectedTransactions.push({
      ...record,
      protectedPayload: await protectValue(key, record.payload),
      protectionVersion: 1,
      payload: "",
    });
  }
  const protectedCustomers: StoredCustomer[] = [];
  for (const record of legacyCustomers) {
    const publicRecord = record as unknown as CachedCustomer;
    protectedCustomers.push({
      accountId: record.accountId,
      protectionVersion: 1,
      protectedData: await protectValue(key, publicRecord),
    });
  }
  const protectedDrafts: Array<Record<string, unknown>> = [];
  for (const record of legacyDrafts) {
    protectedDrafts.push({
      ...record,
      protectedData: await protectValue(key, record.data),
      protectionVersion: 1,
      data: {},
    });
  }

  await writeProtectedRecords(db, {
    transactions: protectedTransactions,
    customers: protectedCustomers,
    drafts: protectedDrafts,
  });

  // Read back and verify every protected record before removing plaintext.
  const readTransactions = await readStore<OfflineTransaction>(db, "transactions");
  const readCustomers = await readStore<StoredCustomer>(db, "customers");
  const readDrafts = await readStore<Record<string, unknown>>(db, "drafts");
  for (const record of readTransactions) {
    if (!record.protectedPayload) {
      throw new OfflineCryptoError(
        "corrupt_data",
        "Offline transaction migration verification failed. Plaintext backup was kept."
      );
    }
    const payload = await unprotectValue<string>(key, record.protectedPayload);
    if (payload !== (legacyTransactions.find((item) => item.id === record.id)?.payload ?? payload)) {
      throw new OfflineCryptoError(
        "corrupt_data",
        "Offline transaction payload verification failed. Plaintext backup was kept."
      );
    }
  }
  for (const record of readCustomers) {
    if (!record.protectedData) {
      throw new OfflineCryptoError(
        "corrupt_data",
        "Offline customer migration verification failed. Plaintext backup was kept."
      );
    }
    const decrypted = await unprotectValue<CachedCustomer>(
      key,
      record.protectedData
    );
    const original = legacyCustomers.find(
      (customer) => customer.accountId === record.accountId
    );
    if (
      original &&
      (decrypted.accountId !== original.accountId ||
        decrypted.customerName !== original.customerName ||
        decrypted.customerIdCode !== original.customerIdCode ||
        decrypted.expectedAmount !== original.expectedAmount)
    ) {
      throw new OfflineCryptoError(
        "corrupt_data",
        "Offline customer data verification failed. Plaintext backup was kept."
      );
    }
  }
  for (const record of readDrafts) {
    const protectedData = record.protectedData as ProtectedPayload | undefined;
    if (!protectedData) {
      throw new OfflineCryptoError(
        "corrupt_data",
        "Offline draft migration verification failed. Plaintext backup was kept."
      );
    }
    const decrypted = await unprotectValue<unknown>(key, protectedData);
    const original = legacyDrafts.find((draft) => draft.id === record.id);
    if (original && JSON.stringify(decrypted) !== JSON.stringify(original.data)) {
      throw new OfflineCryptoError(
        "corrupt_data",
        "Offline draft data verification failed. Plaintext backup was kept."
      );
    }
  }

  // Verified: plaintext backups may now be removed. The live protected records
  // are never deleted by this step.
  await clearLegacyBackups(db);
  const marker = db.transaction("meta", "readwrite");
  marker.objectStore("meta").put({
    key: MIGRATION_META_KEY,
    value: {
      version: 1,
      migratedAt: new Date().toISOString(),
      transactions: protectedTransactions.length,
      customers: protectedCustomers.length,
      drafts: protectedDrafts.length,
    },
  });
  await transactionDone(marker);

  return {
    migrated: true,
    transactions: protectedTransactions.length,
    customers: protectedCustomers.length,
    drafts: protectedDrafts.length,
    alreadyProtected: false,
  };
}

/** True when plaintext legacy records still need migration. */
export async function needsOfflineEncryptionMigration(): Promise<boolean> {
  const context = await requireMatchingProtectionScope();
  if (!context) return false;
  const db = await openOfflineDatabase();
  const meta = await new Promise<{ value?: { version?: number } } | undefined>(
    (resolve, reject) => {
      const req = db
        .transaction("meta", "readonly")
        .objectStore("meta")
        .get(MIGRATION_META_KEY);
      req.onsuccess = () => resolve(req.result as { value?: { version?: number } });
      req.onerror = () => reject(toStorageError(req.error));
    }
  );
  if (meta?.value?.version === 1) return false;
  const transactions = await readStore<OfflineTransaction>(db, "transactions");
  const customers = await readStore<StoredCustomer>(db, "customers");
  const drafts = await readStore<Record<string, unknown>>(db, "drafts");
  return (
    transactions.some((record) => !record.protectedPayload) ||
    customers.some((record) => !record.protectedData) ||
    drafts.some((record) => !record.protectedData)
  );
}

// ── Utility ────────────────────────────────────────────────────────────

export async function getPendingCount(): Promise<number> {
  const pending = await getPendingTransactions();
  return pending.length;
}

export async function getTotalOfflineCount(): Promise<number> {
  const all = await getAllTransactions();
  return all.filter((t) => t.status !== "synced").length;
}

export interface OfflineQueueSummary {
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
  unresolved: number;
  lastSuccessfulSyncAt: string | null;
  failedRecords: Array<{
    id: string;
    type: TransactionType;
    failureReason: string | null;
    createdAt: string;
    retryCount: number;
  }>;
}

/**
 * Every record whose financial outcome is not yet acknowledged by the server.
 *
 * This is deliberately the union of pending, syncing and failed. A queue read
 * error propagates: callers must never treat an unreadable queue as empty.
 */
export async function getUnresolvedTransactions(): Promise<OfflineTransaction[]> {
  const all = await getAllTransactions();
  return all.filter(
    (record) =>
      record.status === "pending_sync" ||
      record.status === "syncing" ||
      record.status === "failed"
  );
}

/** One read for the offline status panel and the sign-out safeguard. */
export async function getOfflineQueueSummary(): Promise<OfflineQueueSummary> {
  const all = await getAllTransactions();
  const synced = all.filter((t) => t.status === "synced");
  const pending = all.filter((t) => t.status === "pending_sync").length;
  const syncing = all.filter((t) => t.status === "syncing").length;
  const failed = all.filter((t) => t.status === "failed").length;
  const lastSuccessfulSyncAt =
    synced
      .map((t) => t.syncedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

  return {
    pending,
    syncing,
    synced: synced.length,
    failed,
    unresolved: pending + syncing + failed,
    lastSuccessfulSyncAt,
    failedRecords: all
      .filter((t) => t.status === "failed")
      .slice(0, 20)
      .map((t) => ({
        id: t.id,
        type: t.type,
        failureReason: t.failureReason,
        createdAt: t.createdAt,
        retryCount: t.retryCount,
      })),
  };
}
