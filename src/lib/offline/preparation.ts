/**
 * Offline preparation and local activation.
 *
 * Preparation is the only part that needs a connection. It validates the
 * authenticated identity server-side, enrolls the device for every authorized
 * module, downloads the collector's authorized customer list, and warms the
 * application shell. Only after those checks pass is the device marked ready.
 *
 * Activation is local. Tapping "Enable Offline" never calls an API merely to
 * change a preference. A prepared device can activate after connectivity is
 * already gone.
 */

import { getCollectorDashboardStats } from "@/lib/actions/susu-dashboard.actions";
import { ensureTabSessionWorker } from "@/lib/security/tab-session-client";
import type { ModuleName } from "@/lib/auth";
import {
  activeWorkspaceModule,
  isOfflineModule,
} from "./active-module";
import {
  OFFLINE_AUTH_TIMEOUT_MS,
  blockOfflineModules,
  getCurrentOfflineContext,
  getOfflineUnlockRecord,
  offlineContextExpired,
  offlineContextSupports,
  offlineModuleBlockReason,
  savePreparedContext,
  getPreparedContext,
  setOfflineActivation,
  type OfflineModule,
  type OfflineModuleState,
  type OfflinePreparedContext,
} from "./device-store";
import { setOfflineScope } from "./scope";
import {
  cacheCustomers,
  migrateOfflineRecordsToProtected,
  type CachedCustomer,
} from "./store";
import { isOfflineUnlocked, setupOfflineUnlock } from "./unlock";

export type OfflineReadinessStatus =
  | "preparing"
  | "ready"
  | "active"
  | "preparation_required"
  | "unlock_required"
  | "expired"
  | "revoked";

export interface OfflineReadiness {
  status: OfflineReadinessStatus;
  module: OfflineModule | null;
  context: OfflinePreparedContext | null;
  message: string;
  lastSyncedAt: string | null;
  expiresAt: string | null;
}

export interface PreparationResult {
  ok: boolean;
  context: OfflinePreparedContext | null;
  preparedModules: OfflineModule[];
  failedModules: OfflineModule[];
  message: string;
  /** True when the user must set up the offline unlock passphrase online. */
  requiresUnlockSetup?: boolean;
  /** True when a passphrase exists but the workspace is locked. */
  requiresUnlock?: boolean;
  /** One-time recovery code when a new passphrase was created. */
  recoveryCode?: string;
}

interface MePayload {
  userId?: string;
  fullName?: string;
  role?: string;
  module?: string;
  momoEnabled?: boolean;
  susuEnabled?: boolean;
  tenant?: { id?: string; name?: string; modules?: string[] } | null;
}

const MODULE_ROUTE: Record<OfflineModule, string> = {
  momo: "/worker/dashboard",
  susu: "/collector/dashboard",
};

const MODULE_LABEL: Record<OfflineModule, string> = {
  momo: "MoMo Agent",
  susu: "Susu Collector",
};

let preparationInProgress = false;
let preparationPromise: Promise<PreparationResult> | null = null;
let preparationKey: string | null = null;

export function isPreparingOfflineAccess(): boolean {
  return preparationInProgress;
}

export function notifyOfflineStatusChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("maacash-offline-status"));
  }
}

function authorizedModules(me: MePayload): OfflineModule[] {
  const tenantModules = Array.isArray(me.tenant?.modules)
    ? me.tenant!.modules!
    : [];
  const modules: OfflineModule[] = [];
  if (
    (me.momoEnabled ?? tenantModules.includes("momo")) &&
    tenantModules.includes("momo")
  ) {
    modules.push("momo");
  }
  if (
    (me.susuEnabled ?? tenantModules.includes("susu")) &&
    tenantModules.includes("susu")
  ) {
    modules.push("susu");
  }
  return modules;
}

function moduleDeviceId(base: string, module: OfflineModule, all: OfflineModule[]): string {
  // The existing Susu queue and its server records use the base device id.
  // Keep that value so pending records keep synchronizing. Other modules get a
  // deterministic suffix because DeviceEnrollment.deviceId is unique.
  if (module === "susu" || !all.includes("susu")) return base;
  return `${base}:${module}`;
}

async function serviceWorkerReady(): Promise<boolean> {
  const registration = await ensureTabSessionWorker();
  if (!registration) return false;
  return Boolean(
    typeof navigator !== "undefined" && navigator.serviceWorker?.controller
  );
}

function canUseCaches(): boolean {
  return typeof caches !== "undefined";
}

async function routeCached(route: string): Promise<boolean> {
  if (!canUseCaches() || typeof location === "undefined") return false;
  try {
    const match = await caches.match(new URL(route, location.origin).href, {
      ignoreSearch: true,
    });
    return Boolean(match);
  } catch {
    return false;
  }
}

async function warmRoute(
  route: string,
  tenantId: string,
  userId: string
): Promise<boolean> {
  // The MoMo dashboard server response contains daily-account figures. Caching
  // that HTML would place financial data outside the encrypted offline queue.
  // MoMo offline financial postings are unsupported, so do not cache it.
  if (route === "/worker/dashboard") return false;
  if (typeof location === "undefined" || typeof fetch === "undefined") return false;
  try {
    const response = await fetch(route, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "x-maacash-offline-warm": "1",
        // The service worker namespaces its page cache by this scope so one
        // account's cached dashboard is never served to another account.
        "x-maacash-offline-scope": `${tenantId}:${userId}`,
      },
    });
    if (!response.ok || response.redirected) return false;
    return routeCached(route);
  } catch {
    return false;
  }
}

export async function warmOfflineRoutes(
  routes: string[],
  tenantId: string,
  userId: string
): Promise<string[]> {
  const warmed: string[] = [];
  for (const route of routes) {
    if (await warmRoute(route, tenantId, userId)) warmed.push(route);
  }
  return warmed;
}

async function enrollModule(
  deviceId: string,
  module: OfflineModule
): Promise<{ ok: boolean; authorizedAt: string | null; message: string }> {
  try {
    const response = await fetch("/api/offline/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ deviceId, module }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      authorizedAt?: string;
    };
    if (!response.ok) {
      return {
        ok: false,
        authorizedAt: null,
        message: data.error || "Device authorization could not be completed.",
      };
    }
    return {
      ok: true,
      authorizedAt:
        typeof data.authorizedAt === "string" ? data.authorizedAt : null,
      message: "",
    };
  } catch {
    return {
      ok: false,
      authorizedAt: null,
      message: "The device could not be prepared. Check the connection and try again.",
    };
  }
}

/**
 * Prepare this browser for offline use. Safe to call repeatedly.
 *
 * Only modules that pass every check are marked ready: server enrollment,
 * cached application shell, and (for Susu) a freshly downloaded authorized
 * customer list.
 */
export function prepareOfflineAccess(
  module?: ModuleName,
  unlockPassphrase?: string
): Promise<PreparationResult> {
  const key = module ?? "workspace";
  if (preparationPromise) {
    if (preparationKey === key) return preparationPromise;
    return preparationPromise
      .catch(() => undefined)
      .then(() => prepareOfflineAccess(module, unlockPassphrase));
  }

  preparationKey = key;
  preparationInProgress = true;
  notifyOfflineStatusChanged();
  const promise = (async () => {
    try {
      return await runOfflinePreparation(module, unlockPassphrase);
    } finally {
      preparationInProgress = false;
      preparationPromise = null;
      preparationKey = null;
      notifyOfflineStatusChanged();
    }
  })();
  preparationPromise = promise;
  return promise;
}

async function runOfflinePreparation(
  requestedModule?: ModuleName,
  unlockPassphrase?: string
): Promise<PreparationResult> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return {
        ok: false,
        context: await getCurrentOfflineContext(),
        preparedModules: [],
        failedModules: [],
        message:
          "This device needs an initial online setup before it can prepare offline access.",
      };
    }

    const activeModule =
      requestedModule ?? activeWorkspaceModule() ?? undefined;
    if (activeModule && !isOfflineModule(activeModule)) {
      return {
        ok: false,
        context: await getCurrentOfflineContext(),
        preparedModules: [],
        failedModules: [],
        message:
          "Offline field access is available to agents and collectors only.",
      };
    }

    let me: MePayload | null = null;
    try {
      // Validate the workspace the user is actually in. A module-neutral request
      // could resolve a different module's session for a dual-role account.
      const endpoint = activeModule
        ? `/api/auth/me?module=${encodeURIComponent(activeModule)}`
        : "/api/auth/me";
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        return {
          ok: false,
          context: null,
          preparedModules: [],
          failedModules: [],
          message:
            response.status === 401 || response.status === 403
              ? "Sign in to this workspace online before preparing this device for offline use."
              : "Sign in online before preparing this device for offline use.",
        };
      }
      me = (await response.json()) as MePayload;
    } catch {
      return {
        ok: false,
        context: await getCurrentOfflineContext(),
        preparedModules: [],
        failedModules: [],
        message:
          "Could not reach the server to prepare offline access. The device may already hold an earlier preparation.",
      };
    }

    const tenantId = me?.tenant?.id;
    const userId = me?.userId;
    if (!tenantId || !userId) {
      return {
        ok: false,
        context: null,
        preparedModules: [],
        failedModules: [],
        message: "The signed-in business could not be confirmed.",
      };
    }
    if (activeModule && me?.module !== activeModule) {
      return {
        ok: false,
        context: null,
        preparedModules: [],
        failedModules: [],
        message:
          "The server resolved a different workspace than this page. Reload and sign in again.",
      };
    }

    if (me.role !== "worker" && me.role !== "collector") {
      return {
        ok: false,
        context: null,
        preparedModules: [],
        failedModules: [],
        message: "Offline field access is available to agents and collectors only.",
      };
    }

    const modules = authorizedModules(me);
    if (activeModule && !modules.includes(activeModule)) {
      return {
        ok: false,
        context: null,
        preparedModules: [],
        failedModules: [],
        message:
          "This account is not authorized for offline work in this workspace.",
      };
    }
    if (modules.length === 0) {
      return {
        ok: false,
        context: null,
        preparedModules: [],
        failedModules: [],
        message: "This account has no module authorized for offline work.",
      };
    }

    const existingUnlock = await getOfflineUnlockRecord(tenantId, userId);
    let recoveryCode: string | undefined;
    if (!existingUnlock && !unlockPassphrase) {
      return {
        ok: false,
        context: await getCurrentOfflineContext(),
        preparedModules: [],
        failedModules: [],
        requiresUnlockSetup: true,
        message:
          "Set up an offline passphrase before preparing this device for offline use.",
      };
    }
    if (unlockPassphrase) {
      try {
        recoveryCode = await setupOfflineUnlock(
          { tenantId, userId },
          unlockPassphrase
        );
      } catch (error) {
        return {
          ok: false,
          context: await getCurrentOfflineContext(),
          preparedModules: [],
          failedModules: [],
          message:
            error instanceof Error
              ? error.message
              : "The offline passphrase could not be set up.",
        };
      }
      // First-time setup has no prepared context yet, but encryption and
      // migration still need the verified tenant/user scope. Create a minimal
      // provisional context; a later failure leaves it with no modules, so it
      // cannot be treated as Offline Ready.
      if (!(await getCurrentOfflineContext())) {
        const at = new Date().toISOString();
        const prepared = await getPreparedContext(tenantId, userId);
        await savePreparedContext(
          prepared ?? {
            tenantId,
            userId,
            userName: me.fullName || "MaaCash user",
            role: me.role,
            modules: [],
            moduleStates: {},
            unlock: (await getOfflineUnlockRecord(tenantId, userId)) ?? undefined,
            preparedAt: at,
            authorizedAt: at,
            expiresAt: new Date(
              new Date(at).getTime() + OFFLINE_AUTH_TIMEOUT_MS
            ).toISOString(),
            lastSyncedAt: null,
            active: false,
            activeModule: null,
          }
        );
      }
    }

    const workerReady = await serviceWorkerReady();
    if (!workerReady) {
      return {
        ok: false,
        context: null,
        preparedModules: [],
        failedModules: modules,
        message:
          "This browser could not install the offline component. Allow service workers and site storage, then reload.",
      };
    }

    // Establish the verified scope before any IndexedDB access. The device id
    // lives in the scoped database, so reading it first could otherwise fall
    // back to a different prepared context.
    setOfflineScope({ tenantId, userId }, "server", activeModule);

    if (existingUnlock && !isOfflineUnlocked({ tenantId, userId })) {
      return {
        ok: false,
        context: await getCurrentOfflineContext(),
        preparedModules: [],
        failedModules: [],
        requiresUnlock: true,
        message:
          "Unlock the offline workspace with its passphrase before refreshing protected customer data.",
      };
    }

    if (existingUnlock || unlockPassphrase) {
      try {
        await migrateOfflineRecordsToProtected();
      } catch (error) {
        return {
          ok: false,
          context: await getCurrentOfflineContext(),
          preparedModules: [],
          failedModules: [],
          message:
            error instanceof Error
              ? error.message
              : "Saved offline records could not be protected. Nothing was deleted.",
        };
      }
    }

    const { getOrCreateDeviceId } = await import("./device");
    const baseDeviceId = await getOrCreateDeviceId();
    const moduleStates: Partial<Record<OfflineModule, OfflineModuleState>> = {};
    const preparedModules: OfflineModule[] = [];
    const failedModules: OfflineModule[] = [];
    const failureMessages: string[] = [];
    const revokedModules: Partial<Record<OfflineModule, string>> = {};
    let authorizedAt = new Date().toISOString();

    for (const mod of modules) {
      const deviceId = moduleDeviceId(baseDeviceId, mod, modules);
      const enrollment = await enrollModule(deviceId, mod);
      if (!enrollment.ok) {
        failedModules.push(mod);
        if (/revoked/i.test(enrollment.message)) {
          revokedModules[mod] = enrollment.message;
        }
        failureMessages.push(`${MODULE_LABEL[mod]}: ${enrollment.message}`);
        continue;
      }
      if (enrollment.authorizedAt) authorizedAt = enrollment.authorizedAt;

      if (mod === "susu") {
        try {
          const stats = await getCollectorDashboardStats(userId);
          const toVisit = (stats?.toVisit ?? []) as Array<{
            accountId: string;
            customerName: string;
            customerIdCode: string;
            dailyContribution: number;
            outstandingDays: number;
            expectedAmount: number;
          }>;
          const customers: CachedCustomer[] = toVisit.map((customer) => ({
            accountId: customer.accountId,
            customerName: customer.customerName,
            customerIdCode: customer.customerIdCode,
            dailyContribution: customer.dailyContribution,
            outstandingDays: customer.outstandingDays,
            expectedAmount: customer.expectedAmount,
            lastSynced: new Date().toISOString(),
          }));
          await cacheCustomers(customers);
        } catch {
          failedModules.push(mod);
          failureMessages.push(
            `${MODULE_LABEL[mod]}: authorized customer data could not be downloaded.`
          );
          continue;
        }
      }

      const route = MODULE_ROUTE[mod];
      const warmed = await warmOfflineRoutes([route], tenantId, userId);
      if (!warmed.includes(route)) {
        failedModules.push(mod);
        failureMessages.push(
          `${MODULE_LABEL[mod]}: the offline app screen could not be cached.`
        );
        continue;
      }

      const now = new Date().toISOString();
      moduleStates[mod] = {
        deviceId,
        preparedAt: now,
        lastSyncedAt: now,
      };
      preparedModules.push(mod);
    }

    if (Object.keys(revokedModules).length > 0) {
      // Preserve the queued records but stop protected offline work for the
      // revoked module until an administrator restores it.
      await blockOfflineModules(tenantId, userId, revokedModules);
    }

    if (preparedModules.length === 0) {
      return {
        ok: false,
        context: await getCurrentOfflineContext(),
        preparedModules,
        failedModules,
        message:
          failureMessages.join(" ") ||
          "Offline preparation did not complete. Try again while connected.",
      };
    }

    // Login itself must also load offline so the collector can restore the
    // prepared device before reaching a protected screen.
    await warmOfflineRoutes(["/login"], tenantId, userId);

    const now = new Date().toISOString();
    const expiresAt = new Date(
      new Date(authorizedAt).getTime() + OFFLINE_AUTH_TIMEOUT_MS
    ).toISOString();
    const unlock = (await getOfflineUnlockRecord(tenantId, userId)) ?? undefined;
    const context: OfflinePreparedContext = {
      tenantId,
      userId,
      userName: me.fullName || "MaaCash user",
      role: me.role,
      modules: preparedModules,
      moduleStates,
      unlock,
      preparedAt: now,
      authorizedAt,
      expiresAt,
      lastSyncedAt: now,
      active: false,
      activeModule: null,
    };
    const saved = await savePreparedContext(context);
    if (!saved) {
      return {
        ok: false,
        context: null,
        preparedModules,
        failedModules,
        message:
          "This device could not store its offline setup. Check site storage and try again.",
      };
    }

    try {
      navigator.serviceWorker?.controller?.postMessage({
        type: "offline-scope",
        scope: `${tenantId}:${userId}`,
      });
    } catch {
      // The warmed page cache already carries the scope header fallback.
    }

  return {
    ok: true,
    context,
    preparedModules,
    failedModules,
    recoveryCode,
    message:
      failedModules.length > 0
        ? `Offline ready for ${preparedModules
            .map((item) => MODULE_LABEL[item])
            .join(" and ")}. ${failureMessages.join(" ")}`
        : "This device is prepared for offline collection.",
  };
}

/**
 * Activate offline mode locally. No server request is made and the authorization
 * window is never extended by this call.
 */
export async function activateOfflineAccess(
  module?: OfflineModule
): Promise<{ ok: boolean; readiness: OfflineReadiness }> {
  const context = await getCurrentOfflineContext();
  if (!context) {
    return {
      ok: false,
      readiness: {
        status: "preparation_required",
        module: module ?? null,
        context: null,
        message:
          "This device needs an initial online setup before it can collect offline.",
        lastSyncedAt: null,
        expiresAt: null,
      },
    };
  }
  if (offlineContextExpired(context)) {
    return {
      ok: false,
      readiness: {
        status: "expired",
        module: module ?? context.activeModule,
        context,
        message:
          "Offline access has expired. Reconnect and sign in again. Saved records remain on this device.",
        lastSyncedAt: context.lastSyncedAt,
        expiresAt: context.expiresAt,
      },
    };
  }

  const target = module ?? context.activeModule ?? context.modules[0] ?? null;
  if (target) {
    const blocked = offlineModuleBlockReason(context, target);
    if (blocked) {
      return {
        ok: false,
        readiness: {
          status: "revoked",
          module: target,
          context,
          message: `${blocked} Saved records remain on this device.`,
          lastSyncedAt: context.lastSyncedAt,
          expiresAt: context.expiresAt,
        },
      };
    }
  }
  if (!context.unlock) {
    return {
      ok: false,
      readiness: {
        status: "preparation_required",
        module: target,
        context,
        message:
          "Set up an offline passphrase while connected before using this device offline.",
        lastSyncedAt: context.lastSyncedAt,
        expiresAt: context.expiresAt,
      },
    };
  }
  if (!isOfflineUnlocked(context)) {
    return {
      ok: false,
      readiness: {
        status: "unlock_required",
        module: target,
        context,
        message: "Enter the offline passphrase to unlock saved customer and queue data.",
        lastSyncedAt: context.lastSyncedAt,
        expiresAt: context.expiresAt,
      },
    };
  }
  if (!target || !offlineContextSupports(context, target)) {
    return {
      ok: false,
      readiness: {
        status: "preparation_required",
        module: target,
        context,
        message: `This device has not been prepared for offline ${target ? MODULE_LABEL[target] : "work"}.`,
        lastSyncedAt: context.lastSyncedAt,
        expiresAt: context.expiresAt,
      },
    };
  }

  const cached = await routeCached(MODULE_ROUTE[target]);
  if (!cached) {
    return {
      ok: false,
      readiness: {
        status: "preparation_required",
        module: target,
        context,
        message:
          "The offline app screen is missing from this device. Reconnect once and prepare again.",
        lastSyncedAt: context.lastSyncedAt,
        expiresAt: context.expiresAt,
      },
    };
  }

  if (isBrowserOnline()) {
    // Activation is only meaningful while the connection is down. Online, the
    // prepared workspace stays available without claiming "Offline Active".
    return { ok: true, readiness: await getOfflineReadiness(target) };
  }

  const updated = await setOfflineActivation(true, target);
  setOfflineScope(
    { tenantId: context.tenantId, userId: context.userId },
    "prepared",
    target
  );
  notifyOfflineStatusChanged();
  return {
    ok: Boolean(updated),
    readiness: {
      status: updated ? "active" : "preparation_required",
      module: target,
      context: updated ?? context,
      message: updated
        ? "You are working offline. New collections will sync when internet returns."
        : "Offline mode could not be activated on this device.",
      lastSyncedAt: updated?.lastSyncedAt ?? context.lastSyncedAt,
      expiresAt: context.expiresAt,
    },
  };
}

/** Read the local readiness state without contacting the server. */
export async function getOfflineReadiness(
  module?: OfflineModule
): Promise<OfflineReadiness> {
  if (preparationInProgress) {
    return {
      status: "preparing",
      module: module ?? null,
      context: await getCurrentOfflineContext(),
      message: "Preparing offline access…",
      lastSyncedAt: null,
      expiresAt: null,
    };
  }

  const context = await getCurrentOfflineContext();
  if (!context) {
    return {
      status: "preparation_required",
      module: module ?? null,
      context: null,
      message:
        "This device needs an initial online setup before it can collect offline.",
      lastSyncedAt: null,
      expiresAt: null,
    };
  }
  const target = module ?? context.activeModule ?? context.modules[0] ?? null;
  if (offlineContextExpired(context)) {
    return {
      status: "expired",
      module: target,
      context,
      message:
        "Offline access has expired. Reconnect and sign in again. Saved records remain on this device.",
      lastSyncedAt: context.lastSyncedAt,
      expiresAt: context.expiresAt,
    };
  }
  if (target) {
    const blocked = offlineModuleBlockReason(context, target);
    if (blocked) {
      return {
        status: "revoked",
        module: target,
        context,
        message: `${blocked} Saved records remain on this device.`,
        lastSyncedAt: context.lastSyncedAt,
        expiresAt: context.expiresAt,
      };
    }
  }
  if (!context.unlock) {
    return {
      status: "preparation_required",
      module: target,
      context,
      message:
        "Set up an offline passphrase while connected before using this device offline.",
      lastSyncedAt: context.lastSyncedAt,
      expiresAt: context.expiresAt,
    };
  }
  if (!isOfflineUnlocked(context)) {
    return {
      status: "unlock_required",
      module: target,
      context,
      message: "Enter the offline passphrase to unlock saved customer and queue data.",
      lastSyncedAt: context.lastSyncedAt,
      expiresAt: context.expiresAt,
    };
  }
  if (!target || !offlineContextSupports(context, target)) {
    return {
      status: "preparation_required",
      module: target,
      context,
      message: `This device has not been prepared for offline ${target ? MODULE_LABEL[target] : "work"}.`,
      lastSyncedAt: context.lastSyncedAt,
      expiresAt: context.expiresAt,
    };
  }
  const cached = await routeCached(MODULE_ROUTE[target]);
  if (!cached) {
    return {
      status: "preparation_required",
      module: target,
      context,
      message:
        "The offline app screen is not available on this device. Reconnect once and prepare again.",
      lastSyncedAt: context.lastSyncedAt,
      expiresAt: context.expiresAt,
    };
  }
  return {
    status: context.active && !isBrowserOnline() ? "active" : "ready",
    module: target,
    context,
    message:
      context.active && !isBrowserOnline()
        ? "You are working offline. New collections will save on this device and sync when the server confirms them."
        : "This device is prepared for offline collection. Offline data is available if the connection drops.",
    lastSyncedAt: context.lastSyncedAt,
    expiresAt: context.expiresAt,
  };
}

function isBrowserOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

/**
 * Clear a persisted local activation flag after connectivity returns. The
 * activation flag records that the user was working offline; it must never
 * outlive the network loss that justified it.
 */
export async function deactivateOfflineAccess(
  module?: OfflineModule
): Promise<OfflineReadiness> {
  const context = await getCurrentOfflineContext();
  if (context?.active) {
    await setOfflineActivation(false);
    notifyOfflineStatusChanged();
  }
  return getOfflineReadiness(module);
}

/**
 * Reconcile the persisted activation flag with the real connection state.
 * Called on the `online` event, window focus and visibility restoration, so a
 * restored connection replaces "Offline Active" without requiring a reload.
 */
export async function reconcileOfflineConnectivity(
  module?: OfflineModule
): Promise<OfflineReadiness> {
  if (isBrowserOnline()) {
    return deactivateOfflineAccess(module);
  }
  return getOfflineReadiness(module);
}

export function moduleRoute(module: OfflineModule): string {
  return MODULE_ROUTE[module];
}

export function moduleDisplayName(module: OfflineModule): string {
  return MODULE_LABEL[module];
}
