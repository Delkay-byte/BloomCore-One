/**
 * IndexedDB-backed offline transaction store.
 *
 * Stores financial transactions securely in IndexedDB with encryption
 * via the Web Crypto API. Each transaction has a unique idempotency
 * key and tracks sync status.
 *
 * This is NOT localStorage — IndexedDB provides structured storage,
 * larger capacity, and better suitability for financial data queues.
 */

import {
  getOfflineScope,
  offlineDatabaseName,
  purgeLegacyOfflineDatabase,
  registerOfflineConnection,
} from "./scope";

const DB_VERSION = 1;

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
  payload: string; // Encrypted JSON
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

async function openDB(): Promise<IDBDatabase> {
  await purgeLegacyOfflineDatabase();
  const scope = await getOfflineScope();
  const name = offlineDatabaseName(scope);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
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
    };
    request.onsuccess = () => {
      registerOfflineConnection(request.result);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

// ── Transaction Operations ─────────────────────────────────────────────

export async function addTransaction(tx: OfflineTransaction): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readwrite").objectStore("transactions");
    const request = txStore.add(tx);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getTransaction(id: string): Promise<OfflineTransaction | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readonly").objectStore("transactions");
    const request = txStore.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function updateTransaction(id: string, updates: Partial<OfflineTransaction>): Promise<void> {
  const existing = await getTransaction(id);
  if (!existing) return;
  const updated = { ...existing, ...updates };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readwrite").objectStore("transactions");
    const request = txStore.put(updated);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getPendingTransactions(): Promise<OfflineTransaction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readonly").objectStore("transactions");
    const index = txStore.index("status");
    const request = index.getAll("pending_sync");
    request.onsuccess = () => {
      const results = request.result as OfflineTransaction[];
      results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getSyncingTransactions(): Promise<OfflineTransaction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readonly").objectStore("transactions");
    const index = txStore.index("status");
    const request = index.getAll("syncing");
    request.onsuccess = () => resolve(request.result as OfflineTransaction[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getSyncedTransactions(): Promise<OfflineTransaction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readonly").objectStore("transactions");
    const index = txStore.index("status");
    const request = index.getAll("synced");
    request.onsuccess = () => resolve(request.result as OfflineTransaction[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getFailedTransactions(): Promise<OfflineTransaction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readonly").objectStore("transactions");
    const index = txStore.index("status");
    const request = index.getAll("failed");
    request.onsuccess = () => resolve(request.result as OfflineTransaction[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllTransactions(): Promise<OfflineTransaction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txStore = db.transaction("transactions", "readonly").objectStore("transactions");
    const request = txStore.getAll();
    request.onsuccess = () => resolve(request.result as OfflineTransaction[]);
    request.onerror = () => reject(request.error);
  });
}

// ── Customer Cache ─────────────────────────────────────────────────────

export async function cacheCustomers(customers: CachedCustomer[]): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("customers", "readwrite");
  const store = tx.objectStore("customers");
  store.clear();
  for (const c of customers) {
    store.add(c);
  }
}

export async function getCachedCustomers(): Promise<CachedCustomer[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction("customers", "readonly").objectStore("customers");
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as CachedCustomer[]);
    request.onerror = () => reject(request.error);
  });
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
