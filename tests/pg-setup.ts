/**
 * PostgreSQL Staging Test Setup
 * 
 * Runs the core Susu financial tests against the real PostgreSQL staging database.
 * Validates that the application works correctly with PostgreSQL.
 */

import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.PG_DATABASE_URL || (() => { throw new Error('PG_DATABASE_URL environment variable is required for PostgreSQL tests'); })() as string,
    },
  },
});

export { prisma };

export async function cleanDatabase() {
  await prisma.contributionAllocation.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.withdrawal.deleteMany();
  await prisma.commission.deleteMany();
  await prisma.cardFee.deleteMany();
  await prisma.collectorCustomerAssignment.deleteMany();
  await prisma.collectorRemittance.deleteMany();
  await prisma.susuCycle.deleteMany();
  await prisma.susuAccount.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.collector.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.dailyAccountRevision.deleteMany();
  await prisma.dailyAccount.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.offlineTransaction.deleteMany();
  await prisma.deviceEnrollment.deleteMany();
  await prisma.sessionRecord.deleteMany();
  await prisma.accountRecoveryRequest.deleteMany();
  await prisma.rateLimitCounter.deleteMany();
  await prisma.authThrottle.deleteMany();
  await prisma.turnstileTokenUse.deleteMany();
  await prisma.zeliProviderUsage.deleteMany();
  await prisma.zeliPaymentEvent.deleteMany();
  await prisma.zeliSubscription.deleteMany();
  await prisma.zeliPlan.deleteMany();
  await prisma.zeliAiTenantAuthorization.deleteMany();
  await prisma.zeliProviderControl.deleteMany();
  await prisma.zeliProviderGatewayEvent.deleteMany();
  await prisma.zeliAnalyticsDaily.deleteMany();
  await prisma.zeliAnalyticsRefresh.deleteMany();
  await prisma.zeliEntitlementEvent.deleteMany();
  await prisma.zeliEntitlement.deleteMany();
  await prisma.zeliMessage.deleteMany();
  await prisma.zeliConversation.deleteMany();
  await prisma.zeliUsage.deleteMany();
  await prisma.platformAuditLog.deleteMany();
  await prisma.platformOidcSession.deleteMany();
  await prisma.platformOidcLink.deleteMany();
  await prisma.platformSuperAdmin.deleteMany();
  await prisma.user.deleteMany();
  await prisma.location.deleteMany();
  await prisma.businessTenant.deleteMany();
  await prisma.zeliAvailability.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: true, reason: "Test default" },
    update: { enabled: true, reason: "Test default" },
  });
}

export function refId(prefix: string) { return `${prefix}-TEST-${randomBytes(4).toString("hex")}`; }

export async function createTestAdmin() {
  const bcrypt = await import("bcryptjs");
  const hash = await bcrypt.hash("Test1234!", 4);
  return prisma.user.create({
    data: { email: `test-pg-${Date.now()}@test.com`, fullName: "PG Test Admin", role: "admin", status: "active", passwordHash: hash },
  });
}

export async function createTestCustomer(adminId: string, daily: number, suffix: string) {
  const customer = await prisma.customer.create({
    data: { customerId: `PG-C-${suffix}`, fullName: `PG Customer ${suffix}`, phone: `+2339900${suffix}`, status: "active" },
  });
  const account = await prisma.susuAccount.create({
    data: { accountId: `PG-S-${suffix}`, customerId: customer.id, dailyContribution: daily, status: "active" },
  });
  await prisma.cardFee.create({ data: { accountId: account.id, amount: 10, recordedById: adminId } });
  const now = new Date();
  const cycle = await prisma.susuCycle.create({
    data: {
      accountId: account.id, cycleNumber: 1,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: new Date(now.getFullYear(), now.getMonth(), 31),
      dailyContribution: daily, status: "active", commissionCharged: false,
    },
  });
  return { customer, account, cycle };
}

export async function recordContribution(accountId: string, cycleId: string, amount: number, adminId: string) {
  const cycle = await prisma.susuCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new Error("Cycle not found");
  const dc = Number(cycle.dailyContribution);
  const contribution = await prisma.contribution.create({
    data: { accountId, cycleId, amount, collectionDate: new Date(), channel: "direct_office", recordedById: adminId, referenceId: refId("CON") },
  });
  const daysCovered = Math.floor(amount / dc);
  const existing = await prisma.contributionAllocation.findMany({ where: { contribution: { cycleId } } });
  const paid = new Set(existing.map(a => a.cycleDay));
  const allocs: { contributionId: string; cycleDay: number; amount: number }[] = [];
  let d = 0;
  for (let day = 1; day <= 31 && d < daysCovered; day++) {
    if (!paid.has(day)) { allocs.push({ contributionId: contribution.id, cycleDay: day, amount: dc }); d++; }
  }
  if (allocs.length > 0) await prisma.contributionAllocation.createMany({ data: allocs });
  return { contribution, daysAllocated: d, allocatedAmount: d * dc, unallocatedAmount: amount - d * dc };
}

export async function processWithdrawal(accountId: string, cycleId: string, requested: number, adminId: string) {
  const cycle = await prisma.susuCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new Error("Cycle not found");
  const dc = Number(cycle.dailyContribution);
  const contribs = await prisma.contribution.findMany({ where: { cycleId } });
  const wdrs = await prisma.withdrawal.findMany({ where: { cycleId, status: "completed" } });
  const comms = await prisma.commission.findMany({ where: { cycleId } });
  const total = contribs.reduce((s, c) => s + Number(c.amount), 0);
  const withdrawn = wdrs.reduce((s, w) => s + Number(w.netAmount), 0);
  const commissions = comms.reduce((s, c) => s + Number(c.amount), 0);
  const bal = total - withdrawn - commissions;
  let commissionAmount = 0;
  if (!cycle.commissionCharged) commissionAmount = dc;
  const avail = bal - commissionAmount;
  if (requested > avail) throw new Error(`Insufficient: ${avail.toFixed(2)}`);
  const remaining = avail - requested;
  const result = await prisma.$transaction(async (tx) => {
    if (commissionAmount > 0) {
      await tx.commission.create({ data: { accountId, cycleId, amount: commissionAmount, basis: "one_day_contribution", triggeredBy: "first_withdrawal", recordedById: adminId } });
      await tx.susuCycle.update({ where: { id: cycleId }, data: { commissionCharged: true } });
    }
    const w = await tx.withdrawal.create({ data: { accountId, cycleId, requestedAmount: requested, commissionAmount, netAmount: requested, remainingBalance: remaining, status: "completed", authorizedById: adminId, referenceId: refId("WDR") } });
    return { withdrawal: w, commissionAmount, netAmount: requested, remainingBalance: remaining };
  });
  return result;
}

export async function calculateCycleBalance(cycleId: string) {
  const gc = await prisma.contribution.aggregate({ where: { cycleId }, _sum: { amount: true } });
  const gw = await prisma.withdrawal.aggregate({ where: { cycleId, status: "completed" }, _sum: { netAmount: true } });
  const gcm = await prisma.commission.aggregate({ where: { cycleId }, _sum: { amount: true } });
  const gross = Number(gc._sum.amount || 0), withdrawn = Number(gw._sum.netAmount || 0), commissions = Number(gcm._sum.amount || 0);
  return { gross, withdrawn, commissions, balance: gross - withdrawn - commissions };
}
