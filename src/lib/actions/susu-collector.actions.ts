"use server";

import { db } from "@/lib/db";
import { getAdminSession, hashPassword } from "@/lib/auth";
import {
  requireTenantAdminSusu,
  requireTenantCollector,
  getTenantContext,
  assertTenantEntity,
} from "@/lib/tenant";
import { createAuditLog, createAuditLogTx } from "@/lib/audit";
import { issueEmailVerification } from "@/lib/security/account-tokens";
import { validatePasswordPolicy } from "@/lib/security/password-policy";
import { revalidatePath } from "next/cache";
import { createHash, randomBytes } from "crypto";
import { validateStatusTransition } from "@/lib/security/status";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { lockAccountForUpdate } from "@/lib/db-lock";
import {
  expectedRemittanceAmount,
  validateRemittanceAmount,
} from "@/lib/finance/remittance";
import { claimStepUpGrant, StepUpDeniedError } from "@/lib/security/step-up";
import { stepUpSessionBinding } from "@/lib/security/step-up";
import {
  consumeFinancialApproval,
  decideDualControl,
  recordSingleAdministratorException,
} from "@/lib/security/dual-control";

class RemittanceConflictError extends Error {
  constructor() {
    super("This idempotency key was already used with different remittance details.");
    this.name = "RemittanceConflictError";
  }
}

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
  /** Residual E: queued for approval by a different administrator. */
  requiresApproval?: boolean;
  approvalId?: string;
}

/** Next unused global customer identifier (see susu-customer.actions.ts). */
async function nextCustomerId(): Promise<string> {
  const total = await db.customer.count();
  for (let i = total + 1; i < total + 1000; i++) {
    const candidate = `BIK-C-${String(i).padStart(6, "0")}`;
    const taken = await db.customer.findUnique({
      where: { customerId: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `BIK-C-${Math.floor(Math.random() * 900000 + 100000)}`;
}

async function nextAccountId(): Promise<string> {
  const total = await db.susuAccount.count();
  for (let i = total + 1; i < total + 1000; i++) {
    const candidate = `BIK-S-${String(i).padStart(6, "0")}`;
    const taken = await db.susuAccount.findUnique({
      where: { accountId: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `BIK-S-${Math.floor(Math.random() * 900000 + 100000)}`;
}

/**
 * Create a new collector user and collector record, inside the tenant.
 */
export async function createCollector(
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const fullName = (formData.get("fullName") as string)?.trim();
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const phone = (formData.get("phone") as string)?.trim() || undefined;
  const password = formData.get("password") as string;

  if (!fullName || fullName.length < 2) {
    return { success: false, error: "Full name is required" };
  }
  if (!email) {
    return { success: false, error: "Email is required" };
  }
  if (!password) {
    return { success: false, error: "Password is required" };
  }
  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    return { success: false, error: policyError };
  }

  // Email is globally unique (login resolves by email with no tenant hint).
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return { success: false, error: "A user with this email already exists" };
  }

  const passwordHash = await hashPassword(password);

  const created = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId: ctx.tenantId,
        fullName,
        email,
        phone,
        role: "collector",
        status: "active",
        passwordHash,
        susuEnabled: true,
        forcePasswordReset: true,
        emailVerified: false,
      },
    });

    const collector = await tx.collector.create({
      data: { tenantId: ctx.tenantId, userId: user.id, status: "active" },
    });

    return { user, collector };
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.collector_created",
    entityType: "collector",
    entityId: created.collector.id,
    details: { fullName, email },
  });

  revalidatePath("/susu/admin/collectors");
  await issueEmailVerification(created.user.id).catch(() => undefined);
  return { success: true, data: created };
}

/**
 * Admin password reset for a collector's account.
 */
export async function resetCollectorPassword(
  collectorId: string,
  formData: FormData,
  stepUpToken?: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();


  if (!(await assertTenantEntity("collector", collectorId, ctx))) {
    return { success: false, error: "Collector not found" };
  }

  const collector = await db.collector.findFirst({
    where: { id: collectorId, tenantId: ctx.tenantId },
    select: { userId: true },
  });
  if (!collector) {
    return { success: false, error: "Collector not found" };
  }

  const newPassword = formData.get("newPassword") as string;
  const policyError = validatePasswordPolicy(newPassword ?? "");
  if (policyError) {
    return { success: false, error: policyError };
  }

  const passwordHash = await hashPassword(newPassword);

  const steppedUp = await db.$transaction(async (tx) => {
    const grant = await claimStepUpGrant(tx, {
      token: stepUpToken,
      subjectType: "user",
      subjectId: ctx.userId,
      sessionId: stepUpSessionBinding(session, ctx.userId),
      purpose: "collector.password_reset",
      targetType: "collector",
      targetId: collectorId,
    });
    if (!grant.ok) return false;
    await tx.user.update({
      where: { id: collector.userId },
      data: {
        passwordHash,
        forcePasswordReset: true,
        tokenVersion: { increment: 1 },
      },
    });
    return true;
  });
  if (!steppedUp) {
    return {
      success: false,
      error: "Reauthentication expired or does not match this operation. Confirm your password again.",
    };
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "user.password_reset",
    entityType: "user",
    entityId: collector.userId,
    details: { sessionsInvalidated: true, viaCollectorId: collectorId },
  });

  revalidatePath("/susu/admin/collectors");
  return { success: true };
}

/**
 * Toggle a person's MoMo module capability from the collectors page.
 *
 * Module capability is a USER flag; the tenant must independently have MoMo
 * enabled. Both are required.
 */
export async function setMomoCapability(
  userId: string,
  enabled: boolean,
  locationId?: string,
  stepUpToken?: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const capabilitySession = await getAdminSession();


  if (enabled && !ctx.momoEnabled) {
    return {
      success: false,
      error: "This business is not enrolled for the MoMo module.",
    };
  }

  const target = await db.user.findFirst({
    where: { id: userId, tenantId: ctx.tenantId },
    select: { id: true, role: true, momoEnabled: true },
  });
  if (!target || target.role === "admin") {
    return { success: false, error: "User not found" };
  }
  if (target.momoEnabled === enabled) {
    return { success: true };
  }

  if (enabled) {
    if (!locationId) {
      return {
        success: false,
        error: "An assigned location is required to enable MoMo",
      };
    }
    if (!(await assertTenantEntity("location", locationId, ctx))) {
      return {
        success: false,
        error: "Selected location does not exist or is inactive",
      };
    }
    const location = await db.location.findFirst({
      where: { id: locationId, tenantId: ctx.tenantId, status: "active" },
    });
    if (!location) {
      return {
        success: false,
        error: "Selected location does not exist or is inactive",
      };
    }
  }

  const applied = await db.$transaction(async (tx) => {
    const grant = await claimStepUpGrant(tx, {
      token: stepUpToken,
      subjectType: "user",
      subjectId: ctx.userId,
      sessionId: stepUpSessionBinding(capabilitySession, ctx.userId),
      purpose: "capability.change",
      targetType: "module_capability",
      targetId: `${userId}:momo:${enabled ? "on" : "off"}`,
    });
    if (!grant.ok) return false;
    await tx.user.update({
      where: { id: userId },
      data: {
        momoEnabled: enabled,
        ...(enabled ? { locationId } : {}),
        tokenVersion: { increment: 1 },
      },
    });
    return true;
  });
  if (!applied) {
    return {
      success: false,
      error: "Reauthentication expired or does not match this operation. Confirm your password again.",
    };
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "user.module_assignment_changed",
    entityType: "user",
    entityId: userId,
    details: { module: "momo", enabled, ...(locationId ? { locationId } : {}) },
  });

  revalidatePath("/susu/admin/collectors");
  revalidatePath("/admin/workers");
  return { success: true };
}

/**
 * Toggle collector status (activate/deactivate).
 */
export async function toggleCollectorStatus(
  collectorId: string,
  newStatus: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const collector = await db.collector.findFirst({
    where: { id: collectorId, tenantId: ctx.tenantId },
    select: { id: true, userId: true },
  });
  if (!collector) {
    return { success: false, error: "Collector not found" };
  }
  const current = await db.user.findFirst({
    where: { id: collector.userId, tenantId: ctx.tenantId },
    select: { status: true },
  });
  if (!current) return { success: false, error: "Collector not found" };
  const check = validateStatusTransition(current.status, newStatus);
  if (!check.ok) return { success: false, error: check.error };

  await db.$transaction(async (tx) => {
    await tx.collector.update({
      where: { id: collectorId },
      data: { status: check.status },
    });
    await tx.user.update({
      where: { id: collector.userId },
      data: { status: check.status, tokenVersion: { increment: 1 } },
    });
  });

  await createAuditLog({
    userId: ctx.userId,
    action: `susu.collector_${newStatus === "active" ? "activated" : "deactivated"}`,
    entityType: "collector",
    entityId: collectorId,
  });

  revalidatePath("/susu/admin/collectors");
  return { success: true };
}

/**
 * Assign a customer to a collector. All three ids must be same-tenant.
 */
export async function assignCustomerToCollector(params: {
  collectorId: string;
  customerId: string;
  accountId: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const { collectorId, customerId, accountId } = params;

  for (const [model, id] of [
    ["collector", collectorId],
    ["customer", customerId],
    ["susuAccount", accountId],
  ] as const) {
    if (!(await assertTenantEntity(model, id, ctx))) {
      return { success: false, error: "Record not found" };
    }
  }

  const existing = await db.collectorCustomerAssignment.findUnique({
    where: { collectorId_accountId: { collectorId, accountId } },
  });

  if (existing) {
    if (existing.active) {
      return {
        success: false,
        error: "Customer is already assigned to this collector",
      };
    }
    await db.collectorCustomerAssignment.update({
      where: { id: existing.id },
      data: { active: true },
    });
  } else {
    await db.collectorCustomerAssignment.create({
      data: { tenantId: ctx.tenantId, collectorId, customerId, accountId },
    });
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.customer_assigned_to_collector",
    entityType: "collector_assignment",
    entityId: collectorId,
    details: { customerId, accountId },
  });

  revalidatePath("/susu/admin/customers");
  revalidatePath("/susu/admin/collectors");
  return { success: true };
}

/**
 * Remove customer from collector.
 */
export async function removeCustomerFromCollector(
  assignmentId: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  if (!(await assertTenantEntity("collectorCustomerAssignment", assignmentId, ctx))) {
    return { success: false, error: "Assignment not found" };
  }

  await db.collectorCustomerAssignment.update({
    where: { id: assignmentId },
    data: { active: false, unassignedAt: new Date() },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.customer_removed_from_collector",
    entityType: "collector_assignment",
    entityId: assignmentId,
  });

  revalidatePath("/susu/admin/customers");
  revalidatePath("/susu/admin/collectors");
  return { success: true };
}

/**
 * Record a collector remittance (bringing collected money to office).
 */
export async function recordRemittance(params: {
  collectorId: string;
  remittedAmount: number;
  notes?: string;
  /** SEC-06: client-generated key that makes retries return the original row. */
  idempotencyKey?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const { collectorId, remittedAmount, notes } = params;

  // SEC-06: reject anything that is not a finite, positive, two-decimal money
  // value. `NaN <= 0` is false, so a bare sign check let NaN through.
  const amount = validateRemittanceAmount(remittedAmount);
  if (!amount.ok) {
    return { success: false, error: amount.error };
  }
  const remitted = amount.value;

  const rawKey = params.idempotencyKey;
  if (rawKey !== undefined && !/^[A-Za-z0-9:_-]{8,120}$/.test(rawKey)) {
    return { success: false, error: "Invalid idempotency key." };
  }
  const idempotencyKey = rawKey ? `REM-${rawKey}` : null;
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        collectorId,
        amountMinor: String(Math.round(remitted * 100)),
        notes: notes?.trim() ?? "",
      })
    )
    .digest("hex");

  const rate = await consumeRateLimit(
    "finance:remittance_record",
    `${ctx.tenantId}:${ctx.userId}`,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many financial actions. Please wait and try again." };
  }

  if (!(await assertTenantEntity("collector", collectorId, ctx))) {
    return { success: false, error: "Collector not found" };
  }

  const collector = await db.collector.findFirst({
    where: { id: collectorId, tenantId: ctx.tenantId },
  });
  if (!collector) return { success: false, error: "Collector not found" };

  const remittance = await db.$transaction(async (tx) => {
    // Serialize remittance recording for this collector so two concurrent
    // submissions cannot both compute the same expected amount from the same
    // anchor and insert twice.
    await lockAccountForUpdate(tx, `collector-remittance:${collectorId}`);

    if (idempotencyKey) {
      const existing = await tx.collectorRemittance.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new RemittanceConflictError();
        }
        return existing;
      }
    }

    const existingRemittances = await tx.collectorRemittance.findMany({
      where: { collectorId, tenantId: ctx.tenantId, reversedAt: null },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 1,
    });

    const lastRemittanceDate =
      existingRemittances.length > 0
        ? existingRemittances[0].createdAt
        : new Date(0);

    // Reversed contributions were never actually collected, so they must not
    // inflate the expected cash handover.
    const unremittedContributions = await tx.contribution.findMany({
      where: {
        collectorId,
        tenantId: ctx.tenantId,
        collectionDate: { gt: lastRemittanceDate },
        reversedAt: null,
      },
    });

    const expectedAmount = expectedRemittanceAmount(unremittedContributions);
    const variance = expectedAmount - remitted;
    const referenceId = `REM-${randomBytes(8).toString("hex")}`;

    const remittance = await tx.collectorRemittance.create({
      data: {
        tenantId: ctx.tenantId,
        collectorId,
        expectedAmount,
        remittedAmount: remitted,
        variance,
        status: variance === 0 ? "reconciled" : "discrepancy",
        recordedById: ctx.userId,
        referenceId,
        idempotencyKey,
        requestHash,
        notes,
      },
    });

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.remittance_recorded",
      entityType: "remittance",
      entityId: remittance.id,
      details: {
        collectorId,
        expectedAmount: Number(remittance.expectedAmount),
        remittedAmount: Number(remittance.remittedAmount),
        variance: Number(remittance.variance),
      },
    });

    return remittance;
  }).catch(async (error) => {
    if (error instanceof RemittanceConflictError) return null;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002" &&
      idempotencyKey
    ) {
      const existing = await db.collectorRemittance.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new RemittanceConflictError();
        return existing;
      }
    }
    throw error;
  });

  if (!remittance) {
    return {
      success: false,
      error:
        "This idempotency key was already used with different remittance details.",
    };
  }

  revalidatePath("/susu/admin/remittances");
  revalidatePath("/susu/admin/collectors");
  return { success: true, data: remittance };
}

/**
 * Reverse a recorded remittance.
 *
 * A remittance is a cash-handover observation, not a ledger posting. Reversal
 * marks the original row as reversed (never deletes it) and removes it from the
 * "last remittance" anchor and cash-handover totals, so contributions after the
 * previous active remittance become expected again. No balance is rewritten and
 * no negative row is inserted.
 */
export async function reverseRemittance(params: {
  remittanceId: string;
  reason: string;
  stepUpToken?: string;
  approvalId?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const remittanceSession = await getAdminSession();

  const reason = params.reason?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    return {
      success: false,
      error: "Enter a reversal reason of at least 10 characters.",
    };
  }

  const rate = await consumeRateLimit(
    "finance:remittance_reversal",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many correction requests. Please wait." };
  }

  const original = await db.collectorRemittance.findFirst({
    where: { id: params.remittanceId, tenantId: ctx.tenantId },
  });
  if (!original) return { success: false, error: "Remittance not found." };
  if (original.reversedAt) {
    return { success: false, error: "This remittance has already been reversed." };
  }

  const dual = await decideDualControl(
    {
      tenantId: ctx.tenantId,
      action: "susu.remittance.reverse",
      targetType: "remittance",
      targetId: original.id,
      amountMinor: Math.round(Number(original.remittedAmount) * 100),
      reason,
      requesterId: ctx.userId,
    },
    params.approvalId
  );
  if (dual.kind === "denied") return { success: false, error: dual.error };
  if (dual.kind === "pending") {
    return {
      success: false,
      requiresApproval: true,
      approvalId: dual.approvalId,
      error:
        "This correction needs approval from a different administrator before it is posted.",
    };
  }

  let updatedCount = 0;
  await db.$transaction(async (tx) => {
    const grant = await claimStepUpGrant(tx, {
      token: params.stepUpToken,
      subjectType: "user",
      subjectId: ctx.userId,
      sessionId: stepUpSessionBinding(remittanceSession, ctx.userId),
      purpose: "susu.remittance.reverse",
      targetType: "remittance",
      targetId: original.id,
    });
    if (!grant.ok) throw new StepUpDeniedError(grant.error);

    if (!dual.exceptionUsed) {
      const consumed = await consumeFinancialApproval(tx, params.approvalId!, {
        tenantId: ctx.tenantId,
        action: "susu.remittance.reverse",
        targetId: original.id,
        requesterId: ctx.userId,
      });
      if (!consumed) throw new Error("APPROVAL_INVALID");
    }
    const updated = await tx.collectorRemittance.updateMany({
      where: {
        id: original.id,
        tenantId: ctx.tenantId,
        reversedAt: null,
      },
      data: {
        status: "reversed",
        reversedAt: new Date(),
        reversedById: ctx.userId,
        reversalReason: reason,
      },
    });
    updatedCount = updated.count;

    if (updated.count === 1) {
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "susu.remittance_reversed",
        entityType: "remittance",
        entityId: original.id,
        details: {
          collectorId: original.collectorId,
          expectedAmount: Number(original.expectedAmount),
          remittedAmount: Number(original.remittedAmount),
          variance: Number(original.variance),
          reason,
        },
      });
    }
  }).catch((error) => {
    if (error instanceof StepUpDeniedError) {
      updatedCount = -1;
      return;
    }
    if (error instanceof Error && error.message === "APPROVAL_INVALID") {
      updatedCount = -2;
      return;
    }
    throw error;
  });
  if (updatedCount === -1) {
    return {
      success: false,
      error: "Reauthentication expired or does not match this operation. Confirm your password again.",
    };
  }
  if (updatedCount === -2) {
    return {
      success: false,
      error:
        "This approval expired or was already used. Ask a second administrator to approve it again.",
    };
  }
  if (updatedCount !== 1) {
    return { success: false, error: "This remittance has already been reversed." };
  }

  if (dual.exceptionUsed) {
    await recordSingleAdministratorException({
      tenantId: ctx.tenantId,
      action: "susu.remittance.reverse",
      targetType: "remittance",
      targetId: original.id,
      amountMinor: Math.round(Number(original.remittedAmount) * 100),
      reason,
      requesterId: ctx.userId,
    });
  }

  revalidatePath("/susu/admin/remittances");
  revalidatePath("/susu/admin/collectors");
  revalidatePath("/susu/admin/history");
  revalidatePath("/susu/admin");
  revalidatePath("/collector/dashboard");
  return { success: true };
}

/**
 * Get all collectors with their stats (tenant scoped).
 */
export async function getCollectors() {
  const ctx = await requireTenantAdminSusu();

  return db.collector.findMany({
    where: { tenantId: ctx.tenantId },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          status: true,
        },
      },
      assignments: { where: { active: true, tenantId: ctx.tenantId } },
      contributions: {
        where: {
          tenantId: ctx.tenantId,
          collectionDate: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      },
      remittances: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Get collector by ID with full details (tenant scoped).
 */
export async function getCollectorById(id: string) {
  const ctx = await requireTenantAdminSusu();

  return db.collector.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          status: true,
        },
      },
      assignments: {
        where: { active: true, tenantId: ctx.tenantId },
        include: { customer: true, account: true },
      },
      contributions: {
        where: { tenantId: ctx.tenantId },
        orderBy: { collectionDate: "desc" },
        take: 20,
        include: {
          account: {
            include: {
              customer: { select: { fullName: true, customerId: true } },
            },
          },
        },
      },
      remittances: {
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });
}

/**
 * Get remittances with filters (tenant scoped).
 */
export async function getRemittances(params?: {
  page?: number;
  limit?: number;
  collectorId?: string;
  status?: string;
}) {
  const ctx = await requireTenantAdminSusu();

  const page = params?.page || 1;
  const limit = params?.limit || 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (params?.collectorId) where.collectorId = params.collectorId;
  if (params?.status) where.status = params.status;

  const [remittances, total] = await Promise.all([
    db.collectorRemittance.findMany({
      where,
      include: {
        collector: { include: { user: { select: { fullName: true } } } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.collectorRemittance.count({ where }),
  ]);

  return {
    remittances,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Register a new customer by a collector.
 *
 * The collector identity is derived from the session (never browser input) and
 * the new customer is created inside the collector's tenant.
 */
export async function registerCustomerByCollector(params: {
  fullName: string;
  phone?: string;
  address?: string;
  dailyContribution: number;
  cardFee?: number;
}): Promise<ActionResponse> {
  // Resolve non-redirecting: this action must return an error response rather
  // than throw, so an admin or signed-out caller gets an actionable message.
  // Any staff module session can identify the caller; only an active Collector
  // record in the caller's tenant authorizes registration.
  const ctx =
    (await getTenantContext("susu", "susu")) ??
    (await getTenantContext("admin", "susu")) ??
    (await getTenantContext("momo", "susu"));
  if (!ctx) {
    return { success: false, error: "Please sign in again." };
  }

  const collector = await db.collector.findFirst({
    where: { userId: ctx.userId, tenantId: ctx.tenantId, status: "active" },
    select: { id: true },
  });
  if (!collector) {
    return {
      success: false,
      error: "Only Susu collectors can register customers.",
    };
  }

  const { fullName, phone, address, dailyContribution, cardFee = 10 } = params;

  if (!fullName || fullName.length < 2) {
    return { success: false, error: "Full name must be at least 2 characters" };
  }
  if (!dailyContribution || dailyContribution <= 0) {
    return { success: false, error: "Daily contribution must be greater than 0" };
  }

  // Duplicate check is tenant scoped: the same phone may exist in another
  // business without blocking this one.
  if (phone) {
    const normalizedPhone = phone.replace(/[^\d]/g, "");
    if (normalizedPhone.length >= 9) {
      const existingCustomer = await db.customer.findFirst({
        where: {
          tenantId: ctx.tenantId,
          phone: { contains: normalizedPhone.slice(-9) },
          status: "active",
        },
      });
      if (existingCustomer) {
        return {
          success: false,
          error:
            "A customer with this phone number already exists. Please check before creating another account.",
        };
      }
    }
  }

  const customerId = await nextCustomerId();
  const accountId = await nextAccountId();

  const result = await db.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        tenantId: ctx.tenantId,
        customerId,
        fullName,
        phone,
        address,
        status: "active",
      },
    });

    const susuAccount = await tx.susuAccount.create({
      data: {
        tenantId: ctx.tenantId,
        accountId,
        customerId: customer.id,
        dailyContribution,
        status: "active",
        cardCustody: "customer",
      },
    });

    const now = new Date();
    const cycleStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const cycleEnd = new Date(now.getFullYear(), now.getMonth(), 31);

    await tx.susuCycle.create({
      data: {
        tenantId: ctx.tenantId,
        accountId: susuAccount.id,
        cycleNumber: 1,
        startDate: cycleStart,
        endDate: cycleEnd,
        dailyContribution,
        status: "active",
        commissionCharged: false,
      },
    });

    await tx.cardFee.create({
      data: {
        tenantId: ctx.tenantId,
        accountId: susuAccount.id,
        amount: cardFee,
        recordedById: ctx.userId,
        notes: "Initial card purchase",
      },
    });

    await tx.collectorCustomerAssignment.create({
      data: {
        tenantId: ctx.tenantId,
        collectorId: collector.id,
        customerId: customer.id,
        accountId: susuAccount.id,
        active: true,
      },
    });

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.customer_created_by_collector",
      entityType: "customer",
      entityId: customer.id,
      details: {
        customerId: customer.customerId,
        fullName: customer.fullName,
        dailyContribution,
        collectorId: collector.id,
        collectorName: ctx.userId,
      },
    });

    return { customer, susuAccount };
  });

  revalidatePath("/collector/dashboard");
  revalidatePath("/susu/admin/customers");

  return {
    success: true,
    data: {
      customer: result.customer,
      susuAccount: result.susuAccount,
      collectorId: collector.id,
    },
  };
}

export * from "./susu-remittance.actions";
