"use server";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { assertTenantEntity, requireTenantAdminSusu } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { isCompanyWideAdmin, resolveBranchScope, assertBranchAccess } from "@/lib/branch";
import { validatePasswordPolicy } from "@/lib/security/password-policy";
import { issueEmailVerification } from "@/lib/security/account-tokens";
import { locationSchema } from "@/lib/validations";
import { checkPackageLimit } from "@/lib/pricing/limits";
import { revalidatePath } from "next/cache";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/** Branches visible to this identity, tenant scoped. */
export async function getBranchesForScope() {
  const ctx = await requireTenantAdminSusu();
  const scope = await resolveBranchScope(ctx);
  const branches = await db.location.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { name: "asc" },
  });
  if (scope.kind === "all") return branches;
  return branches.filter((b) => scope.branchIds.includes(b.id));
}

async function requireCompanyAdmin() {
  const ctx = await requireTenantAdminSusu();
  if (!(await isCompanyWideAdmin(ctx))) {
    throw new Error("Branch administration requires company-wide access");
  }
  return ctx;
}

/** Create a branch. Company-wide administrators only. */
export async function createBranch(formData: FormData): Promise<ActionResponse> {
  const ctx = await requireCompanyAdmin();
  const raw = {
    name: (formData.get("name") as string)?.trim(),
    code: (formData.get("code") as string)?.trim().toUpperCase(),
    description: (formData.get("description") as string)?.trim() || undefined,
    address: (formData.get("address") as string)?.trim() || undefined,
    contactPhone: (formData.get("contactPhone") as string)?.trim() || undefined,
    status: "active",
  };
  const parsed = locationSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const existing = await db.location.findFirst({
    where: { tenantId: ctx.tenantId, code: parsed.data.code },
  });
  if (existing) return { success: false, error: "A branch with this code already exists" };
  const limit = await checkPackageLimit(ctx.tenantId, "locations");
  if (!limit.allowed) return { success: false, error: limit.message ?? "Package limit reached" };
  const branch = await db.location.create({
    data: { ...parsed.data, tenantId: ctx.tenantId },
  });
  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "branch.created",
    entityType: "location",
    entityId: branch.id,
    details: { name: branch.name, code: branch.code },
  });
  revalidatePath("/susu/admin/branches");
  return { success: true, data: branch };
}

/** Update permitted branch details. Company-wide administrators only. */
export async function updateBranch(
  branchId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireCompanyAdmin();
  if (!(await assertTenantEntity("location", branchId, ctx))) {
    return { success: false, error: "Branch not found" };
  }
  const raw = {
    name: (formData.get("name") as string)?.trim(),
    code: (formData.get("code") as string)?.trim().toUpperCase(),
    description: (formData.get("description") as string)?.trim() || undefined,
    address: (formData.get("address") as string)?.trim() || undefined,
    contactPhone: (formData.get("contactPhone") as string)?.trim() || undefined,
    status: (formData.get("status") as string) || "active",
  };
  const parsed = locationSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const duplicate = await db.location.findFirst({
    where: { tenantId: ctx.tenantId, code: parsed.data.code, id: { not: branchId } },
  });
  if (duplicate) return { success: false, error: "A branch with this code already exists" };
  const branch = await db.location.update({ where: { id: branchId }, data: parsed.data });
  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "branch.updated",
    entityType: "location",
    entityId: branchId,
    details: { name: branch.name, status: branch.status },
  });
  revalidatePath("/susu/admin/branches");
  return { success: true, data: branch };
}

/**
 * Activate or deactivate a branch. Deactivation blocks new writes but never
 * erases or hides historical records. There is deliberately no delete path.
 */
export async function toggleBranchStatus(
  branchId: string,
  status: "active" | "inactive"
): Promise<ActionResponse> {
  const ctx = await requireCompanyAdmin();
  if (!(await assertTenantEntity("location", branchId, ctx))) {
    return { success: false, error: "Branch not found" };
  }
  const branch = await db.location.update({
    where: { id: branchId },
    data: { status },
  });
  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: status === "active" ? "branch.activated" : "branch.deactivated",
    entityType: "location",
    entityId: branchId,
    details: { status },
  });
  revalidatePath("/susu/admin/branches");
  return { success: true, data: branch };
}

/** Assign or change a user's branch membership. Company-wide administrators only. */
export async function setBranchMembership(input: {
  userId: string;
  branchId: string;
  role: "branch_manager" | "finance";
  status: "active" | "inactive";
}): Promise<ActionResponse> {
  const ctx = await requireCompanyAdmin();
  for (const [model, id] of [
    ["user", input.userId],
    ["location", input.branchId],
  ] as const) {
    if (!(await assertTenantEntity(model, id, ctx))) {
      return { success: false, error: "User or branch not found in this business" };
    }
  }
  if (!(await assertBranchAccess(ctx, input.branchId, "write"))) {
    return { success: false, error: "Branch is not available for assignment" };
  }
  const existing = await db.branchMembership.findUnique({
    where: {
      tenantId_userId_locationId_role: {
        tenantId: ctx.tenantId,
        userId: input.userId,
        locationId: input.branchId,
        role: input.role,
      },
    },
  });
  const membership = existing
    ? await db.branchMembership.update({
        where: { id: existing.id },
        data: { status: input.status },
      })
    : await db.branchMembership.create({
        data: {
          tenantId: ctx.tenantId,
          userId: input.userId,
          locationId: input.branchId,
          role: input.role,
          status: input.status,
        },
      });
  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "branch.membership_set",
    entityType: "branchMembership",
    entityId: membership.id,
    details: { role: input.role, branchId: input.branchId, status: input.status },
  });
  revalidatePath("/susu/admin/branches");
  return { success: true, data: membership };
}

/** Create a branch manager account with an explicit single-branch membership. */
export async function createBranchManager(formData: FormData): Promise<ActionResponse> {
  const ctx = await requireCompanyAdmin();
  const fullName = (formData.get("fullName") as string)?.trim();
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const password = formData.get("password") as string;
  const branchId = (formData.get("branchId") as string)?.trim();
  if (!fullName || !email || !password || !branchId) {
    return { success: false, error: "Name, email, password and branch are required" };
  }
  const policyError = validatePasswordPolicy(password);
  if (policyError) return { success: false, error: policyError };
  if (!(await assertTenantEntity("location", branchId, ctx))) {
    return { success: false, error: "Branch not found" };
  }
  if (await db.user.findUnique({ where: { email } })) {
    return { success: false, error: "A user with this email already exists" };
  }
  const created = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId: ctx.tenantId,
        email,
        fullName,
        role: "admin",
        status: "active",
        passwordHash: await hashPassword(password),
        susuEnabled: true,
        momoEnabled: false,
        emailVerified: false,
        forcePasswordReset: true,
      },
    });
    await tx.branchMembership.create({
      data: {
        tenantId: ctx.tenantId,
        userId: user.id,
        locationId: branchId,
        role: "branch_manager",
        status: "active",
      },
    });
    return user;
  });
  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "branch.manager_created",
    entityType: "user",
    entityId: created.id,
    details: { branchId },
  });
  await issueEmailVerification(created.id).catch(() => undefined);
  revalidatePath("/susu/admin/branches");
  return { success: true, data: created };
}
