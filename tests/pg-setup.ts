/**
 * PostgreSQL Staging Test Setup
 * 
 * Runs the core Susu financial tests against the real PostgreSQL staging database.
 * Validates that the application works correctly with PostgreSQL.
 */

import { randomBytes } from "crypto";
import { createPrismaClient } from "@/lib/prisma-client";
import { assertDisposablePostgresTarget } from "./pg-safety";

const target = assertDisposablePostgresTarget(process.env.PG_DATABASE_URL);

const prisma = createPrismaClient(target.url);

export { prisma };

export async function cleanDatabase() {
  await prisma.reconciliationAdjustment.deleteMany();
  await prisma.reconciliationLine.deleteMany();
  await prisma.dailyCollectorClosing.deleteMany();
  await prisma.reconciliationExceptionEvent.deleteMany();
  await prisma.reconciliationExceptionLink.deleteMany();
  await prisma.reconciliationExceptionCase.deleteMany();
  await prisma.susuReconciliation.deleteMany();
  await prisma.contributionAllocation.deleteMany();
  await prisma.remittanceDiscrepancy.deleteMany();
  await prisma.remittanceContribution.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.withdrawal.deleteMany();
  await prisma.commission.deleteMany();
  await prisma.cardFee.deleteMany();
  await prisma.collectorCustomerAssignment.deleteMany();
  await prisma.collectorRemittance.deleteMany();
  await prisma.customerWithdrawalRequest.deleteMany();
  await prisma.evidenceAttachment.deleteMany();
  await prisma.susuCycle.deleteMany();
  await prisma.susuAccount.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.collector.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.branchLiquidityLine.deleteMany();
  await prisma.branchLiquiditySnapshot.deleteMany();
  await prisma.providerStatementRow.deleteMany();
  await prisma.providerStatementImport.deleteMany();
  await prisma.reconciliationExceptionEvent.deleteMany();
  await prisma.reconciliationExceptionLink.deleteMany();
  await prisma.reconciliationExceptionCase.deleteMany();
  await prisma.shiftRevision.deleteMany();
  await prisma.shiftHandover.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.tenantOperationalPolicy.deleteMany();
  await prisma.offlineActionRequest.deleteMany();
  await prisma.messagingConsentChallenge.deleteMany();
  await prisma.messagingTemplate.deleteMany();
  await prisma.tenantMessagingConfig.deleteMany();
  await prisma.customerMessageStatusEvent.deleteMany();
  await prisma.customerMessageOutbox.deleteMany();
  await prisma.customerMessagingPreference.deleteMany();
  await prisma.dailyAccountRevision.deleteMany();
  await prisma.dailyAccount.deleteMany();
  await prisma.trainingCertificate.deleteMany();
  await prisma.trainingAssessmentAttempt.deleteMany();
  await prisma.trainingAttendance.deleteMany();
  await prisma.trainingAssessment.deleteMany();
  await prisma.trainingSession.deleteMany();
  await prisma.trainingEnrolment.deleteMany();
  await prisma.trainingModule.deleteMany();
  await prisma.trainingCourse.deleteMany();
  await prisma.associationTrainingRecord.deleteMany();
  await prisma.sponsorshipCoverage.deleteMany();
  await prisma.sponsorshipFunding.deleteMany();
  await prisma.associationSponsorship.deleteMany();
  await prisma.sponsor.deleteMany();
  await prisma.associationConsentRecord.deleteMany();
  await prisma.associationRoleAssignment.deleteMany();
  await prisma.associationMember.deleteMany();
  await prisma.associationZone.deleteMany();
  await prisma.association.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.emailVerificationToken.deleteMany();
  await prisma.offlineTransaction.deleteMany();
  await prisma.deviceEnrollment.deleteMany();
  await prisma.stepUpGrant.deleteMany();
  await prisma.mfaRecoveryCode.deleteMany();
  await prisma.sessionRecord.deleteMany();
  await prisma.tabCredential.deleteMany();
  await prisma.tabProofNonce.deleteMany();
  await prisma.mfaChallengeUse.deleteMany();
  await prisma.accountRecoveryRequest.deleteMany();
  await prisma.rateLimitCounter.deleteMany();
  await prisma.authThrottle.deleteMany();
  await prisma.turnstileTokenUse.deleteMany();
  await prisma.zeliTeamTester.deleteMany();
  await prisma.zeliProviderUsage.deleteMany();
  await prisma.zeliPaymentEvent.deleteMany();
  await prisma.foundingAllocation.deleteMany();
  await prisma.zeliSubscription.deleteMany();
  await prisma.zeliPlan.deleteMany();
  await prisma.zeliTenantAccess.deleteMany();
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
  await prisma.zeliUsagePeriod.deleteMany();
  await prisma.tenantNotification.deleteMany();
  await prisma.accountEnquiry.deleteMany();
  await prisma.financialApproval.deleteMany();
  await prisma.platformApprovalRequest.deleteMany();
  await prisma.securityAlert.deleteMany();
  await prisma.securityEventRecord.deleteMany();
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
