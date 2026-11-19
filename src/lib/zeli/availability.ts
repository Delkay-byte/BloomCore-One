import { db } from "@/lib/db";

/**
 * Entire-Zeli availability control.
 *
 * One row (`id = "global"`) is read on every request. There is no in-memory
 * cache: disabling Zeli takes effect immediately across Render instances.
 *
 * Fail-closed:
 *  - a database failure returns disabled;
 *  - a missing row returns disabled (the migration inserts an enabled row for
 *    existing installations).
 *
 * This switch is independent of external-AI policy and tenant entitlements.
 * Payment webhooks, subscription lifecycle processing and platform controls do
 * not call this guard.
 */

export interface ZeliAvailabilityState {
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedById: string | null;
  source: "database" | "missing" | "error";
}

export class ZeliUnavailableError extends Error {
  code = "zeli_unavailable";
  constructor(message = "Zeli is temporarily unavailable. MaaCash remains available.") {
    super(message);
    this.name = "ZeliUnavailableError";
  }
}

export const TENANT_DISABLED_MESSAGE =
  "Zeli is turned off for this business. Your MaaCash workspace and records are unaffected.";

/**
 * Raised when Zeli is switched off for one business. The business keeps full
 * access to MaaCash; only the assistant is paused.
 */
export class ZeliTenantDisabledError extends Error {
  code = "zeli_tenant_disabled";
  constructor(message = TENANT_DISABLED_MESSAGE) {
    super(message);
    this.name = "ZeliTenantDisabledError";
  }
}

export interface TenantZeliAccessState {
  enabled: boolean;
  reason: string | null;
  /** "default" means no override exists, so Zeli follows the platform switch. */
  source: "default" | "database" | "error";
  updatedAt: string | null;
  updatedById: string | null;
}

/**
 * Per-business switch.
 *
 * A missing row means enabled: every eligible paying business gets Zeli while
 * the platform switch is on. Only an explicit platform decision writes a row.
 * A database failure is treated as enabled for the same reason the global
 * switch fails closed — the global switch already stops every request — while
 * a transient read error must not silently remove a feature a business paid for.
 */
export async function getTenantZeliAccess(
  tenantId: string | null | undefined
): Promise<TenantZeliAccessState> {
  if (!tenantId) {
    return { enabled: false, reason: "No business context.", source: "default", updatedAt: null, updatedById: null };
  }
  try {
    const row = await db.zeliTenantAccess.findUnique({ where: { tenantId } });
    if (!row) {
      return { enabled: true, reason: null, source: "default", updatedAt: null, updatedById: null };
    }
    return {
      enabled: row.enabled,
      reason: row.reason,
      source: "database",
      updatedAt: row.updatedAt.toISOString(),
      updatedById: row.updatedById,
    };
  } catch {
    return { enabled: true, reason: null, source: "error", updatedAt: null, updatedById: null };
  }
}

export async function isZeliEnabledForTenant(tenantId: string | null | undefined): Promise<boolean> {
  return (await getTenantZeliAccess(tenantId)).enabled;
}

/** Server-side gate used by every Zeli action and API route. */
export async function assertZeliTenantEnabled(tenantId: string | null | undefined): Promise<void> {
  await assertZeliAvailable();
  const access = await getTenantZeliAccess(tenantId);
  if (!access.enabled) throw new ZeliTenantDisabledError();
}

const UNAVAILABLE_MESSAGE =
  "Zeli is temporarily unavailable. MaaCash remains available.";

export async function getZeliAvailability(): Promise<ZeliAvailabilityState> {
  try {
    const row = await db.zeliAvailability.findUnique({ where: { id: "global" } });
    if (!row) {
      return {
        enabled: false,
        reason: "Zeli availability is not configured. Access is disabled until an operator enables it.",
        updatedAt: null,
        updatedById: null,
        source: "missing",
      };
    }
    return {
      enabled: row.enabled,
      reason: row.reason,
      updatedAt: row.updatedAt.toISOString(),
      updatedById: row.updatedById,
      source: "database",
    };
  } catch {
    return {
      enabled: false,
      reason: "Zeli availability could not be checked. Access is disabled.",
      updatedAt: null,
      updatedById: null,
      source: "error",
    };
  }
}

export async function isZeliEnabled(): Promise<boolean> {
  return (await getZeliAvailability()).enabled;
}

export async function assertZeliAvailable(): Promise<void> {
  const state = await getZeliAvailability();
  if (!state.enabled) throw new ZeliUnavailableError(UNAVAILABLE_MESSAGE);
}

export function zeliUnavailableResponse(): Response {
  return Response.json(
    {
      success: false,
      error: UNAVAILABLE_MESSAGE,
      code: "zeli_unavailable",
    },
    { status: 503, headers: { "cache-control": "no-store" } }
  );
}

export { UNAVAILABLE_MESSAGE };
