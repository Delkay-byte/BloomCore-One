"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo, assertTenantEntity } from "@/lib/tenant";
import { locationSchema } from "@/lib/validations";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * MoMo locations are tenant-owned.
 *
 * Every function here resolves the tenant from the server session and scopes
 * its query by tenantId. Location codes are unique per tenant (not globally),
 * so two businesses can both run an "ACC-001" branch.
 *
 * Previously getActiveLocations() and getLocationById() had no authorization
 * guard at all and returned data across the whole database.
 */

export async function createLocation(
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  const raw = {
    name: (formData.get("name") as string)?.trim(),
    code: (formData.get("code") as string)?.trim().toUpperCase(),
    description: (formData.get("description") as string)?.trim() || undefined,
    address: (formData.get("address") as string)?.trim() || undefined,
    contactPhone: (formData.get("contactPhone") as string)?.trim() || undefined,
    status: (formData.get("status") as string) || "active",
  };

  const validated = locationSchema.safeParse(raw);
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0].message };
  }

  // Uniqueness is per tenant.
  const existing = await db.location.findFirst({
    where: { code: validated.data.code, tenantId: ctx.tenantId },
  });
  if (existing) {
    return { success: false, error: "A location with this code already exists" };
  }

  const location = await db.location.create({
    data: { ...validated.data, tenantId: ctx.tenantId },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "location.created",
    entityType: "location",
    entityId: location.id,
    details: { name: location.name, code: location.code },
  });

  revalidatePath("/admin/locations");
  revalidatePath("/admin/dashboard");
  return { success: true, data: location };
}

export async function updateLocation(
  locationId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  // The location must belong to the authenticated tenant.
  if (!(await assertTenantEntity("location", locationId, ctx))) {
    return { success: false, error: "Location not found" };
  }

  const raw = {
    name: (formData.get("name") as string)?.trim(),
    code: (formData.get("code") as string)?.trim().toUpperCase(),
    description: (formData.get("description") as string)?.trim() || undefined,
    address: (formData.get("address") as string)?.trim() || undefined,
    contactPhone: (formData.get("contactPhone") as string)?.trim() || undefined,
    status: (formData.get("status") as string) || "active",
  };

  const validated = locationSchema.safeParse(raw);
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0].message };
  }

  const existing = await db.location.findFirst({
    where: {
      code: validated.data.code,
      tenantId: ctx.tenantId,
      id: { not: locationId },
    },
  });
  if (existing) {
    return { success: false, error: "A location with this code already exists" };
  }

  const location = await db.location.update({
    where: { id: locationId },
    data: validated.data,
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "location.updated",
    entityType: "location",
    entityId: locationId,
    details: { name: location.name },
  });

  revalidatePath("/admin/locations");
  revalidatePath(`/admin/locations/${locationId}`);
  revalidatePath("/admin/dashboard");
  return { success: true, data: location };
}

export async function toggleLocationStatus(
  locationId: string,
  newStatus: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  if (!(await assertTenantEntity("location", locationId, ctx))) {
    return { success: false, error: "Location not found" };
  }

  const location = await db.location.update({
    where: { id: locationId },
    data: { status: newStatus },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: `location.${newStatus === "active" ? "activated" : "deactivated"}`,
    entityType: "location",
    entityId: locationId,
    details: { name: location.name, status: newStatus },
  });

  revalidatePath("/admin/locations");
  revalidatePath(`/admin/locations/${locationId}`);
  revalidatePath("/admin/dashboard");
  return { success: true, data: location };
}

export async function getLocations() {
  const ctx = await requireTenantAdminMomo();
  return db.location.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { users: true, dailyAccounts: true } } },
  });
}

/**
 * Active locations for the authenticated tenant.
 * Now guarded — previously this returned every active location on the platform
 * to any caller.
 */
export async function getActiveLocations() {
  const ctx = await requireTenantAdminMomo();
  return db.location.findMany({
    where: { status: "active", tenantId: ctx.tenantId },
    orderBy: { name: "asc" },
  });
}

/**
 * A single location, scoped to the authenticated tenant.
 * Now guarded — previously this returned any location by id to any caller.
 */
export async function getLocationById(id: string) {
  const ctx = await requireTenantAdminMomo();
  return db.location.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      users: {
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          status: true,
        },
      },
    },
  });
}
