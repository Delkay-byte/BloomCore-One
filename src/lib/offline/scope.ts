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

import {
  getCurrentOfflineContext,
  offlineContextExpired,
} from "./device-store";
import { activeWorkspaceModule } from "./active-module";
import type { ModuleName } from "@/lib/auth";

export interface OfflineScope {
  tenantId: string;
  userId: string;
}

/**
 * Why a scope could not be established. These are deliberately distinct so the
 * UI can tell "not signed in" apart from "this workspace has no tenant", a
 * temporary network failure or a genuine storage problem. They must never be
 * collapsed into "your records are gone".
 */
export type OfflineScopeFailure =
  | "unauthenticated"
  | "no_tenant"
  | "module_mismatch"
  | "network"
  | "timeout"
  | "offline_expired"
  | "unavailable";

export class OfflineScopeError extends Error {
  constructor(
    public readonly code: OfflineScopeFailure,
    message: string
  ) {
    super(message);
    this.name = "OfflineScopeError";
  }
}

/**
 * Where the current in-memory scope came from. Only a fresh server answer may
 * be presented as a verified online session.
 */
export type OfflineScopeSource = "server" | "prepared" | "seeded";

const cachedScopes = new Map<
  string,
  { scope: OfflineScope; source: OfflineScopeSource }
>();
const pendingScopes = new Map<string, Promise<OfflineScope>>();
let legacyPurged = false;

function scopeKey(module?: ModuleName): string {
  return module ?? activeWorkspaceModule() ?? "workspace";
}

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

export function setOfflineScope(
  scope: OfflineScope,
  source: OfflineScopeSource = "server",
  module?: ModuleName
): void {
  if (!scope.tenantId || !scope.userId) return;
  cachedScopes.set(scopeKey(module), {
    scope: { tenantId: scope.tenantId, userId: scope.userId },
    source,
  });
}

export function getOfflineScopeSource(
  module?: ModuleName
): OfflineScopeSource | null {
  return cachedScopes.get(scopeKey(module))?.source ?? null;
}

export function clearOfflineScope(): void {
  cachedScopes.clear();
  pendingScopes.clear();
}

export function offlineDatabaseName(scope: OfflineScope): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "");
  return `bik-prestige-offline:v2:${safe(scope.tenantId)}:${safe(scope.userId)}`;
}

/**
 * A prepared context may cover both staff modules for the SAME tenant/user, so
 * it may serve either staff workspace. It must never be used for a different
 * module surface, and it must still be within its authorization window.
 */
function preparedScopeFor(
  module: ModuleName | undefined,
  context: Awaited<ReturnType<typeof getCurrentOfflineContext>>
): OfflineScope {
  if (!context) {
    throw new OfflineScopeError(
      "network",
      "The server could not be reached and this device has no prepared offline context."
    );
  }
  if (offlineContextExpired(context)) {
    throw new OfflineScopeError(
      "offline_expired",
      "Offline authorization has expired. Reconnect to continue. Saved records remain on this device."
    );
  }
  if (module === "admin" || module === "customer") {
    throw new OfflineScopeError(
      "network",
      "The server could not be reached. Reconnect to open this workspace's saved records."
    );
  }
  if (module && !context.modules.includes(module)) {
    throw new OfflineScopeError(
      "module_mismatch",
      "This device is not prepared for this workspace. Reconnect once and prepare offline access."
    );
  }
  return { tenantId: context.tenantId, userId: context.userId };
}

async function resolveScope(module?: ModuleName): Promise<OfflineScope> {
  // Ask about the workspace this tab is actually in. The previous
  // module-neutral request could resolve a different module's session for a
  // dual-role account, so the tenant lookup (derived from the primary role)
  // disagreed with the session that was found. The module is only a routing
  // hint: `/api/auth/me` still verifies that module's credential server-side.
  const requestedModule = module ?? activeWorkspaceModule() ?? undefined;
  const endpoint = requestedModule
    ? `/api/auth/me?module=${encodeURIComponent(requestedModule)}`
    : "/api/auth/me";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCOPE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch (error) {
      // A network failure is not an authentication decision. If this device was
      // previously prepared, use its locally stored, server-approved identity
      // so offline status and the local queue remain readable. A real 401/403
      // below still fails closed.
      if (controller.signal.aborted) {
        const context = await getCurrentOfflineContext();
        if (!context) {
          throw new OfflineScopeError(
            "timeout",
            "The server did not answer in time and this device has no prepared offline context."
          );
        }
        const scope = preparedScopeFor(requestedModule, context);
        setOfflineScope(scope, "prepared", requestedModule);
        return scope;
      }
      const context = await getCurrentOfflineContext();
      if (!context) {
        throw new OfflineScopeError(
          "network",
          error instanceof Error
            ? error.message
            : "The server could not be reached."
        );
      }
      const scope = preparedScopeFor(requestedModule, context);
      setOfflineScope(scope, "prepared", requestedModule);
      return scope;
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        // Explicit server denial. Never fall back to cached context here.
        throw new OfflineScopeError(
          "unauthenticated",
          "Not authenticated for offline storage"
        );
      }
      throw new OfflineScopeError(
        "unavailable",
        `The identity service answered ${response.status}. Try again.`
      );
    }

    const data = (await response.json()) as {
      userId?: string;
      module?: string;
      tenant?: { id?: string } | null;
    };

    if (requestedModule && data.module !== requestedModule) {
      // The server must answer for the module that was asked about, and must
      // return that module explicitly. A missing field is deploy skew, not
      // permission to assume it matched.
      throw new OfflineScopeError(
        "module_mismatch",
        "The server resolved a different workspace than the one requested."
      );
    }
    if (!data.userId) {
      throw new OfflineScopeError(
        "unauthenticated",
        "The identity response did not identify a user."
      );
    }
    if (!data.tenant?.id) {
      // HTTP 200 with no tenant is a real "this workspace has no business
      // context" answer, not a network failure. Do not open an unscoped or
      // guessed database.
      throw new OfflineScopeError(
        "no_tenant",
        requestedModule
          ? "The signed-in business could not be confirmed for this workspace."
          : "No tenant scope for offline storage"
      );
    }
    const scope = { tenantId: data.tenant.id, userId: data.userId };
    setOfflineScope(scope, "server", requestedModule);
    return scope;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOfflineScope(module?: ModuleName): Promise<OfflineScope> {
  const requestedModule = module ?? activeWorkspaceModule() ?? undefined;
  const key = scopeKey(requestedModule);

  const cached = cachedScopes.get(key);
  if (cached) return cached.scope;

  const pending = pendingScopes.get(key);
  if (pending) return pending;

  const promise = resolveScope(requestedModule).finally(() => {
    pendingScopes.delete(key);
  });
  pendingScopes.set(key, promise);
  return promise;
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
