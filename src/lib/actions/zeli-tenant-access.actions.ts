"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { getTenantZeliAccess } from "@/lib/zeli/availability";
import { getZeliAvailability } from "@/lib/zeli/availability";

/**
 * Platform Super Admin — per-business Zeli switch.
 *
 * The global switch remains the master control. This adds an explicit,
 * audited decision for one business. Absence of an override means "enabled",
 * so every eligible paying business gets Zeli by default while the platform
 * switch is on. Disabling never deletes conversations, usage history or any
 * business record.
 */

export interface TenantZeliRow {
  tenantId: string;
  code: string;
  name: string;
  tenantStatus: string;
  zeliEnabled: boolean;
  reason: string | null;
  overrideSource: "default" | "database" | "error";
  updatedAt: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  allowance: number | null;
  used: number;
}

export interface TenantZeliResponse {
  success: boolean;
  error?: string;
  data?: TenantZeliRow[];
}

async function requirePlatformWrite() {
  const session = await getPlatformAdminOrNull();
  if (!session) throw new Error("Not authenticated");
  if (session.forcePasswordReset) throw new Error("Password change required");
  const rate = await consumeRateLimit(
    "platform.zeli.tenant_access",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) throw new Error("Too many changes. Try again later.");
  return session;
}

async function requirePlatformRead() {
  const session = await getPlatformAdminOrNull();
  if (!session) throw new Error("Not authenticated");
  if (session.forcePasswordReset) throw new Error("Password change required");
  return session;
}

export async function listTenantZeliAccess(): Promise<TenantZeliResponse> {
  try {
    await requirePlatformRead();
  } catch {
    return { success: false, error: "Not authenticated" };
  }

  const period = new Date().toISOString().slice(0, 7);
  const tenants = await db.businessTenant.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      zeliAccess: { select: { enabled: true, reason: true, updatedAt: true } },
      zeliSubscriptions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          plan: { select: { name: true, usageAllowance: true } },
        },
      },
    },
  });
  const usage = await db.zeliUsagePeriod.findMany({ where: { period } });
  const usageByTenant = new Map(usage.map((row) => [row.tenantId, row]));

  return {
    success: true,
    data: tenants.map((tenant) => {
      const subscription = tenant.zeliSubscriptions[0] ?? null;
      const used = usageByTenant.get(tenant.id)?.requests ?? 0;
      return {
        tenantId: tenant.id,
        code: tenant.code,
        name: tenant.name,
        tenantStatus: tenant.status,
        zeliEnabled: tenant.zeliAccess ? tenant.zeliAccess.enabled : true,
        reason: tenant.zeliAccess?.reason ?? null,
        overrideSource: tenant.zeliAccess ? "database" : "default",
        updatedAt: tenant.zeliAccess?.updatedAt.toISOString() ?? null,
        planName: subscription?.plan.name ?? null,
        subscriptionStatus: subscription?.status ?? null,
        allowance: subscription?.plan.usageAllowance ?? null,
        used,
      };
    }),
  };
}

export async function setTenantZeliAccess(input: {
  tenantId: string;
  enabled: boolean;
  reason: string;
}): Promise<{ success: boolean; error?: string }> {
  let session;
  try {
    session = await requirePlatformWrite();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Not authenticated" };
  }

  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  if (typeof input.enabled !== "boolean") {
    return { success: false, error: "Choose enable or disable." };
  }

  const tenant = await db.businessTenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, code: true, name: true },
  });
  if (!tenant) return { success: false, error: "That business was not found." };

  try {
    const previous = await getTenantZeliAccess(tenant.id);
    await db.$transaction(async (tx) => {
      await tx.zeliTenantAccess.upsert({
        where: { tenantId: tenant.id },
        create: {
          tenantId: tenant.id,
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
          action: input.enabled ? "zeli.tenant_enabled" : "zeli.tenant_disabled",
          tenantId: tenant.id,
          tenantCode: tenant.code,
          entityType: "zeli_tenant_access",
          entityId: tenant.id,
          reason,
          details: JSON.stringify({
            business: tenant.name,
            previousValue: previous.enabled,
            newValue: input.enabled,
            timestamp: new Date().toISOString(),
          }),
        },
      });
    });
    return { success: true };
  } catch {
    return { success: false, error: "The Zeli change could not be saved." };
  }
}

/** Global switch state for the panel heading; read-only. */
export async function getZeliPlatformSwitchState(): Promise<{
  globalEnabled: boolean;
  globalReason: string | null;
}> {
  await requirePlatformRead();
  const state = await getZeliAvailability();
  return { globalEnabled: state.enabled, globalReason: state.reason };
}
