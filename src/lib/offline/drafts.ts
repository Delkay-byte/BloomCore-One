/**
 * Scoped, versioned form drafts.
 *
 * Drafts live in the same per-tenant/per-user IndexedDB database as the offline
 * queue, so one account on a shared device cannot open another account's
 * unfinished work. Nothing here is claimed to be encrypted against a device
 * attacker; IndexedDB is ordinary browser storage. Passwords, MFA secrets,
 * recovery codes and tokens are removed before a draft is written.
 *
 * A draft is unfinished work, never a posted financial transaction. Restoring a
 * draft only refills the form; the user still confirms and submits it.
 */

import { OfflineStorageError } from "@/lib/errors/friendly";
import { getOfflineScope } from "./scope";
import { openOfflineDatabase } from "./store";

export const DRAFT_SCHEMA_VERSION = 2;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface DraftRecord<T = Record<string, unknown>> {
  id: string;
  draftKey: string;
  tenantId: string;
  userId: string;
  workflow: string;
  schemaVersion: number;
  updatedAt: string;
  expiresAt: string;
  data: T;
}

const SECRET_KEY_PATTERN =
  /(password|passcode|secret|token|otp|one.?time|recovery.?code|pin|cvv|cvc|card.?number|authorization|mfa)/i;

/** Remove secrets and functions from a draft payload before it is stored. */
export function sanitizeDraftData(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (value == null) return value;
  if (typeof value === "string") return value.length > 20_000 ? value.slice(0, 20_000) : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeDraftData(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      if (typeof nested === "function") continue;
      const clean = sanitizeDraftData(nested, depth + 1);
      if (clean !== undefined) output[key] = clean;
    }
    return output;
  }
  return undefined;
}

function assertStorage(): void {
  if (typeof indexedDB === "undefined") {
    throw new OfflineStorageError("storage_unavailable");
  }
}

function storageError(error: unknown): OfflineStorageError {
  if (error instanceof OfflineStorageError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new OfflineStorageError("storage_full");
  }
  return new OfflineStorageError("write_failed");
}

/**
 * Save or replace a draft. The scope is resolved from the server session, so a
 * caller cannot write into another tenant's or user's storage.
 */
export async function saveDraft<T>(
  draftKey: string,
  workflow: string,
  data: T
): Promise<DraftRecord<T>> {
  assertStorage();
  const scope = await getOfflineScope();
  const now = new Date();
  const record: DraftRecord<T> = {
    id: draftKey,
    draftKey,
    tenantId: scope.tenantId,
    userId: scope.userId,
    workflow,
    schemaVersion: DRAFT_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
    data: sanitizeDraftData(data) as T,
  };

  try {
    const db = await openOfflineDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return record;
  } catch (error) {
    throw storageError(error);
  }
}

/**
 * Read a draft for the current scope. Expired, foreign-scope and
 * schema-incompatible drafts are removed and reported as absent.
 */
export async function loadDraft<T = Record<string, unknown>>(
  draftKey: string
): Promise<DraftRecord<T> | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const scope = await getOfflineScope();
    const db = await openOfflineDatabase();
    const record = await new Promise<DraftRecord<T> | undefined>((resolve, reject) => {
      const tx = db.transaction("drafts", "readonly");
      const request = tx.objectStore("drafts").get(draftKey);
      request.onsuccess = () => resolve(request.result as DraftRecord<T> | undefined);
      request.onerror = () => reject(request.error);
    });

    if (!record) return null;

    const foreign =
      record.tenantId !== scope.tenantId || record.userId !== scope.userId;
    const expired = new Date(record.expiresAt).getTime() < Date.now();
    const outdated = record.schemaVersion !== DRAFT_SCHEMA_VERSION;

    if (foreign || expired || outdated) {
      await deleteDraft(draftKey);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export async function deleteDraft(draftKey: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openOfflineDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").delete(draftKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best effort: a failed cleanup must never block form submission.
  }
}

/** List the current user's drafts, newest first. */
export async function listDrafts(): Promise<Array<Omit<DraftRecord, "data">>> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const db = await openOfflineDatabase();
    const records = await new Promise<DraftRecord[]>((resolve, reject) => {
      const tx = db.transaction("drafts", "readonly");
      const request = tx.objectStore("drafts").getAll();
      request.onsuccess = () => resolve(request.result as DraftRecord[]);
      request.onerror = () => reject(request.error);
    });
    return records
      .map((record) => {
        const meta = { ...record } as Partial<DraftRecord>;
        delete meta.data;
        return meta as Omit<DraftRecord, "data">;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

/** Delete expired drafts for this scope. Runs on app start. */
export async function pruneExpiredDrafts(): Promise<number> {
  const drafts = await listDrafts();
  let removed = 0;
  for (const draft of drafts) {
    if (new Date(draft.expiresAt).getTime() < Date.now()) {
      await deleteDraft(draft.draftKey);
      removed += 1;
    }
  }
  return removed;
}
