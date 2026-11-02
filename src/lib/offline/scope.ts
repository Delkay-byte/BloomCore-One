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

/** Delete a database, resolving even when it never existed. */
export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
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

/** Remove the signed-in user's offline data (called on sign-out). */
export async function clearCurrentOfflineData(): Promise<void> {
  closeOfflineConnections();
  try {
    // Remove every offline scope on this device. On a shared device this is
    // deliberately stronger than removing only the current user's data.
    const databases =
      typeof indexedDB.databases === "function"
        ? await indexedDB.databases()
        : [];
    const names = databases
      .map((entry) => entry.name)
      .filter((name): name is string =>
        Boolean(name && name.startsWith("bik-prestige-offline"))
      );
    if (names.length === 0) {
      const scope = cachedScope ?? (await getOfflineScope());
      names.push(offlineDatabaseName(scope));
    }
    for (const name of names) {
      await deleteDatabase(name);
    }
  } catch {
    // best effort
  }
  clearOfflineScope();
}
