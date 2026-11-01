"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { formatCedi } from "@/lib/utils";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Balance = total contributions - total withdrawals (including commissions)
 */
function calculateCycleBalance(
  contributions: number,
  withdrawals: number,
  commissions: number
): number {
  return contributions - withdrawals - commissions;
}

/**
 * Process a withdrawal request.
 *
 * Commission rule (unchanged):
 * - One day's contribution is deducted as commission on the FIRST withdrawal
 *   in a cycle, and resets each new cycle.
 *
 * Tenant isolation: the account must belong to the authenticated tenant, and
 * every cycle-level financial aggregate is scoped by tenantId as well.
 */
export async function processWithdrawal(params: {
  accountId: string;
  requestedAmount: number;
  notes?: string;
  idempotencyKey?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const { accountId, requestedAmount, notes, idempotencyKey } = params;

  // Monetary validation: finite, positive, at most two decimal places.
  if (
    typeof requestedAmount !== "number" ||
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0 ||
    requestedAmount > 999999.99
  ) {
    return {
      success: false,
      error: "Enter a valid withdrawal amount greater than 0",
    };
  }
  const amount = Math.round(requestedAmount * 100) / 100;
  if (Math.abs(amount - requestedAmount) > 1e-9) {
    return {
      success: false,
      error: "Withdrawal amount cannot have more than two decimal places",
    };
  }

  const rate = await consumeRateLimit(
    "finance:withdrawal",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return {
      success: false,
      error: "Too many withdrawal requests. Please wait and try again.",
    };
  }

  const referenceId =
    idempotencyKey && /^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)
      ? `WDR-${idempotencyKey}`
      : `WDR-${randomBytes(8).toString("hex")}`;

  // TENANT SCOPED account fetch.
  const account = await db.susuAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: {
      cycles: { where: { status: "active" }, take: 1 },
      customer: true,
    },
  });

  if (!account) return { success: false, error: "Susu account not found" };
  if (account.status !== "active")
    return { success: false, error: "Account is not active" };
  if (!account.cycles.length)
    return { success: false, error: "No active cycle found" };

  const cycle = account.cycles[0];
  const dailyContribution = Number(cycle.dailyContribution);

  try {
    const result = await db.$transaction(async (tx) => {
      // Re-read the cycle inside the transaction and claim the commission in a
      // single conditional update. Concurrent withdrawals cannot both charge it.
      const cycleRow = await tx.susuCycle.findFirst({
        where: { id: cycle.id, tenantId: ctx.tenantId },
      });
      if (!cycleRow || cycleRow.status !== "active") {
        throw new Error("No active cycle found");
      }

      const cycleContributions = await tx.contribution.findMany({
        where: { cycleId: cycle.id, tenantId: ctx.tenantId },
      });
      const cycleWithdrawals = await tx.withdrawal.findMany({
        where: {
          cycleId: cycle.id,
          status: "completed",
          tenantId: ctx.tenantId,
        },
      });
      const cycleCommissions = await tx.commission.findMany({
        where: { cycleId: cycle.id, tenantId: ctx.tenantId },
      });

      const totalContributed = cycleContributions.reduce(
        (sum, c) => sum + Number(c.amount),
        0
      );
      const totalWithdrawn = cycleWithdrawals.reduce(
        (sum, w) => sum + Number(w.netAmount),
        0
      );
      const totalCommissions = cycleCommissions.reduce(
        (sum, c) => sum + Number(c.amount),
        0
      );

      const currentBalance = calculateCycleBalance(
        totalContributed,
        totalWithdrawn,
        totalCommissions
      );

      let commissionAmount = 0;
      let commissionClaimed = false;
      if (!cycleRow.commissionCharged) {
        const claimed = await tx.susuCycle.updateMany({
          where: {
            id: cycleRow.id,
            tenantId: ctx.tenantId,
            commissionCharged: false,
          },
          data: { commissionCharged: true },
        });
        if (claimed.count === 1) {
          commissionAmount = dailyContribution;
          commissionClaimed = true;
          await tx.commission.create({
            data: {
              tenantId: ctx.tenantId,
              accountId: account.id,
              cycleId: cycleRow.id,
              amount: commissionAmount,
              basis: "one_day_contribution",
              triggeredBy: "first_withdrawal",
              recordedById: ctx.userId,
            },
          });
        }
      }

      const availableAfterCommission = currentBalance - commissionAmount;
      if (amount > availableAfterCommission) {
        throw new Error(
          `Insufficient balance. Available: ${formatCedi(
            availableAfterCommission
          )}${
            commissionAmount > 0
              ? ` (after ${formatCedi(commissionAmount)} commission)`
              : ""
          }`
        );
      }

      const remainingBalance = availableAfterCommission - amount;

      const withdrawal = await tx.withdrawal.create({
        data: {
          tenantId: ctx.tenantId,
          accountId: account.id,
          cycleId: cycleRow.id,
          requestedAmount: amount,
          commissionAmount,
          netAmount: amount,
          remainingBalance,
          status: "completed",
          authorizedById: ctx.userId,
          referenceId,
          notes,
        },
      });

      return {
        withdrawal,
        commissionAmount,
        netAmount: amount,
        commissionClaimed,
      };
    });

    await createAuditLog({
      userId: ctx.userId,
      action: "susu.withdrawal_processed",
      entityType: "withdrawal",
      entityId: result.withdrawal.id,
      details: {
        accountId,
        requestedAmount: result.withdrawal.requestedAmount,
        commissionAmount: result.withdrawal.commissionAmount,
        netAmount: result.withdrawal.netAmount,
        remainingBalance: result.withdrawal.remainingBalance,
        referenceId,
      },
    });

    revalidatePath("/susu/admin/withdrawals");
    revalidatePath("/susu/admin/customers");
    revalidatePath("/susu/admin");
    return { success: true, data: result };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return {
        success: false,
        error: "This withdrawal was already processed.",
      };
    }
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Withdrawal could not be processed",
    };
  }
}

export async function getWithdrawals(params?: {
  page?: number;
  limit?: number;
  accountId?: string;
  cycleId?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const ctx = await requireTenantAdminSusu();

  const page = params?.page || 1;
  const limit = params?.limit || 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (params?.accountId) where.accountId = params.accountId;
  if (params?.cycleId) where.cycleId = params.cycleId;

  if (params?.dateFrom || params?.dateTo) {
    where.createdAt = {};
    const dateRange = where.createdAt as Record<string, Date>;
    if (params.dateFrom)
      dateRange.gte = new Date(params.dateFrom + "T00:00:00.000Z");
    if (params.dateTo)
      dateRange.lte = new Date(params.dateTo + "T23:59:59.999Z");
  }

  const [withdrawals, total] = await Promise.all([
    db.withdrawal.findMany({
      where,
      include: {
        account: {
          include: {
            customer: { select: { customerId: true, fullName: true } },
          },
        },
        cycle: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.withdrawal.count({ where }),
  ]);

  return {
    withdrawals,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
