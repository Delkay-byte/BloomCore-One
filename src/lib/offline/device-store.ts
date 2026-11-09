/**
 * Durable, non-secret offline device preparation state.
 *
 * This database is intentionally device-level, not tied to the authenticated
 * tenant/user database. It lets the app answer two questions without a server:
 *   1. Which user prepared this device, and for which modules?
 *   2. May that user open a previously synchronized offline workspace?
 *
 * It stores identity, module names, timestamps and a local activation flag. It
 * never stores a password, JWT, refresh token, raw session handle, customer
 * record or financial payload. Those remain in their existing scoped stores or
 * on the server.
 */

export type OfflineModule = "momo" | "susu";

export const OFFLINE_AUTH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_DEVICE_DB = "bloomcore-offline-device:v1";
const STORE = "state";
const CURRENT_KEY = "current";

export interface OfflineModuleState {
  deviceId: string;
  preparedAt: string;
  lastSyncedAt: string | null;
}

export interface OfflinePreparedContext {
  tenantId: string;
  userId: string;
  userName: string;
  role: string;
  modules: OfflineModule[];
  moduleStates: Partial<Record<OfflineModule, OfflineModuleState>>;
  /** Set when the server revoked a module. Records are preserved. */
  blockedModules?: Partial<Record<OfflineModule, string>>;
  preparedAt: string;
  authorizedAt: string;
  expiresAt: string;
  lastSyncedAt: string | null;
  active: boolean;
  activeModule: OfflineModule | null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(OFFLINE_DEVICE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getState<T>(key: string): Promise<T | null> {
  try {
    const db = await openDatabase();
    return await new Promise<T | null>((resolve, reject) => {
      const request = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(key);
      request.onsuccess = () =>
        resolve((request.result?.value as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function putState(key: string, value: unknown): Promise<boolean> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteState(key: string): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // best effort
  }
}

export function offlineContextExpired(
  context: Pick<OfflinePreparedContext, "expiresAt"> | null | undefined,
  now = Date.now()
): boolean {
  if (!context?.expiresAt) return true;
  const expiry = new Date(context.expiresAt).getTime();
  return !Number.isFinite(expiry) || expiry <= now;
}

export function offlineContextSupports(
  context: OfflinePreparedContext | null | undefined,
  module: OfflineModule
): boolean {
  return Boolean(
    context?.modules.includes(module) &&
      context.moduleStates[module] &&
      !context.blockedModules?.[module]
  );
}

export function offlineModuleBlockReason(
  context: OfflinePreparedContext | null | undefined,
  module: OfflineModule
): string | null {
  return context?.blockedModules?.[module] ?? null;
}

/** Persist a server revocation without deleting any saved financial record. */
export async function blockOfflineModules(
  tenantId: string,
  userId: string,
  blocked: Partial<Record<OfflineModule, string>>
): Promise<void> {
  const current = await getCurrentOfflineContext();
  if (!current || current.tenantId !== tenantId || current.userId !== userId) return;
  const merged: OfflinePreparedContext = {
    ...current,
    blockedModules: { ...(current.blockedModules ?? {}), ...blocked },
    active: false,
    activeModule: null,
  };
  await putState(CURRENT_KEY, merged);
  await putState(preparedKey(tenantId, userId), merged);
}

export function offlineContextRemainingMs(
  context: Pick<OfflinePreparedContext, "expiresAt"> | null | undefined,
  now = Date.now()
): number {
  if (!context?.expiresAt) return 0;
  const expiry = new Date(context.expiresAt).getTime();
  return Number.isFinite(expiry) ? Math.max(0, expiry - now) : 0;
}

function preparedKey(tenantId: string, userId: string): string {
  return `prepared:${tenantId}:${userId}`;
}

/**
 * Persist a validated preparation and make it the current local session.
 * Returns false when the browser cannot store it; the caller must not claim
 * offline readiness in that case.
 */
export async function savePreparedContext(
  context: OfflinePreparedContext
): Promise<boolean> {
  const previous = await getCurrentOfflineContext();
  const sameIdentity =
    previous?.tenantId === context.tenantId && previous?.userId === context.userId;
  const value: OfflinePreparedContext = {
    ...context,
    active: sameIdentity ? previous?.active ?? false : false,
    activeModule: sameIdentity ? previous?.activeModule ?? null : null,
  };
  const saved = await putState(preparedKey(context.tenantId, context.userId), value);
  if (!saved) return false;
  return putState(CURRENT_KEY, value);
}

export async function getPreparedContext(
  tenantId: string,
  userId: string
): Promise<OfflinePreparedContext | null> {
  return getState<OfflinePreparedContext>(preparedKey(tenantId, userId));
}

export async function getCurrentOfflineContext(): Promise<OfflinePreparedContext | null> {
  const value = await getState<OfflinePreparedContext>(CURRENT_KEY);
  if (!value || !value.tenantId || !value.userId || !Array.isArray(value.modules)) {
    return null;
  }
  return value;
}

export async function setCurrentOfflineContext(
  context: OfflinePreparedContext
): Promise<boolean> {
  return putState(CURRENT_KEY, context);
}

/** Explicit sign-out ends offline access. Prepared records are not deleted. */
export async function clearCurrentOfflineContext(): Promise<void> {
  await deleteState(CURRENT_KEY);
}

/**
 * Local activation only. This never contacts the server and never extends the
 * authorization window.
 */
export async function setOfflineActivation(
  active: boolean,
  module: OfflineModule | null = null
): Promise<OfflinePreparedContext | null> {
  const context = await getCurrentOfflineContext();
  if (!context) return null;
  const updated: OfflinePreparedContext = {
    ...context,
    active,
    activeModule: active ? module ?? context.activeModule ?? context.modules[0] ?? null : null,
  };
  const currentSaved = await putState(CURRENT_KEY, updated);
  if (!currentSaved) return null;
  await putState(preparedKey(updated.tenantId, updated.userId), updated);
  return updated;
}

/**
 * Reconcile the local authorization window with the server after a successful
 * synchronization. The server remains the source of truth.
 */
export async function markOfflineAuthorized(
  tenantId: string,
  userId: string,
  authorizedAt: string
): Promise<void> {
  const time = new Date(authorizedAt).getTime();
  if (!Number.isFinite(time)) return;
  const expiresAt = new Date(time + OFFLINE_AUTH_TIMEOUT_MS).toISOString();
  const prepared = await getPreparedContext(tenantId, userId);
  const current = await getCurrentOfflineContext();
  if (prepared) {
    await putState(preparedKey(tenantId, userId), {
      ...prepared,
      authorizedAt,
      expiresAt,
    });
  }
  if (current && current.tenantId === tenantId && current.userId === userId) {
    await putState(CURRENT_KEY, { ...current, authorizedAt, expiresAt });
  }
}

/** Record a successful synchronization without extending authorization. */
export async function markOfflineSynced(
  tenantId: string,
  userId: string,
  at: string = new Date().toISOString()
): Promise<void> {
  const prepared = await getPreparedContext(tenantId, userId);
  const current = await getCurrentOfflineContext();
  if (prepared) {
    const updated = { ...prepared, lastSyncedAt: at };
    await putState(preparedKey(tenantId, userId), updated);
  }
  if (current && current.tenantId === tenantId && current.userId === userId) {
    await putState(CURRENT_KEY, { ...current, lastSyncedAt: at });
  }
}

/** Test/support helper: remove the device-level readiness database. */
export function deleteOfflineDeviceDatabase(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    const request = indexedDB.deleteDatabase(OFFLINE_DEVICE_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
