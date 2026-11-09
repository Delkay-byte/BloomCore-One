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
import {
  OFFLINE_AUTH_TIMEOUT_MS,
  blockOfflineModules,
  getCurrentOfflineContext,
  offlineContextExpired,
  offlineContextSupports,
  offlineModuleBlockReason,
  savePreparedContext,
  setOfflineActivation,
  type OfflineModule,
  type OfflineModuleState,
  type OfflinePreparedContext,
} from "./device-store";
import { setOfflineScope } from "./scope";
import {
  cacheCustomers,
  type CachedCustomer,
} from "./store";

export type OfflineReadinessStatus =
  | "preparing"
  | "ready"
  | "active"
  | "preparation_required"
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
}

interface MePayload {
  userId?: string;
  fullName?: string;
  role?: string;
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
export function prepareOfflineAccess(): Promise<PreparationResult> {
  if (preparationPromise) return preparationPromise;
  preparationInProgress = true;
  notifyOfflineStatusChanged();
  preparationPromise = (async () => {
    try {
      return await runOfflinePreparation();
    } finally {
      preparationInProgress = false;
      preparationPromise = null;
      notifyOfflineStatusChanged();
    }
  })();
  return preparationPromise;
}

async function runOfflinePreparation(): Promise<PreparationResult> {
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

    let me: MePayload | null = null;
    try {
      const response = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        return {
          ok: false,
          context: null,
          preparedModules: [],
          failedModules: [],
          message: "Sign in online before preparing this device for offline use.",
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
    if (modules.length === 0) {
      return {
        ok: false,
        context: null,
        preparedModules: [],
        failedModules: [],
        message: "This account has no module authorized for offline work.",
      };
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

    const { getOrCreateDeviceId } = await import("./device");
    const baseDeviceId = await getOrCreateDeviceId();
    const moduleStates: Partial<Record<OfflineModule, OfflineModuleState>> = {};
    const preparedModules: OfflineModule[] = [];
    const failedModules: OfflineModule[] = [];
    const failureMessages: string[] = [];
    const revokedModules: Partial<Record<OfflineModule, string>> = {};
    let authorizedAt = new Date().toISOString();

    setOfflineScope({ tenantId, userId });

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
    const context: OfflinePreparedContext = {
      tenantId,
      userId,
      userName: me.fullName || "MaaCash user",
      role: me.role,
      modules: preparedModules,
      moduleStates,
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

  const updated = await setOfflineActivation(true, target);
  setOfflineScope({ tenantId: context.tenantId, userId: context.userId });
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
    status: context.active ? "active" : "ready",
    module: target,
    context,
    message: context.active
      ? "You are working offline. New collections will sync when internet returns."
      : "This device is prepared for offline collection.",
    lastSyncedAt: context.lastSyncedAt,
    expiresAt: context.expiresAt,
  };
}

export function moduleRoute(module: OfflineModule): string {
  return MODULE_ROUTE[module];
}

export function moduleDisplayName(module: OfflineModule): string {
  return MODULE_LABEL[module];
}
