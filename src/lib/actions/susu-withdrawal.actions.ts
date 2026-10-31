"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { formatCedi } from "@/lib/utils";

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
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const { accountId, requestedAmount, notes } = params;

  if (requestedAmount <= 0) {
    return {
      success: false,
      error: "Withdrawal amount must be greater than 0",
    };
  }

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

  const cycleContributions = await db.contribution.findMany({
    where: { cycleId: cycle.id, tenantId: ctx.tenantId },
  });
  const cycleWithdrawals = await db.withdrawal.findMany({
    where: { cycleId: cycle.id, status: "completed", tenantId: ctx.tenantId },
  });
  const cycleCommissions = await db.commission.findMany({
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
  if (!cycle.commissionCharged) {
    commissionAmount = dailyContribution;
  }

  const availableAfterCommission = currentBalance - commissionAmount;

  if (requestedAmount > availableAfterCommission) {
    return {
      success: false,
      error: `Insufficient balance. Available: ${formatCedi(availableAfterCommission)}${commissionAmount > 0 ? ` (after ${formatCedi(commissionAmount)} commission)` : ""}`,
    };
  }

  const remainingBalance = availableAfterCommission - requestedAmount;
  const referenceId = `WDR-${randomBytes(8).toString("hex")}`;

  const result = await db.$transaction(async (tx) => {
    if (commissionAmount > 0) {
      await tx.commission.create({
        data: {
          tenantId: ctx.tenantId,
          accountId: account.id,
          cycleId: cycle.id,
          amount: commissionAmount,
          basis: "one_day_contribution",
          triggeredBy: "first_withdrawal",
          recordedById: ctx.userId,
        },
      });

      await tx.susuCycle.update({
        where: { id: cycle.id },
        data: { commissionCharged: true },
      });
    }

    const withdrawal = await tx.withdrawal.create({
      data: {
        tenantId: ctx.tenantId,
        accountId: account.id,
        cycleId: cycle.id,
        requestedAmount,
        commissionAmount,
        netAmount: requestedAmount,
        remainingBalance,
        status: "completed",
        authorizedById: ctx.userId,
        referenceId,
        notes,
      },
    });

    return { withdrawal, commissionAmount, netAmount: requestedAmount };
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
    },
  });

  revalidatePath("/susu/admin/withdrawals");
  revalidatePath("/susu/admin/customers");
  revalidatePath("/susu/admin");
  return { success: true, data: result };
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
