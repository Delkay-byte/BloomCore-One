"use server";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import {
  requireTenantAdminMomo,
  requireTenantAdminSusu,
  assertTenantEntity,
} from "@/lib/tenant";
import { createWorkerSchema, editWorkerSchema } from "@/lib/validations";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { validateStatusTransition } from "@/lib/security/status";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Workers are tenant-owned staff accounts.
 *
 * Every function resolves the tenant from the session and scopes by tenantId.
 * Email remains globally unique (login resolves by email with no tenant hint),
 * so two businesses cannot share a staff email address — a documented
 * limitation, not a leak.
 */

export async function createWorker(
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  const raw = {
    fullName: (formData.get("fullName") as string)?.trim(),
    email: (formData.get("email") as string)?.trim().toLowerCase(),
    phone: (formData.get("phone") as string)?.trim() || undefined,
    password: formData.get("password") as string,
    locationId: formData.get("locationId") as string,
    status: (formData.get("status") as string) || "active",
  };

  const validated = createWorkerSchema.safeParse(raw);
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0].message };
  }

  const existing = await db.user.findUnique({
    where: { email: validated.data.email },
  });
  if (existing) {
    return { success: false, error: "A user with this email already exists" };
  }

  // The location must belong to this tenant.
  const location = await db.location.findFirst({
    where: { id: validated.data.locationId, tenantId: ctx.tenantId },
  });
  if (!location) {
    return { success: false, error: "Selected location does not exist" };
  }
  if (location.status === "inactive") {
    return {
      success: false,
      error: "Cannot assign worker to an inactive location",
    };
  }

  const passwordHash = await hashPassword(validated.data.password);

  const worker = await db.user.create({
    data: {
      tenantId: ctx.tenantId,
      fullName: validated.data.fullName,
      email: validated.data.email,
      phone: validated.data.phone,
      passwordHash,
      role: "worker",
      momoEnabled: true,
      locationId: validated.data.locationId,
      status: validated.data.status,
      forcePasswordReset: true,
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      status: true,
      locationId: true,
      createdAt: true,
    },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "user.worker_created",
    entityType: "user",
    entityId: worker.id,
    details: { fullName: worker.fullName, email: worker.email },
  });

  revalidatePath("/admin/workers");
  revalidatePath("/admin/dashboard");
  return { success: true, data: worker };
}

export async function updateWorker(
  workerId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  if (!(await assertTenantEntity("user", workerId, ctx))) {
    return { success: false, error: "Worker not found" };
  }

  const raw = {
    fullName: (formData.get("fullName") as string)?.trim(),
    email: (formData.get("email") as string)?.trim().toLowerCase(),
    phone: (formData.get("phone") as string)?.trim() || undefined,
    locationId: formData.get("locationId") as string,
    status: (formData.get("status") as string) || "active",
  };

  const validated = editWorkerSchema.safeParse(raw);
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0].message };
  }

  const existing = await db.user.findFirst({
    where: { email: validated.data.email, id: { not: workerId } },
  });
  if (existing) {
    return { success: false, error: "A user with this email already exists" };
  }

  // A location reassignment must stay inside the tenant.
  if (
    validated.data.locationId &&
    !(await assertTenantEntity("location", validated.data.locationId, ctx))
  ) {
    return { success: false, error: "Selected location does not exist" };
  }

  const wantsSusu = formData.get("susuCollector") === "on";

  // Susu capability can only be granted if the TENANT has Susu enabled.
  if (wantsSusu && !ctx.susuEnabled) {
    return {
      success: false,
      error: "This business is not enrolled for the Susu module.",
    };
  }

  const target = await db.user.findFirst({
    where: { id: workerId, tenantId: ctx.tenantId },
    include: { collector: true },
  });
  if (!target) {
    return { success: false, error: "Worker not found" };
  }
  const susuChanged = target.susuEnabled !== wantsSusu;

  const worker = await db.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: workerId },
      data: {
        fullName: validated.data.fullName,
        email: validated.data.email,
        phone: validated.data.phone,
        locationId: validated.data.locationId,
        status: validated.data.status,
        susuEnabled: wantsSusu,
        // Capability changes take effect on the next request.
        ...(susuChanged ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        status: true,
        locationId: true,
      },
    });

    if (wantsSusu && !target.collector) {
      await tx.collector.create({
        data: { tenantId: ctx.tenantId, userId: workerId, status: "active" },
      });
    }
    if (!wantsSusu && target.collector && target.collector.status === "active") {
      await tx.collector.update({
        where: { id: target.collector.id },
        data: { status: "inactive" },
      });
    }

    return updated;
  });

  if (susuChanged) {
    await createAuditLog({
      userId: ctx.userId,
      action: "user.module_assignment_changed",
      entityType: "user",
      entityId: workerId,
      details: { module: "susu", enabled: wantsSusu },
    });
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "user.worker_updated",
    entityType: "user",
    entityId: workerId,
    details: { fullName: worker.fullName },
  });

  revalidatePath("/admin/workers");
  revalidatePath(`/admin/workers/${workerId}`);
  return { success: true, data: worker };
}

export async function resetWorkerPassword(
  workerId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  const target = await db.user.findFirst({
    where: { id: workerId, tenantId: ctx.tenantId },
    select: { id: true, role: true },
  });
  if (!target || (target.role !== "worker" && target.role !== "collector")) {
    return { success: false, error: "Worker not found" };
  }

  const newPassword = formData.get("newPassword") as string;
  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: "Password must be at least 8 characters" };
  }

  const passwordHash = await hashPassword(newPassword);

  await db.user.update({
    where: { id: workerId },
    data: {
      passwordHash,
      forcePasswordReset: true,
      tokenVersion: { increment: 1 },
    },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "user.password_reset",
    entityType: "user",
    entityId: workerId,
    details: { sessionsInvalidated: true },
  });

  revalidatePath("/admin/workers");
  return { success: true };
}

export async function toggleWorkerStatus(
  workerId: string,
  newStatus: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  if (!(await assertTenantEntity("user", workerId, ctx))) {
    return { success: false, error: "Worker not found" };
  }

  const current = await db.user.findFirst({
    where: { id: workerId, tenantId: ctx.tenantId },
    select: { status: true },
  });
  if (!current) return { success: false, error: "Worker not found" };
  const check = validateStatusTransition(current.status, newStatus);
  if (!check.ok) return { success: false, error: check.error };

  const worker = await db.user.update({
    where: { id: workerId },
    data: { status: check.status, tokenVersion: { increment: 1 } },
    select: { fullName: true },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: `user.worker_${newStatus === "active" ? "activated" : "deactivated"}`,
    entityType: "user",
    entityId: workerId,
    details: { fullName: worker.fullName },
  });

  revalidatePath("/admin/workers");
  revalidatePath(`/admin/workers/${workerId}`);
  revalidatePath("/admin/dashboard");
  return { success: true };
}

export async function getWorkers() {
  const ctx = await requireTenantAdminMomo();
  return db.user.findMany({
    where: { role: "worker", tenantId: ctx.tenantId },
    include: { location: { select: { id: true, name: true, code: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWorkerById(id: string) {
  const ctx = await requireTenantAdminMomo();
  return db.user.findFirst({
    where: { id, role: "worker", tenantId: ctx.tenantId },
    include: {
      location: true,
      dailyAccounts: {
        where: { tenantId: ctx.tenantId },
        orderBy: { businessDate: "desc" },
        take: 10,
        include: { location: { select: { name: true } } },
      },
    },
  });
}

/**
 * Search authorized staff members for the "Received By" dropdown.
 * Tenant scoped: only this business's staff are ever returned.
 */
export async function searchStaff(query: string) {
  const ctx =
    (await requireTenantAdminMomo().catch(() => null)) ??
    (await requireTenantAdminSusu().catch(() => null));
  if (!ctx) return [];

  if (!query || query.length < 2) return [];

  const normalizedQuery = query.trim().toLowerCase();

  const candidates = await db.user.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: "active",
      role: { in: ["admin", "worker", "collector"] },
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      role: true,
    },
    take: 200,
    orderBy: { fullName: "asc" },
  });

  const seen = new Set<string>();
  return candidates
    .filter((u) => {
      if (seen.has(u.id)) return false;
      const nameLower = u.fullName.toLowerCase();
      const emailLower = (u.email || "").toLowerCase();
      const phoneLower = (u.phone || "").toLowerCase();
      const matches =
        nameLower.includes(normalizedQuery) ||
        emailLower.includes(normalizedQuery) ||
        phoneLower.includes(normalizedQuery);
      if (matches) seen.add(u.id);
      return matches;
    })
    .slice(0, 10);
}
