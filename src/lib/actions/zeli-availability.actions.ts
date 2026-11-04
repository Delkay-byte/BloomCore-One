"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  getZeliAvailability,
  type ZeliAvailabilityState,
} from "@/lib/zeli/availability";

/**
 * Platform-only entire-Zeli master switch.
 *
 * It is deliberately separate from ZeliProviderControl and from tenant
 * entitlements. Disabling preserves conversations, analytics, subscriptions,
 * payments and audit history.
 */

export interface AvailabilityActionResponse {
  success: boolean;
  error?: string;
  data?: ZeliAvailabilityState;
}

async function requirePlatformRead() {
  const session = await getPlatformAdminOrNull();
  if (!session) throw new Error("Not authenticated");
  if (session.forcePasswordReset) throw new Error("Password change required");
  return session;
}

async function requirePlatformWrite() {
  const session = await requirePlatformRead();
  const rate = await consumeRateLimit(
    "platform.zeli.availability",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) throw new Error("Too many changes. Try again later.");
  return session;
}

export async function getZeliAvailabilityAdminState(): Promise<{
  availability: ZeliAvailabilityState;
  updatedByName: string | null;
}> {
  await requirePlatformRead();
  const availability = await getZeliAvailability();
  let updatedByName: string | null = null;
  if (availability.updatedById) {
    const admin = await db.platformSuperAdmin.findUnique({
      where: { id: availability.updatedById },
      select: { fullName: true },
    });
    updatedByName = admin?.fullName ?? null;
  }
  return { availability, updatedByName };
}

export async function setZeliAvailability(input: {
  enabled: boolean;
  reason: string;
}): Promise<AvailabilityActionResponse> {
  const session = await requirePlatformWrite();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  if (typeof input.enabled !== "boolean") {
    return { success: false, error: "Choose enable or disable." };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const previous = await tx.zeliAvailability.findUnique({ where: { id: "global" } });
      const row = await tx.zeliAvailability.upsert({
        where: { id: "global" },
        create: {
          id: "global",
          enabled: input.enabled,
          reason,
          updatedById: session.adminId,
        },
        update: {
          enabled: input.enabled,
          reason,
          updatedById: session.adminId,
        },
      });
      await tx.platformAuditLog.create({
        data: {
          actorId: session.adminId,
          actorEmail: session.email,
          action: input.enabled ? "zeli.availability_enabled" : "zeli.availability_disabled",
          entityType: "zeli_availability",
          entityId: "global",
          reason,
          details: JSON.stringify({
            previousValue: previous?.enabled ?? null,
            newValue: row.enabled,
            previousReason: previous?.reason ?? null,
            timestamp: new Date().toISOString(),
          }),
        },
      });
      return {
        enabled: row.enabled,
        reason: row.reason,
        updatedAt: row.updatedAt.toISOString(),
        updatedById: row.updatedById,
        source: "database" as const,
      };
    });
    return { success: true, data: result };
  } catch {
    return { success: false, error: "The Zeli availability change could not be saved." };
  }
}
