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
const openConnections = new Set<IDBDatabase>();

/** Track an open IndexedDB connection so sign-out can close it before delete. */
export function registerOfflineConnection(db: IDBDatabase): void {
  openConnections.add(db);
  db.onclose = () => openConnections.delete(db);
}

export function closeOfflineConnections(): void {
  for (const db of openConnections) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  openConnections.clear();
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
  const response = await fetch("/api/auth/me?module=susu", {
    cache: "no-store",
    credentials: "same-origin",
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

/** Raised when another tab/connection prevents IndexedDB from being deleted. */
export class OfflineDeletionBlockedError extends Error {
  constructor(public databaseName: string) {
    super(
      "The offline database is still open in another tab or connection. Close other BloomCore One tabs and try again."
    );
    this.name = "OfflineDeletionBlockedError";
  }
}

/**
 * Delete a database, resolving only when the browser confirms deletion.
 *
 * `blocked` means another tab/connection still holds the database open. It is
 * reported as a failure, never as success: the data still exists until the
 * browser actually completes the delete request.
 */
export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("IndexedDB deletion failed"));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      // Do not keep the request alive pretending it may still finish. The
      // caller must report that deletion did not complete.
      reject(new OfflineDeletionBlockedError(name));
    };
  });
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
