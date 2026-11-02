"use server";

import { db } from "@/lib/db";
import {
  requireTenantAdminSusu,
  requireTenantCollector,
  assertTenantEntity,
  type TenantContext,
} from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { lockAccountForUpdate } from "@/lib/db-lock";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Resolve the acting context for a contribution.
 *
 * Admin sessions take precedence so a leftover collector cookie cannot shadow
 * an administrator entering an office payment. Both paths resolve a TENANT, and
 * every referenced entity (account, collector, staff) is verified to belong to
 * that tenant before use.
 */
async function resolveContributionActor(): Promise<
  | { ok: true; ctx: TenantContext; isAdmin: boolean }
  | { ok: false; error: string }
> {
  const adminCtx = await requireTenantAdminSusu().catch(() => null);
  if (adminCtx) return { ok: true, ctx: adminCtx, isAdmin: true };

  const collectorCtx = await requireTenantCollector().catch(() => null);
  if (collectorCtx) return { ok: true, ctx: collectorCtx, isAdmin: false };

  return { ok: false, error: "Not authenticated. Please sign in again." };
}

/**
 * Record a contribution and allocate it across outstanding days in the cycle.
 *
 * Tenant isolation:
 *   * The account must belong to the authenticated tenant.
 *   * A collector can only record against customers assigned to them.
 *   * Admin-selected collector / recorder / receiver ids are all re-verified
 *     against the tenant, so a foreign id cannot be substituted in.
 */
export async function recordContribution(params: {
  accountId: string;
  amount: number;
  channel: "collector" | "direct_office";
  collectorId?: string;
  receivedById?: string;
  receivedByName?: string;
  recordedById?: string;
  recordedByName?: string;
  notes?: string;
  /** Client-generated retry key. The same key never records twice. */
  idempotencyKey?: string;
}): Promise<ActionResponse> {
  const {
    accountId,
    amount,
    channel,
    collectorId,
    receivedById,
    receivedByName,
    recordedById: clientRecordedById,
    recordedByName,
    notes,
    idempotencyKey,
  } = params;

  // ── 1. Authenticate + resolve tenant ────────────────────────────────
  const actor = await resolveContributionActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx, isAdmin } = actor;

  // ── 2. Validate amount ──────────────────────────────────────────────
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return {
      success: false,
      error: "Contribution amount must be greater than 0",
    };
  }
  if (amount > 999999.99 || Math.abs(Math.round(amount * 100) / 100 - amount) > 1e-9) {
    return {
      success: false,
      error: "Enter a valid contribution amount (maximum two decimal places)",
    };
  }

  // ── 3. Derive collector identity ────────────────────────────────────
  let effectiveCollectorId: string | null = null;
  let recordedById: string;

  if (channel === "collector") {
    if (isAdmin && collectorId) {
      // Admin recording on behalf of a collector — the collector must belong
      // to this tenant.
      if (!(await assertTenantEntity("collector", collectorId, ctx))) {
        return { success: false, error: "Selected collector not found" };
      }
      effectiveCollectorId = collectorId;
      recordedById = ctx.userId;
    } else {
      // Collector: derive from the canonical session resolution, never input.
      const collector = await db.collector.findFirst({
        where: { userId: ctx.userId, tenantId: ctx.tenantId, status: "active" },
        select: { id: true },
      });
      if (!collector) {
        return {
          success: false,
          error:
            "Collector identity is required for collector-channel contributions",
        };
      }
      effectiveCollectorId = collector.id;
      recordedById = ctx.userId;
    }
  } else {
    // direct_office — administrators only
    if (!isAdmin) {
      return {
        success: false,
        error: "Only administrators can record office contributions",
      };
    }
    if (clientRecordedById) {
      const recordedByUser = await db.user.findFirst({
        where: { id: clientRecordedById, tenantId: ctx.tenantId },
      });
      if (!recordedByUser) {
        return { success: false, error: "Selected recorder staff member not found" };
      }
      if (recordedByUser.status !== "active") {
        return { success: false, error: "Selected recorder staff member is not active" };
      }
      if (!["admin", "worker", "collector"].includes(recordedByUser.role)) {
        return {
          success: false,
          error: "Selected recorder is not an authorized staff member",
        };
      }
      recordedById = clientRecordedById;
    } else {
      recordedById = ctx.userId;
    }
  }

  // ── 3b. Authoritative recordedByName ────────────────────────────────
  // Identity anchor (recordedById) is always session-derived; the display name
  // is the business-typed name when supplied, else the resolved user's name.
  const recorderUser = await db.user.findFirst({
    where: { id: recordedById, tenantId: ctx.tenantId },
    select: { fullName: true },
  });
  const effectiveRecordedByName =
    recordedByName?.trim() || recorderUser?.fullName || null;

  // ── 4. Fetch account — TENANT SCOPED ────────────────────────────────
  const account = await db.susuAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: {
      cycles: { where: { status: "active" }, take: 1 },
      customer: true,
    },
  });

  if (!account) {
    return { success: false, error: "Susu account not found" };
  }
  if (account.status !== "active") {
    return { success: false, error: "Account is not active" };
  }
  if (!account.cycles.length) {
    return { success: false, error: "No active cycle found for this account" };
  }

  // ── 5. Collector may only record for assigned customers ─────────────
  if (effectiveCollectorId) {
    const assignment = await db.collectorCustomerAssignment.findFirst({
      where: {
        collectorId: effectiveCollectorId,
        accountId,
        active: true,
        tenantId: ctx.tenantId,
      },
    });
    if (!assignment) {
      return {
        success: false,
        error: "This customer is not assigned to the collector.",
      };
    }
  }

  const cycle = account.cycles[0];
  const dailyContribution = Number(cycle.dailyContribution);
  if (!Number.isFinite(dailyContribution) || dailyContribution <= 0) {
    return { success: false, error: "Account has an invalid contribution rate" };
  }
  const daysCovered = amount / dailyContribution;
  if (!Number.isInteger(daysCovered) || daysCovered < 1 || daysCovered > 31) {
    return {
      success: false,
      error: "Amount must equal a whole number of contribution days",
    };
  }

  const rate = await consumeRateLimit(
    "finance:contribution",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return {
      success: false,
      error: "Too many contribution requests. Please wait and try again.",
    };
  }

  // ── 6. Receiver for direct_office ───────────────────────────────────
  let effectiveReceivedById: string | null = null;
  let effectiveReceivedByName: string | null = null;
  if (channel === "direct_office") {
    if (receivedById) {
      const receivedByUser = await db.user.findFirst({
        where: { id: receivedById, tenantId: ctx.tenantId },
      });
      if (!receivedByUser) {
        return { success: false, error: "Selected staff member not found" };
      }
      if (receivedByUser.status !== "active") {
        return { success: false, error: "Selected staff member is not active" };
      }
      if (!["admin", "worker", "collector"].includes(receivedByUser.role)) {
        return {
          success: false,
          error: "Selected receiver is not an authorized staff member",
        };
      }
      effectiveReceivedById = receivedById;
      // A validated staff id is authoritative for the receiver's name.
      effectiveReceivedByName = receivedByUser.fullName;
    } else {
      // No staff selected: default the receiver anchor to the person recording
      // the payment; the business may still type the receiver's name at the
      // office (free text), which the statement displays in preference.
      effectiveReceivedById = recordedById;
      if (receivedByName?.trim()) {
        effectiveReceivedByName = receivedByName.trim();
      } else {
        const defaultReceiver = await db.user.findFirst({
          where: { id: recordedById, tenantId: ctx.tenantId },
          select: { fullName: true },
        });
        effectiveReceivedByName = defaultReceiver?.fullName || null;
      }
    }
  }

  // ── 7. Idempotency key ──────────────────────────────────────────────
  const referenceId =
    idempotencyKey && /^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)
      ? `CON-${idempotencyKey}`
      : `CON-${randomBytes(8).toString("hex")}`;

  // ── 8. Financial transaction ────────────────────────────────────────
  const outcome = await db.$transaction(async (tx) => {
    await lockAccountForUpdate(tx, account.id);
    // Re-check outstanding days inside the transaction so a concurrent
    // contribution cannot allocate the same day twice.
    const existingAllocations = await tx.contributionAllocation.findMany({
      where: {
        contribution: { cycleId: cycle.id, reversedAt: null },
        tenantId: ctx.tenantId,
      },
    });
    const paidDays = new Set(existingAllocations.map((a) => a.cycleDay));

    const daysToAllocate: number[] = [];
    for (let day = 1; day <= 31 && daysToAllocate.length < daysCovered; day++) {
      if (!paidDays.has(day)) daysToAllocate.push(day);
    }
    if (daysToAllocate.length < daysCovered) {
      throw new Error(
        "This cycle does not have enough unpaid days for that amount"
      );
    }

    const contribution = await tx.contribution.create({
      data: {
        tenantId: ctx.tenantId,
        accountId: account.id,
        cycleId: cycle.id,
        amount,
        collectionDate: new Date(),
        channel,
        collectorId: effectiveCollectorId,
        recordedById,
        recordedByName: effectiveRecordedByName,
        receivedById: effectiveReceivedById,
        receivedByName: effectiveReceivedByName,
        referenceId,
        notes,
      },
    });

    const allocatedAmount =
      Math.round(daysCovered * dailyContribution * 100) / 100;

    await tx.contributionAllocation.createMany({
      data: daysToAllocate.map((day) => ({
        tenantId: ctx.tenantId,
        contributionId: contribution.id,
        cycleDay: day,
        amount: dailyContribution,
      })),
    });

    return {
      contribution,
      daysAllocated: daysToAllocate.length,
      allocatedAmount,
      totalDaysPaid: paidDays.size + daysToAllocate.length,
    };
  }).then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error }));

  if (!outcome.ok) {
    const code =
      typeof outcome.error === "object" &&
      outcome.error !== null &&
      "code" in outcome.error
        ? (outcome.error as { code?: string }).code
        : undefined;
    return {
      success: false,
      error:
        code === "P2002"
          ? "This contribution was already recorded."
          : outcome.error instanceof Error
            ? outcome.error.message
            : "Contribution could not be recorded",
    };
  }
  const result = outcome.value;

  // ── 9. Audit ────────────────────────────────────────────────────────
  await createAuditLog({
    userId: ctx.userId,
    action: "susu.contribution_recorded",
    entityType: "contribution",
    entityId: result.contribution.id,
    details: {
      accountId,
      amount,
      channel,
      collectorId: effectiveCollectorId,
      receivedById: effectiveReceivedById,
      receivedByName: effectiveReceivedByName,
      recordedById,
      recordedByName: effectiveRecordedByName,
      authenticatedActorId: ctx.userId,
      daysAllocated: result.daysAllocated,
      allocatedAmount: result.allocatedAmount,
      referenceId,
    },
  });

  revalidatePath("/susu/admin/contributions");
  revalidatePath("/susu/admin/customers");
  revalidatePath("/susu/admin");
  revalidatePath("/collector/dashboard");

  return {
    success: true,
    data: {
      contributionId: result.contribution.id,
      daysAllocated: result.daysAllocated,
      allocatedAmount: Number(result.allocatedAmount),
      referenceId,
      receivedById: effectiveReceivedById,
    },
  };
}

export async function getContributions(params?: {
  page?: number;
  limit?: number;
  accountId?: string;
  cycleId?: string;
  channel?: string;
  dateFrom?: string;
  dateTo?: string;
  collectorId?: string;
}) {
  const ctx = await requireTenantAdminSusu();

  const page = params?.page || 1;
  const limit = params?.limit || 20;
  const skip = (page - 1) * limit;

  // Tenant scope is always applied.
  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (params?.accountId) where.accountId = params.accountId;
  if (params?.cycleId) where.cycleId = params.cycleId;
  if (params?.channel) where.channel = params.channel;
  if (params?.collectorId) where.collectorId = params.collectorId;

  if (params?.dateFrom || params?.dateTo) {
    where.collectionDate = {};
    const dateRange = where.collectionDate as Record<string, Date>;
    if (params.dateFrom)
      dateRange.gte = new Date(params.dateFrom + "T00:00:00.000Z");
    if (params.dateTo)
      dateRange.lte = new Date(params.dateTo + "T23:59:59.999Z");
  }

  const [contributions, total] = await Promise.all([
    db.contribution.findMany({
      where,
      include: {
        account: {
          include: {
            customer: { select: { customerId: true, fullName: true } },
          },
        },
        allocations: true,
        collector: { include: { user: { select: { fullName: true } } } },
        recordedBy: { select: { fullName: true } },
        receivedBy: { select: { fullName: true } },
      },
      orderBy: { collectionDate: "desc" },
      skip,
      take: limit,
    }),
    db.contribution.count({ where }),
  ]);

  return {
    contributions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** Contribution summary for a specific cycle, scoped to the tenant. */
export async function getCycleContributionSummary(cycleId: string) {
  const ctx = await requireTenantAdminSusu();

  const cycle = await db.susuCycle.findFirst({
    where: { id: cycleId, tenantId: ctx.tenantId },
    include: {
      contributions: {
        include: { allocations: true },
        orderBy: { collectionDate: "asc" },
      },
    },
  });

  if (!cycle) return null;

  const totalContributed = cycle.contributions.reduce(
    (sum, c) => sum + Number(c.amount),
    0
  );
  const totalAllocated = cycle.contributions.reduce(
    (sum, c) =>
      sum + c.allocations.reduce((aSum, a) => aSum + Number(a.amount), 0),
    0
  );
  const allocatedDays = new Set(
    cycle.contributions.flatMap((c) => c.allocations.map((a) => a.cycleDay))
  ).size;

  return {
    cycle,
    totalContributed,
    totalAllocated,
    allocatedDays,
    remainingDays: 31 - allocatedDays,
  };
}
