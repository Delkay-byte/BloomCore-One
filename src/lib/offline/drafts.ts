/**
 * Scoped, versioned form drafts.
 *
 * Two storage modes, chosen by what is actually available:
 *
 * 1. Protected mode. When the device has an offline unlock credential, the
 *    sanitized draft is encrypted with the workspace AES key and written to the
 *    per-tenant/per-user IndexedDB database. It survives reloads and can only
 *    be read after an unlock.
 * 2. Session mode. An ordinary authenticated online session has no local
 *    secret, so a persistent encrypted draft is impossible without either
 *    storing the key beside the data or asking for the passphrase. In that case
 *    the draft stays in `sessionStorage`, scoped to the tab and to the
 *    tenant/user. It is never written to IndexedDB, survives navigation and
 *    reload in the same tab, and is discarded when the tab closes.
 *
 * A draft is unfinished work, never a posted financial transaction. Restoring a
 * draft only refills the form; the user still confirms and submits it. Passwords,
 * OTPs, tokens, MFA secrets, PINs and recovery codes are removed before write.
 */

import { OfflineStorageError } from "@/lib/errors/friendly";
import { getOfflineScope, type OfflineScope } from "./scope";
import { openOfflineDatabase } from "./store";
import { getCurrentOfflineContext } from "./device-store";
import {
  OfflineCryptoError,
  protectValue,
  unprotectValue,
  type ProtectedPayload,
} from "./crypto";
import { OfflineLockedError, isOfflineUnlocked, requireOfflineKey } from "./unlock";

export const DRAFT_SCHEMA_VERSION = 2;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DRAFT_SAVE_TIMEOUT_MS = 15_000;
export const DRAFT_LOAD_TIMEOUT_MS = 10_000;
export const DRAFT_SESSION_PREFIX = "maacash-draft-session";

/** Reject instead of leaving a caller pending forever on a blocked database. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OfflineStorageError("write_failed", `${label} timed out`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export type DraftStorageMode = "protected" | "session";

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
  protectedData?: ProtectedPayload;
  protectionVersion?: 1;
  /** Where this draft lives. Absent on records written before this field. */
  storage?: DraftStorageMode;
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

// ── Session-mode storage ───────────────────────────────────────────────
// `sessionStorage` keeps online drafts out of IndexedDB and out of browser
// restart. A module map stands in where the platform has no sessionStorage
// (server rendering, unit tests) so callers still get a working draft.

const memorySessionDrafts = new Map<string, string>();

function sessionStorageKey(scope: OfflineScope, draftKey: string): string {
  return `${DRAFT_SESSION_PREFIX}:${scope.tenantId}:${scope.userId}:${draftKey}`;
}

function readSessionValue(key: string): string | null {
  try {
    if (typeof sessionStorage !== "undefined") {
      return sessionStorage.getItem(key);
    }
  } catch {
    // A blocked storage API is treated as an empty draft, never a crash.
  }
  return memorySessionDrafts.get(key) ?? null;
}

function writeSessionValue(key: string, value: string): void {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(key, value);
    return;
  }
  memorySessionDrafts.set(key, value);
}

function removeSessionValue(key: string): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
  memorySessionDrafts.delete(key);
}

/**
 * Remove every session-mode draft. Called on sign-out and by tests. Session
 * drafts have no local key, so they must not outlive the authenticated session
 * that created them.
 */
export function clearSessionDrafts(): void {
  memorySessionDrafts.clear();
  if (typeof sessionStorage === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(`${DRAFT_SESSION_PREFIX}:`)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // A blocked storage API has nothing reachable to clear.
  }
}

function readSessionDraft<T>(scope: OfflineScope, draftKey: string): DraftRecord<T> | null {
  const raw = readSessionValue(sessionStorageKey(scope, draftKey));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as DraftRecord<T>;
    if (record.tenantId !== scope.tenantId || record.userId !== scope.userId) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function writeSessionDraft<T>(scope: OfflineScope, record: DraftRecord<T>): void {
  try {
    writeSessionValue(
      sessionStorageKey(scope, record.draftKey),
      JSON.stringify({ ...record, storage: "session" })
    );
  } catch (error) {
    throw storageError(error);
  }
}

// ── IndexedDB helpers ──────────────────────────────────────────────────

async function readIndexedDraft<T>(
  draftKey: string,
  timeoutMs = DRAFT_LOAD_TIMEOUT_MS
): Promise<DraftRecord<T> | null> {
  const db = await withTimeout(openOfflineDatabase(), timeoutMs, "Draft storage");
  const record = await withTimeout(
    new Promise<DraftRecord<T> | undefined>((resolve, reject) => {
      const tx = db.transaction("drafts", "readonly");
      const request = tx.objectStore("drafts").get(draftKey);
      request.onsuccess = () => resolve(request.result as DraftRecord<T> | undefined);
      request.onerror = () => reject(request.error);
    }),
    timeoutMs,
    "Draft load"
  );
  return record ?? null;
}

async function deleteIndexedDraft(draftKey: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await withTimeout(
      openOfflineDatabase(),
      DRAFT_SAVE_TIMEOUT_MS,
      "Draft storage"
    );
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.objectStore("drafts").delete(draftKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
      DRAFT_SAVE_TIMEOUT_MS,
      "Draft delete"
    );
  } catch {
    // Best effort: a failed cleanup must never block form submission.
  }
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
  const sanitized = sanitizeDraftData(data) as T;
  const context = await getCurrentOfflineContext();
  if (
    context?.unlock &&
    (context.tenantId !== scope.tenantId || context.userId !== scope.userId)
  ) {
    throw new OfflineLockedError(
      "The offline unlock belongs to a different account than this draft."
    );
  }

  if (!context?.unlock) {
    // Online session without a local secret. Keep the draft out of IndexedDB.
    // Any older plaintext record for the same key is moved to session storage
    // in one step, so an interrupted migration is safe to repeat.
    const record: DraftRecord<T> = {
      id: draftKey,
      draftKey,
      tenantId: scope.tenantId,
      userId: scope.userId,
      workflow,
      schemaVersion: DRAFT_SCHEMA_VERSION,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
      data: sanitized,
      storage: "session",
    };
    writeSessionDraft(scope, record);
    await deleteIndexedDraft(draftKey);
    return record;
  }

  const protectedData = await protectValue(requireOfflineKey(context), sanitized);
  const record: DraftRecord<T> = {
    id: draftKey,
    draftKey,
    tenantId: scope.tenantId,
    userId: scope.userId,
    workflow,
    schemaVersion: DRAFT_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
    data: {} as T,
    protectedData,
    protectionVersion: 1,
    storage: "protected",
  };

  try {
    const db = await withTimeout(openOfflineDatabase(), DRAFT_SAVE_TIMEOUT_MS, "Draft storage");
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.objectStore("drafts").put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
      DRAFT_SAVE_TIMEOUT_MS,
      "Draft save"
    );
    removeSessionValue(sessionStorageKey(scope, draftKey));
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
    const activeContext = await getCurrentOfflineContext();
    if (
      activeContext?.unlock &&
      (activeContext.tenantId !== scope.tenantId ||
        activeContext.userId !== scope.userId)
    ) {
      throw new OfflineLockedError(
        "The offline unlock belongs to a different account than this draft."
      );
    }
    if (activeContext?.unlock && !isOfflineUnlocked(activeContext)) {
      // A locked workspace must not fall back to an unprotected record.
      throw new OfflineLockedError();
    }

    if (!activeContext?.unlock) {
      const sessionRecord = readSessionDraft<T>(scope, draftKey);
      const legacy = await readIndexedDraft<T>(draftKey);
      if (legacy?.protectedData) {
        // The device has protected drafts but no unlock context. Fail closed.
        throw new OfflineLockedError();
      }
      if (sessionRecord) {
        if (isDraftStale(sessionRecord, scope)) {
          removeSessionValue(sessionStorageKey(scope, draftKey));
          return null;
        }
        return sessionRecord;
      }
      if (!legacy) return null;
      if (isDraftStale(legacy, scope)) {
        await deleteIndexedDraft(draftKey);
        return null;
      }
      // Move a legacy plaintext record into session scope before removing it.
      writeSessionDraft(scope, { ...legacy, storage: "session" });
      await deleteIndexedDraft(draftKey);
      return { ...legacy, storage: "session" };
    }

    const record = await readIndexedDraft<T>(draftKey);
    if (!record) return null;
    if (isDraftStale(record, scope)) {
      await deleteIndexedDraft(draftKey);
      return null;
    }
    if (record.protectedData) {
      record.data = await unprotectValue<T>(
        requireOfflineKey(activeContext),
        record.protectedData
      );
      return record;
    }
    // A legacy plaintext draft found under an unlocked workspace is encrypted
    // in place, so it cannot remain readable while the workspace is locked.
    const protectedData = await protectValue(
      requireOfflineKey(activeContext),
      record.data
    );
    const upgraded: DraftRecord<T> = {
      ...record,
      data: {} as T,
      protectedData,
      protectionVersion: 1,
      storage: "protected",
    };
    const db = await withTimeout(openOfflineDatabase(), DRAFT_SAVE_TIMEOUT_MS, "Draft storage");
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.objectStore("drafts").put(upgraded);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
      DRAFT_SAVE_TIMEOUT_MS,
      "Draft migration"
    );
    return {
      ...upgraded,
      data: await unprotectValue<T>(requireOfflineKey(activeContext), protectedData),
    };
  } catch (error) {
    if (error instanceof OfflineLockedError || error instanceof OfflineCryptoError) {
      throw error;
    }
    return null;
  }
}

function isDraftStale(
  record: DraftRecord<unknown>,
  scope: OfflineScope
): boolean {
  const foreign =
    record.tenantId !== scope.tenantId || record.userId !== scope.userId;
  const expired = new Date(record.expiresAt).getTime() < Date.now();
  const outdated = record.schemaVersion !== DRAFT_SCHEMA_VERSION;
  return foreign || expired || outdated;
}

export async function deleteDraft(draftKey: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const scope = await getOfflineScope();
    removeSessionValue(sessionStorageKey(scope, draftKey));
  } catch {
    // The database delete below is still attempted.
  }
  await deleteIndexedDraft(draftKey);
}

/** List the current user's drafts, newest first. */
export async function listDrafts(): Promise<Array<Omit<DraftRecord, "data">>> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const scope = await getOfflineScope();
    const db = await withTimeout(openOfflineDatabase(), DRAFT_LOAD_TIMEOUT_MS, "Draft storage");
    const records = await withTimeout(
      new Promise<DraftRecord[]>((resolve, reject) => {
        const tx = db.transaction("drafts", "readonly");
        const request = tx.objectStore("drafts").getAll();
        request.onsuccess = () => resolve(request.result as DraftRecord[]);
        request.onerror = () => reject(request.error);
      }),
      DRAFT_LOAD_TIMEOUT_MS,
      "Draft list"
    );
    const sessionRecords: DraftRecord[] = [];
    const prefix = `${DRAFT_SESSION_PREFIX}:${scope.tenantId}:${scope.userId}:`;
    if (typeof sessionStorage !== "undefined") {
      try {
        for (let index = 0; index < sessionStorage.length; index += 1) {
          const key = sessionStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          const raw = sessionStorage.getItem(key);
          if (!raw) continue;
          try {
            sessionRecords.push(JSON.parse(raw) as DraftRecord);
          } catch {
            // ignore a corrupt entry
          }
        }
      } catch {
        // A blocked storage API simply lists no session drafts.
      }
    }
    for (const [key, raw] of memorySessionDrafts) {
      if (!key.startsWith(prefix)) continue;
      try {
        sessionRecords.push(JSON.parse(raw) as DraftRecord);
      } catch {
        // ignore a corrupt entry
      }
    }
    return [...records, ...sessionRecords]
      // The database is already scoped, but a record written by an older build
      // or a partially migrated device must never appear to another account.
      .filter(
        (record) =>
          record.tenantId === scope.tenantId && record.userId === scope.userId
      )
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
