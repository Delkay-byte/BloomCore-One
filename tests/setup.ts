/**
 * BIK Prestige Enterprise — Test Setup
 *
 * Shared Prisma client, helpers, and database cleanup utilities.
 * Tests use a dedicated SQLite test database to avoid affecting dev data.
 */

import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

// Use the test database from environment variable
export const prisma = new PrismaClient();

/**
 * Clean all tables in the correct order to respect foreign key constraints.
 */
export async function cleanDatabase() {
  // One transaction keeps cleanup fast and consistent. Deletion order respects
  // foreign keys: financial children before parents, tenant-owned rows before
  // BusinessTenant. Each test file runs sequentially, so this cannot race.
  await prisma.$transaction([
    prisma.contributionAllocation.deleteMany(),
    prisma.contribution.deleteMany(),
    prisma.withdrawal.deleteMany(),
    prisma.commission.deleteMany(),
    prisma.cardFee.deleteMany(),
    prisma.collectorCustomerAssignment.deleteMany(),
    prisma.collectorRemittance.deleteMany(),
    prisma.susuCycle.deleteMany(),
    prisma.susuAccount.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.collector.deleteMany(),
    prisma.expense.deleteMany(),
    prisma.dailyAccountRevision.deleteMany(),
    prisma.dailyAccount.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.passwordResetToken.deleteMany(),
    prisma.offlineTransaction.deleteMany(),
    prisma.deviceEnrollment.deleteMany(),
    prisma.zeliProviderGatewayEvent.deleteMany(),
    prisma.zeliAnalyticsDaily.deleteMany(),
    prisma.zeliAnalyticsRefresh.deleteMany(),
    prisma.zeliEntitlementEvent.deleteMany(),
    prisma.zeliEntitlement.deleteMany(),
    prisma.zeliMessage.deleteMany(),
    prisma.zeliConversation.deleteMany(),
    prisma.zeliUsage.deleteMany(),
    prisma.user.deleteMany(),
    prisma.location.deleteMany(),
    prisma.businessTenant.deleteMany(),
    prisma.platformAuditLog.deleteMany(),
    prisma.platformSuperAdmin.deleteMany(),
    prisma.sessionRecord.deleteMany(),
    prisma.accountRecoveryRequest.deleteMany(),
    prisma.rateLimitCounter.deleteMany(),
    prisma.authThrottle.deleteMany(),
    prisma.turnstileTokenUse.deleteMany(),
  ]);
}

/**
 * Create an enrolled BusinessTenant for test fixtures. Each call gets a unique
 * code so multiple tenants can coexist in isolation tests.
 */
export async function createTestTenant(
  options: { momo?: boolean; susu?: boolean; name?: string } = {}
) {
  const momoEnabled = options.momo ?? true;
  const susuEnabled = options.susu ?? true;
  return prisma.businessTenant.create({
    data: {
      code: `T-${randomBytes(3).toString("hex").toUpperCase()}`,
      name: options.name ?? "Test Tenant",
      momoEnabled,
      susuEnabled,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
}

/**
 * Generate a unique reference ID for test operations.
 */
export function generateRefId(prefix: string): string {
  return `${prefix}-TEST-${randomBytes(4).toString("hex")}`;
}

/**
 * Create a test admin user in its own enrolled tenant (dual-module by default)
 * so tenant-guarded actions resolve a context.
 */
export async function createTestAdmin(options: {
  momo?: boolean;
  susu?: boolean;
  tenantId?: string;
} = {}) {
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash("Test1234!", 4);
  const tenant =
    options.tenantId != null
      ? null
      : await createTestTenant({ momo: options.momo, susu: options.susu });
  const tenantId = options.tenantId ?? tenant!.id;
  const user = await prisma.user.create({
    data: {
      email: `test-admin-${randomBytes(2).toString("hex")}@bikprestige.com`,
      fullName: "Test Admin",
      role: "admin",
      status: "active",
      passwordHash,
      momoEnabled: options.momo ?? true,
      susuEnabled: options.susu ?? true,
      tenantId,
    },
  });
  await prisma.businessTenant.update({
    where: { id: tenantId },
    data: { primaryAdminUserId: user.id },
  });
  return user;
}

/**
 * Create a test Susu customer with account and first cycle.
 */
export async function createTestCustomer(
  adminId: string,
  dailyContribution: number,
  suffix: string
) {
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  const tenantId = admin?.tenantId ?? null;
  const customer = await prisma.customer.create({
    data: {
      customerId: `BIK-C-TEST-${suffix}`,
      fullName: `Test Customer ${suffix}`,
      phone: `+23327000${suffix}`,
      status: "active",
      tenantId,
    },
  });

  const account = await prisma.susuAccount.create({
    data: {
      accountId: `BIK-S-TEST-${suffix}`,
      customerId: customer.id,
      dailyContribution,
      status: "active",
      cardCustody: "customer",
      tenantId,
    },
  });

  // Record card fee (GH₵10)
  await prisma.cardFee.create({
    data: {
      accountId: account.id,
      amount: 10,
      recordedById: adminId,
      notes: "Initial card purchase",
      tenantId,
    },
  });

  const now = new Date();
  const cycle = await prisma.susuCycle.create({
    data: {
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: new Date(now.getFullYear(), now.getMonth(), 31),
      dailyContribution,
      status: "active",
      commissionCharged: false,
      tenantId,
    },
  });

  return { customer, account, cycle };
}

/**
 * Record a contribution and allocate it across outstanding days.
 * This mirrors the business logic in susu-contribution.actions.ts.
 */
export async function recordContribution(
  accountId: string,
  cycleId: string,
  amount: number,
  adminId: string
) {
  const referenceId = generateRefId("CON");
  const cycle = await prisma.susuCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new Error("Cycle not found");

  const dailyContribution = Number(cycle.dailyContribution);

  const contribution = await prisma.contribution.create({
    data: {
      accountId,
      cycleId,
      amount,
      collectionDate: new Date(),
      channel: "direct_office",
      recordedById: adminId,
      referenceId,
    },
  });

  // Allocation logic: calculate how many days this covers
  const daysCovered = Math.floor(amount / dailyContribution);
  const existingAllocations = await prisma.contributionAllocation.findMany({
    where: { contribution: { cycleId } },
  });
  const paidDays = new Set(existingAllocations.map((a) => a.cycleDay));

  const allocations: { contributionId: string; cycleDay: number; amount: number }[] = [];
  let daysAllocated = 0;
  for (let day = 1; day <= 31 && daysAllocated < daysCovered; day++) {
    if (!paidDays.has(day)) {
      allocations.push({ contributionId: contribution.id, cycleDay: day, amount: dailyContribution });
      daysAllocated++;
    }
  }
  if (allocations.length > 0) {
    await prisma.contributionAllocation.createMany({ data: allocations });
  }

  return {
    contribution,
    daysAllocated,
    allocatedAmount: daysAllocated * dailyContribution,
    unallocatedAmount: amount - daysAllocated * dailyContribution,
  };
}

/**
 * Process a withdrawal.
 * This mirrors the business logic in susu-withdrawal.actions.ts.
 */
export async function processWithdrawal(
  accountId: string,
  cycleId: string,
  requestedAmount: number,
  adminId: string
) {
  const cycle = await prisma.susuCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new Error("Cycle not found");

  const dailyContribution = Number(cycle.dailyContribution);

  const cycleContributions = await prisma.contribution.findMany({ where: { cycleId } });
  const cycleWithdrawals = await prisma.withdrawal.findMany({ where: { cycleId, status: "completed" } });
  const cycleCommissions = await prisma.commission.findMany({ where: { cycleId } });

  const totalContributed = cycleContributions.reduce((sum, c) => sum + Number(c.amount), 0);
  const totalWithdrawn = cycleWithdrawals.reduce((sum, w) => sum + Number(w.netAmount), 0);
  const totalCommissions = cycleCommissions.reduce((sum, c) => sum + Number(c.amount), 0);
  const currentBalance = totalContributed - totalWithdrawn - totalCommissions;

  let commissionAmount = 0;
  if (!cycle.commissionCharged) {
    commissionAmount = dailyContribution;
  }

  const availableAfterCommission = currentBalance - commissionAmount;

  if (requestedAmount > availableAfterCommission) {
    throw new Error(`Insufficient balance: available ${availableAfterCommission.toFixed(2)}`);
  }

  const remainingBalance = availableAfterCommission - requestedAmount;
  const referenceId = generateRefId("WDR");

  const result = await prisma.$transaction(async (tx) => {
    if (commissionAmount > 0) {
      await tx.commission.create({
        data: {
          accountId,
          cycleId,
          amount: commissionAmount,
          basis: "one_day_contribution",
          triggeredBy: "first_withdrawal",
          recordedById: adminId,
        },
      });
      await tx.susuCycle.update({
        where: { id: cycleId },
        data: { commissionCharged: true },
      });
    }

    const withdrawal = await tx.withdrawal.create({
      data: {
        accountId,
        cycleId,
        requestedAmount,
        commissionAmount,
        netAmount: requestedAmount,
        remainingBalance,
        status: "completed",
        authorizedById: adminId,
        referenceId,
      },
    });

    return { withdrawal, commissionAmount, netAmount: requestedAmount, remainingBalance };
  });

  return result;
}

/**
 * Calculate the independent financial invariant for a cycle.
 */
export async function calculateCycleBalance(cycleId: string) {
  const totalContributions = await prisma.contribution.aggregate({
    where: { cycleId },
    _sum: { amount: true },
  });

  const totalWithdrawals = await prisma.withdrawal.aggregate({
    where: { cycleId, status: "completed" },
    _sum: { netAmount: true },
  });

  const totalCommissions = await prisma.commission.aggregate({
    where: { cycleId },
    _sum: { amount: true },
  });

  const gross = Number(totalContributions._sum.amount || 0);
  const withdrawn = Number(totalWithdrawals._sum.netAmount || 0);
  const commissions = Number(totalCommissions._sum.amount || 0);

  return { gross, withdrawn, commissions, balance: gross - withdrawn - commissions };
}
