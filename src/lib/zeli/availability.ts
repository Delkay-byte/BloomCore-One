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
  constructor(message = "Zeli is temporarily unavailable. BloomCore One remains available.") {
    super(message);
    this.name = "ZeliUnavailableError";
  }
}

const UNAVAILABLE_MESSAGE =
  "Zeli is temporarily unavailable. BloomCore One remains available.";

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
