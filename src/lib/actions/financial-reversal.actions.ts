"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { lockAccountForUpdate } from "@/lib/db-lock";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

export interface ReversalResponse {
  success: boolean;
  error?: string;
  reversalId?: string;
}

function reference(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

/**
 * Reverse a posted withdrawal.
 *
 * The original row is never deleted or rewritten. A compensating withdrawal
 * with negative amounts is posted, the original is marked reversed, and a
 * negative commission is written when the original charged one. The unique
 * `reversalOfId` index makes a second reversal impossible.
 */
export async function reverseWithdrawal(input: {
  withdrawalId: string;
  reason: string;
}): Promise<ReversalResponse> {
  const ctx = await requireTenantAdminSusu();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reversal reason of at least 10 characters." };
  }

  const rate = await consumeRateLimit(
    "finance:reversal",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many correction requests. Please wait." };
  }

  const original = await db.withdrawal.findFirst({
    where: { id: input.withdrawalId, tenantId: ctx.tenantId },
  });
  if (!original) return { success: false, error: "Withdrawal not found." };
  if (original.status !== "completed") {
    return { success: false, error: "Only a completed withdrawal can be reversed." };
  }
  if (original.reversalOfId) {
    return { success: false, error: "A reversal entry cannot itself be reversed." };
  }
  if (original.reversedAt) {
    return { success: false, error: "This withdrawal has already been reversed." };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, original.accountId);

      const already = await tx.withdrawal.findFirst({
        where: { reversalOfId: original.id },
        select: { id: true },
      });
      if (already) throw new Error("ALREADY_REVERSED");

      // Balance after the reversal (for the record only; sums are the ledger).
      const contributed = await tx.contribution.aggregate({
        where: { cycleId: original.cycleId, tenantId: ctx.tenantId },
        _sum: { amount: true },
      });
      const withdrawn = await tx.withdrawal.aggregate({
        where: { cycleId: original.cycleId, tenantId: ctx.tenantId },
        _sum: { netAmount: true },
      });
      const commissions = await tx.commission.aggregate({
        where: { cycleId: original.cycleId, tenantId: ctx.tenantId },
        _sum: { amount: true },
      });
      const balanceAfter =
        Number(contributed._sum.amount ?? 0) -
        Number(withdrawn._sum.netAmount ?? 0) -
        Number(commissions._sum.amount ?? 0) +
        Number(original.netAmount);

      const reversal = await tx.withdrawal.create({
        data: {
          tenantId: ctx.tenantId,
          accountId: original.accountId,
          cycleId: original.cycleId,
          requestedAmount: -Number(original.requestedAmount),
          commissionAmount: -Number(original.commissionAmount),
          netAmount: -Number(original.netAmount),
          remainingBalance: balanceAfter,
          status: "reversal",
          authorizedById: ctx.userId,
          referenceId: reference("REV-W"),
          reversalOfId: original.id,
          notes: reason,
        },
      });

      if (Number(original.commissionAmount) > 0) {
        await tx.commission.create({
          data: {
            tenantId: ctx.tenantId,
            accountId: original.accountId,
            cycleId: original.cycleId,
            amount: -Number(original.commissionAmount),
            basis: "reversal",
            triggeredBy: "withdrawal_reversal",
            recordedById: ctx.userId,
          },
        });
      }

      await tx.withdrawal.update({
        where: { id: original.id },
        data: { reversedAt: new Date(), status: "reversed" },
      });

      return reversal;
    });

    await createAuditLog({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.withdrawal_reversed",
      entityType: "withdrawal",
      entityId: original.id,
      details: {
        reversalId: result.id,
        reason,
        netAmount: Number(original.netAmount),
        commissionAmount: Number(original.commissionAmount),
        referenceId: result.referenceId,
      },
    });

    revalidatePath("/susu/admin/withdrawals");
    revalidatePath("/susu/admin/history");
    revalidatePath("/susu/admin");
    return { success: true, reversalId: result.id };
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_REVERSED") {
      return { success: false, error: "This withdrawal has already been reversed." };
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { success: false, error: "This withdrawal has already been reversed." };
    }
    return { success: false, error: "The reversal could not be posted." };
  }
}

/**
 * Reverse a posted contribution with a negative compensating contribution.
 * Allocations belonging to the reversed contribution are excluded from
 * outstanding-day calculations (see the allocation queries).
 */
export async function reverseContribution(input: {
  contributionId: string;
  reason: string;
}): Promise<ReversalResponse> {
  const ctx = await requireTenantAdminSusu();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reversal reason of at least 10 characters." };
  }

  const rate = await consumeRateLimit(
    "finance:reversal",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many correction requests. Please wait." };
  }

  const original = await db.contribution.findFirst({
    where: { id: input.contributionId, tenantId: ctx.tenantId },
  });
  if (!original) return { success: false, error: "Contribution not found." };
  if (original.reversalOfId) {
    return { success: false, error: "A reversal entry cannot itself be reversed." };
  }
  if (original.reversedAt) {
    return { success: false, error: "This contribution has already been reversed." };
  }

  try {
    const reversal = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, original.accountId);

      const already = await tx.contribution.findFirst({
        where: { reversalOfId: original.id },
        select: { id: true },
      });
      if (already) throw new Error("ALREADY_REVERSED");

      const row = await tx.contribution.create({
        data: {
          tenantId: ctx.tenantId,
          accountId: original.accountId,
          cycleId: original.cycleId,
          amount: -Number(original.amount),
          collectionDate: new Date(),
          channel: "reversal",
          collectorId: original.collectorId,
          recordedById: ctx.userId,
          referenceId: reference("REV-C"),
          reversalOfId: original.id,
          notes: reason,
        },
      });

      await tx.contribution.update({
        where: { id: original.id },
        data: { reversedAt: new Date() },
      });

      return row;
    });

    await createAuditLog({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.contribution_reversed",
      entityType: "contribution",
      entityId: original.id,
      details: {
        reversalId: reversal.id,
        reason,
        amount: Number(original.amount),
        referenceId: reversal.referenceId,
      },
    });

    revalidatePath("/susu/admin/contributions");
    revalidatePath("/susu/admin/history");
    revalidatePath("/susu/admin");
    return { success: true, reversalId: reversal.id };
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_REVERSED") {
      return { success: false, error: "This contribution has already been reversed." };
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { success: false, error: "This contribution has already been reversed." };
    }
    return { success: false, error: "The reversal could not be posted." };
  }
}

/** Recent corrections for the tenant (audit-backed, read-only). */
export async function getRecentReversals(limit = 20) {
  const ctx = await requireTenantAdminSusu();
  return db.auditLog.findMany({
    where: {
      tenantId: ctx.tenantId,
      action: { in: ["susu.withdrawal_reversed", "susu.contribution_reversed"] },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(50, Math.max(1, limit)),
  });
}
