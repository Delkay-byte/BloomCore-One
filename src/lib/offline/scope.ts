/**
 * Offline storage scope.
 *
 * Offline data is partitioned by authenticated tenant + user. Each scope gets
 * its own IndexedDB database, so switching accounts on a shared device cannot
 * expose the previous user's cached customers or queued transactions.
 *
 * The scope is resolved from the server session (`/api/auth/me`), never from a
 * client-supplied id. Server-side authorization remains authoritative when
 * queued transactions are synchronised.
 */

export interface OfflineScope {
  tenantId: string;
  userId: string;
}

let cachedScope: OfflineScope | null = null;
let pendingScope: Promise<OfflineScope> | null = null;
let legacyPurged = false;

/**
 * The session lookup must always settle. Before this bound existed a stalled
 * service-worker handshake left every draft write waiting on `pendingScope`
 * forever, which surfaced as a save spinner that never stopped.
 */
const SCOPE_TIMEOUT_MS = 10_000;
const openConnections = new Map<string, Set<IDBDatabase>>();
const pendingDeletions = new Map<string, Promise<void>>();

/** Track an open IndexedDB connection so sign-out/deletion can close it. */
export function registerOfflineConnection(
  db: IDBDatabase,
  databaseName: string
): void {
  let set = openConnections.get(databaseName);
  if (!set) {
    set = new Set();
    openConnections.set(databaseName, set);
  }
  set.add(db);
  db.onclose = () => {
    set?.delete(db);
    if (set?.size === 0) openConnections.delete(databaseName);
  };
}

export function closeOfflineConnections(databaseName?: string): void {
  const names = databaseName
    ? [databaseName]
    : Array.from(openConnections.keys());
  for (const name of names) {
    const set = openConnections.get(name);
    if (!set) continue;
    for (const db of set) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    openConnections.delete(name);
  }
}

export function setOfflineScope(scope: OfflineScope): void {
  if (!scope.tenantId || !scope.userId) return;
  cachedScope = { tenantId: scope.tenantId, userId: scope.userId };
}

export function clearOfflineScope(): void {
  cachedScope = null;
  pendingScope = null;
}

export function offlineDatabaseName(scope: OfflineScope): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "");
  return `bik-prestige-offline:v2:${safe(scope.tenantId)}:${safe(scope.userId)}`;
}

async function resolveScope(): Promise<OfflineScope> {
  // Resolve the module-neutral identity. The previous implementation always
  // asked for `module=susu`, so a MoMo-only worker or administrator received a
  // 401 and every draft write failed. `/api/auth/me` already resolves the
  // caller's own role and tenant on the server; the browser cannot choose one.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCOPE_TIMEOUT_MS);
  try {
    const response = await fetch("/api/auth/me", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Not authenticated for offline storage");
    const data = (await response.json()) as {
      userId?: string;
      tenant?: { id?: string } | null;
    };
    if (!data.userId || !data.tenant?.id) {
      throw new Error("No tenant scope for offline storage");
    }
    const scope = { tenantId: data.tenant.id, userId: data.userId };
    setOfflineScope(scope);
    return scope;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOfflineScope(): Promise<OfflineScope> {
  if (cachedScope) return cachedScope;
  if (!pendingScope) {
    pendingScope = resolveScope().finally(() => {
      pendingScope = null;
    });
  }
  return pendingScope;
}

/**
 * Delete a database. Resolves only on the browser's success event.
 *
 * `blocked` means the request is still queued in the browser, not that it was
 * cancelled or rejected: another tab/connection holds the database open. The
 * request remains live and may complete later. `onBlocked` reports that pending
 * state so the UI never claims deletion finished.
 */
export function deleteDatabase(
  name: string,
  options: { onBlocked?: () => void } = {}
): Promise<void> {
  const existing = pendingDeletions.get(name);
  if (existing) return existing;

  const deletion = new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      pendingDeletions.delete(name);
      resolve();
    };
    request.onerror = () => {
      pendingDeletions.delete(name);
      reject(request.error ?? new Error("IndexedDB deletion failed"));
    };
    request.onblocked = () => {
      // Do NOT reject: the browser has not cancelled the request. Report the
      // pending state and keep waiting for success/error.
      options.onBlocked?.();
    };
  });

  pendingDeletions.set(name, deletion);
  return deletion;
}

/** True while a delete request for this database is still live in the browser. */
export function isDeletionPending(name: string): boolean {
  return pendingDeletions.has(name);
}

/** Confirm whether the database still exists (used after a blocked request). */
export async function isDatabasePresent(name: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  try {
    const databases =
      typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    return databases.some((entry) => entry.name === name);
  } catch {
    // Unknown is not "absent": fail closed.
    return true;
  }
}

/**
 * The pre-hardening build used one global database for every user. Purge it
 * once per page session so its contents can never be read by another account.
 */
export async function purgeLegacyOfflineDatabase(): Promise<void> {
  if (legacyPurged || typeof indexedDB === "undefined") return;
  legacyPurged = true;
  try {
    await deleteDatabase("bik-prestige-offline");
  } catch {
    // best effort
  }
}

/** Names of every offline database on this device (all scopes). */
export async function listOfflineDatabaseNames(): Promise<string[]> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const databases =
      typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    return databases
      .map((entry) => entry.name)
      .filter((name): name is string =>
        Boolean(name && name.startsWith("bik-prestige-offline"))
      );
  } catch {
    return [];
  }
}

/**
 * End the current offline session without destroying records.
 *
 * Sign-out closes the user's database connections and clears the in-memory
 * scope. Queued transactions and drafts stay in the database named for their
 * tenant and user; the next account opens a different database. The same user
 * reopens this one after authenticating again.
 */
export function closeCurrentOfflineSession(): void {
  closeOfflineConnections();
  clearOfflineScope();
}
