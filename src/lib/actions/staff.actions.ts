"use server";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { requireTenantAdminMomo, requireTenantAdminSusu, assertTenantEntity } from "@/lib/tenant";
import { createStaffSchema } from "@/lib/validations";
import { createAuditLog } from "@/lib/audit";
import { validateStatusTransition } from "@/lib/security/status";
import { revalidatePath } from "next/cache";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Staff directory — tenant owned.
 *
 * The staff directory is a shared (MoMo + Susu) surface, so it accepts a
 * tenant administrator from either module. Every query is scoped by tenantId.
 */

async function requireStaffAdmin() {
  const momo = await requireTenantAdminMomo().catch(() => null);
  if (momo) return momo;
  return requireTenantAdminSusu();
}

export async function getStaff() {
  const ctx = await requireStaffAdmin();
  return db.user.findMany({
    where: {
      tenantId: ctx.tenantId,
      role: { in: ["admin", "worker", "collector"] },
    },
    include: {
      location: { select: { id: true, name: true, code: true } },
      collector: { select: { id: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getStaffById(id: string) {
  const ctx = await requireStaffAdmin();
  return db.user.findFirst({
    where: {
      id,
      tenantId: ctx.tenantId,
      role: { in: ["admin", "worker", "collector"] },
    },
    include: { location: true, collector: true },
  });
}

export async function createStaff(formData: FormData): Promise<ActionResponse> {
  const ctx = await requireStaffAdmin();

  const raw = {
    fullName: (formData.get("fullName") as string)?.trim(),
    email: (formData.get("email") as string)?.trim().toLowerCase(),
    phone: (formData.get("phone") as string)?.trim() || undefined,
    password: formData.get("password") as string,
    role: (formData.get("role") as string) || "worker",
    status: (formData.get("status") as string) || "active",
  };

  const validated = createStaffSchema.safeParse(raw);
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0].message };
  }

  // Module entitlement: a tenant cannot create a collector unless Susu is
  // enabled for the business.
  if (validated.data.role === "collector" && !ctx.susuEnabled) {
    return {
      success: false,
      error: "This business is not enrolled for the Susu module.",
    };
  }

  const existing = await db.user.findUnique({
    where: { email: validated.data.email },
  });
  if (existing) {
    return { success: false, error: "A user with this email already exists" };
  }

  const passwordHash = await hashPassword(validated.data.password);

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        tenantId: ctx.tenantId,
        fullName: validated.data.fullName,
        email: validated.data.email,
        phone: validated.data.phone,
        passwordHash,
        role: validated.data.role,
        status: validated.data.status,
        forcePasswordReset: true,
        susuEnabled: validated.data.role === "collector",
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    if (validated.data.role === "collector") {
      await tx.collector.create({
        data: { tenantId: ctx.tenantId, userId: created.id, status: "active" },
      });
    }

    return created;
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "user.staff_created",
    entityType: "user",
    entityId: user.id,
    details: { fullName: user.fullName, email: user.email, role: user.role },
  });

  revalidatePath("/admin/staff");
  revalidatePath("/admin/dashboard");
  return { success: true, data: user };
}

export async function updateStaff(
  staffId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireStaffAdmin();

  if (!(await assertTenantEntity("user", staffId, ctx))) {
    return { success: false, error: "Staff member not found" };
  }

  const raw = {
    fullName: (formData.get("fullName") as string)?.trim(),
    email: (formData.get("email") as string)?.trim().toLowerCase(),
    phone: (formData.get("phone") as string)?.trim() || undefined,
    status: (formData.get("status") as string) || "active",
  };

  if (!raw.fullName || raw.fullName.length < 2) {
    return { success: false, error: "Full name must be at least 2 characters" };
  }
  if (!raw.email || !raw.email.includes("@")) {
    return { success: false, error: "Please enter a valid email" };
  }

  const targetForStatus = await db.user.findFirst({
    where: { id: staffId, tenantId: ctx.tenantId },
    select: { status: true },
  });
  if (!targetForStatus) {
    return { success: false, error: "Staff member not found" };
  }
  const statusCheck = validateStatusTransition(targetForStatus.status, raw.status);
  if (!statusCheck.ok) return { success: false, error: statusCheck.error };
  raw.status = statusCheck.status;

  const existing = await db.user.findFirst({
    where: { email: raw.email, id: { not: staffId } },
  });
  if (existing) {
    return { success: false, error: "A user with this email already exists" };
  }

  const target = await db.user.findFirst({
    where: { id: staffId, tenantId: ctx.tenantId },
  });
  if (!target || !["admin", "worker", "collector"].includes(target.role)) {
    return { success: false, error: "Staff member not found" };
  }

  const user = await db.user.update({
    where: { id: staffId },
    data: {
      fullName: raw.fullName,
      email: raw.email,
      phone: raw.phone,
      status: raw.status,
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      role: true,
      status: true,
    },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "user.staff_updated",
    entityType: "user",
    entityId: staffId,
    details: { fullName: user.fullName },
  });

  revalidatePath("/admin/staff");
  revalidatePath(`/admin/staff/${staffId}`);
  return { success: true, data: user };
}

/**
 * Grant or remove one module capability on the SAME staff identity.
 *
 * Promoting an existing MoMo agent to Susu collector never creates a second
 * user, never changes the password hash and never removes MoMo access. The
 * Collector record is linked to the existing User row. Disabling one module
 * deactivates only that module's record and leaves the other intact.
 */
export async function setStaffModuleCapability(
  staffId: string,
  module: "momo" | "susu",
  enabled: boolean,
  locationId?: string
): Promise<ActionResponse> {
  const ctx = await requireStaffAdmin();

  if (enabled) {
    if (module === "momo" && !ctx.momoEnabled) {
      return {
        success: false,
        error: "This business is not enrolled for the MoMo module.",
      };
    }
    if (module === "susu" && !ctx.susuEnabled) {
      return {
        success: false,
        error: "This business is not enrolled for the Susu module.",
      };
    }
  }

  const target = await db.user.findFirst({
    where: { id: staffId, tenantId: ctx.tenantId },
  });
  if (!target || !["worker", "collector"].includes(target.role)) {
    return { success: false, error: "Staff member not found" };
  }

  if (module === "momo") {
    if (enabled) {
      if (!locationId) {
        return {
          success: false,
          error: "Assign a MoMo location before enabling this module.",
        };
      }
      if (!(await assertTenantEntity("location", locationId, ctx))) {
        return { success: false, error: "Selected location is not available" };
      }
    }

    if (target.momoEnabled === enabled) {
      return { success: true };
    }

    await db.user.update({
      where: { id: staffId },
      data: {
        momoEnabled: enabled,
        ...(enabled ? { locationId } : {}),
        tokenVersion: { increment: 1 },
      },
    });
  } else {
    if (target.susuEnabled === enabled) {
      return { success: true };
    }

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: staffId },
        data: {
          susuEnabled: enabled,
          tokenVersion: { increment: 1 },
        },
      });

      const existing = await tx.collector.findFirst({
        where: { userId: staffId, tenantId: ctx.tenantId },
      });
      if (existing) {
        // Never delete the collector or its assignments. Deactivation keeps
        // contribution and remittance history intact.
        await tx.collector.update({
          where: { id: existing.id },
          data: { status: enabled ? "active" : "inactive" },
        });
      } else if (enabled) {
        await tx.collector.create({
          data: {
            tenantId: ctx.tenantId,
            userId: staffId,
            status: "active",
          },
        });
      }
    });
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "user.module_assignment_changed",
    entityType: "user",
    entityId: staffId,
    details: {
      module,
      enabled,
      identityPreserved: true,
      passwordPreserved: true,
      ...(locationId && module === "momo" ? { locationId } : {}),
    },
  });

  revalidatePath("/admin/staff");
  revalidatePath(`/admin/staff/${staffId}`);
  revalidatePath("/susu/admin/collectors");
  revalidatePath("/admin/workers");
  return { success: true };
}

export async function toggleStaffStatus(
  staffId: string,
  newStatus: string
): Promise<ActionResponse> {
  const ctx = await requireStaffAdmin();

  const target = await db.user.findFirst({
    where: { id: staffId, tenantId: ctx.tenantId },
  });
  if (!target || !["admin", "worker", "collector"].includes(target.role)) {
    return { success: false, error: "Staff member not found" };
  }

  const check = validateStatusTransition(target.status, newStatus);
  if (!check.ok) return { success: false, error: check.error };

  const user = await db.user.update({
    where: { id: staffId },
    data: { status: check.status, tokenVersion: { increment: 1 } },
    select: { fullName: true, role: true },
  });

  if (target.role === "collector") {
    const collector = await db.collector.findFirst({
      where: { userId: staffId, tenantId: ctx.tenantId },
    });
    if (collector) {
      const desired = check.status === "active" ? "active" : "inactive";
      if (collector.status !== desired) {
        await db.collector.update({
          where: { id: collector.id },
          data: { status: desired },
        });
      }
    }
  }

  await createAuditLog({
    userId: ctx.userId,
    action: `user.staff_${check.status === "active" ? "activated" : "deactivated"}`,
    entityType: "user",
    entityId: staffId,
    details: { fullName: user.fullName, role: user.role },
  });

  revalidatePath("/admin/staff");
  revalidatePath(`/admin/staff/${staffId}`);
  revalidatePath("/admin/dashboard");
  return { success: true };
}

export async function resetStaffPassword(
  staffId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireStaffAdmin();

  const target = await db.user.findFirst({
    where: { id: staffId, tenantId: ctx.tenantId },
    select: { id: true, role: true },
  });
  if (!target || !["admin", "worker", "collector"].includes(target.role)) {
    return { success: false, error: "Staff member not found" };
  }

  const newPassword = formData.get("newPassword") as string;
  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: "Password must be at least 8 characters" };
  }

  const passwordHash = await hashPassword(newPassword);

  await db.user.update({
    where: { id: staffId },
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
    entityId: staffId,
    details: { sessionsInvalidated: true },
  });

  revalidatePath("/admin/staff");
  return { success: true };
}

/**
 * SmartSearch over the staff directory — tenant scoped.
 */
export async function searchStaffDirectory(query: string) {
  const ctx = await requireStaffAdmin();

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
      const idLower = u.id.toLowerCase();
      const matches =
        nameLower.includes(normalizedQuery) ||
        emailLower.includes(normalizedQuery) ||
        phoneLower.includes(normalizedQuery) ||
        idLower.includes(normalizedQuery);
      if (matches) seen.add(u.id);
      return matches;
    })
    .slice(0, 20)
    .map((u) => ({
      id: u.id,
      label: u.fullName,
      subLabel: `${u.role} • ${u.email}${u.phone ? ` • ${u.phone}` : ""} • ID: ${u.id.slice(0, 12)}…`,
    }));
}
