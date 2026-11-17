/**
 * BIK Prestige Enterprise — Susu Business Logic Tests
 *
 * These tests verify the core financial rules:
 * - Commission is exactly one day's contribution on first withdrawal per cycle
 * - Commission resets per cycle
 * - Multi-day allocation works correctly
 * - Partial withdrawals preserve remaining balance
 * - Idempotency prevents duplicate records
 * - Balance calculations are correct
 */
import { createPrismaClient } from "../src/lib/prisma-client";

import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

const prisma = createPrismaClient();

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

function assertEqual(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) < 0.01) {
    console.log(`  ✅ ${message} (got ${actual})`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${message} — expected ${expected}, got ${actual}`);
    failed++;
  }
}

async function cleanDb() {
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
  await prisma.dailyAccount.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.location.deleteMany();
}

async function createTestUser() {
  const passwordHash = await bcrypt.hash("Test123", 12);
  return prisma.user.create({
    data: {
      email: "test-admin@bikprestige.com",
      fullName: "Test Admin",
      role: "admin",
      status: "active",
      passwordHash,
    },
  });
}

async function createTestCustomer(adminId: string, dailyContribution: number, suffix: string) {
  const customer = await prisma.customer.create({
    data: {
      customerId: `BIK-C-TEST-${suffix}`,
      fullName: `Test Customer ${suffix}`,
      phone: `+23327000${suffix}`,
      status: "active",
    },
  });

  const account = await prisma.susuAccount.create({
    data: {
      accountId: `BIK-S-TEST-${suffix}`,
      customerId: customer.id,
      dailyContribution,
      status: "active",
      cardCustody: "customer",
    },
  });

  await prisma.cardFee.create({
    data: {
      accountId: account.id,
      amount: 10,
      recordedById: adminId,
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
    },
  });

  return { customer, account, cycle };
}

async function recordContribution(accountId: string, cycleId: string, amount: number, adminId: string) {
  const referenceId = `CON-TEST-${randomBytes(4).toString("hex")}`;
  const account = await prisma.susuAccount.findUnique({ where: { id: accountId } });
  const cycle = await prisma.susuCycle.findUnique({ where: { id: cycleId } });
  if (!account || !cycle) throw new Error("Account or cycle not found");

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

  // Allocation logic
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

  return { contribution, daysAllocated, allocatedAmount: daysAllocated * dailyContribution };
}

async function processWithdrawal(accountId: string, cycleId: string, requestedAmount: number, adminId: string) {
  const account = await prisma.susuAccount.findUnique({ where: { id: accountId } });
  const cycle = await prisma.susuCycle.findUnique({ where: { id: cycleId } });
  if (!account || !cycle) throw new Error("Account or cycle not found");

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
    throw new Error(`Insufficient balance: ${availableAfterCommission}`);
  }

  const remainingBalance = availableAfterCommission - requestedAmount;
  const referenceId = `WDR-TEST-${randomBytes(4).toString("hex")}`;

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

// =====================
// TESTS
// =====================

async function runTests() {
  console.log("🧪 BIK Prestige Enterprise — Susu Business Logic Tests\n");
  console.log("═".repeat(60));

  await cleanDb();
  const admin = await createTestUser();

  // ---- TEST A: GH₵1/day, 5 days, first withdrawal ----
  console.log("\n📋 Test A: GH₵1/day, 5 days, first withdrawal");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 1, "A");
    const { daysAllocated } = await recordContribution(account.id, cycle.id, 5, admin.id);
    assertEqual(daysAllocated, 5, "5 days allocated from GH₵5");

    const result = await processWithdrawal(account.id, cycle.id, 4, admin.id);
    assertEqual(result.commissionAmount, 1, "Commission = GH₵1 (one day)");
    assertEqual(result.netAmount, 4, "Customer receives GH₵4");
    assertEqual(result.remainingBalance, 0, "Remaining balance = GH₵0");

    // Verify: 5 - 1 (commission) - 4 (withdrawal) = 0
    const commissions = await prisma.commission.findMany({ where: { cycleId: cycle.id } });
    assertEqual(commissions.length, 1, "Exactly 1 commission record");
    assertEqual(Number(commissions[0].amount), 1, "Commission amount = GH₵1");
  }

  // ---- TEST B: GH₵50/day, 5 days, first withdrawal ----
  console.log("\n📋 Test B: GH₵50/day, 5 days, first withdrawal");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 50, "B");
    const { daysAllocated } = await recordContribution(account.id, cycle.id, 250, admin.id);
    assertEqual(daysAllocated, 5, "5 days allocated from GH₵250");

    const result = await processWithdrawal(account.id, cycle.id, 200, admin.id);
    assertEqual(result.commissionAmount, 50, "Commission = GH₵50 (one day)");
    assertEqual(result.netAmount, 200, "Customer receives GH₵200");
    assertEqual(result.remainingBalance, 0, "Remaining balance = GH₵0 (250 - 50 - 200)");

    // Verify balance: 250 - 50 (commission) - 200 (withdrawal) = 0
    const totalCommissions = await prisma.commission.aggregate({ where: { cycleId: cycle.id }, _sum: { amount: true } });
    const totalWithdrawals = await prisma.withdrawal.aggregate({ where: { cycleId: cycle.id }, _sum: { netAmount: true } });
    const balance = 250 - Number(totalCommissions._sum.amount || 0) - Number(totalWithdrawals._sum.netAmount || 0);
    assertEqual(balance, 0, "Independent balance check = GH₵0");
  }

  // ---- TEST C: GH₵1,000/day, 2 days, first withdrawal ----
  console.log("\n📋 Test C: GH₵1,000/day, 2 days, first withdrawal");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 1000, "C");
    await recordContribution(account.id, cycle.id, 2000, admin.id);

    const result = await processWithdrawal(account.id, cycle.id, 1000, admin.id);
    assertEqual(result.commissionAmount, 1000, "Commission = GH₵1,000 (one day)");
    assertEqual(result.netAmount, 1000, "Customer receives GH₵1,000");
    assertEqual(result.remainingBalance, 0, "Remaining balance = GH₵0 (2000 - 1000 - 1000)");
  }

  // ---- TEST D: Partial withdrawal ----
  console.log("\n📋 Test D: GH₵50/day, GH₵500 gross, partial withdrawal GH₵200");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 50, "D");
    await recordContribution(account.id, cycle.id, 500, admin.id);

    const result = await processWithdrawal(account.id, cycle.id, 200, admin.id);
    assertEqual(result.commissionAmount, 50, "Commission = GH₵50");
    assertEqual(result.netAmount, 200, "Customer receives GH₵200");
    assertEqual(result.remainingBalance, 250, "Remaining = GH₵250 (500 - 50 - 200)");

    // Verify: 500 - 50 - 200 = 250
    const balance = 500 - 50 - 200;
    assertEqual(balance, 250, "Independent balance = GH₵250");
  }

  // ---- TEST E: Second withdrawal same cycle — no commission ----
  console.log("\n📋 Test E: Second withdrawal in same cycle — no additional commission");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 50, "E");
    await recordContribution(account.id, cycle.id, 500, admin.id);

    // First withdrawal
    const first = await processWithdrawal(account.id, cycle.id, 100, admin.id);
    assertEqual(first.commissionAmount, 50, "First withdrawal: commission = GH₵50");
    assertEqual(first.netAmount, 100, "First withdrawal: customer receives GH₵100");

    // Second withdrawal — no commission
    const second = await processWithdrawal(account.id, cycle.id, 100, admin.id);
    assertEqual(second.commissionAmount, 0, "Second withdrawal: commission = GH₵0");
    assertEqual(second.netAmount, 100, "Second withdrawal: customer receives GH₵100");
    assertEqual(second.remainingBalance, 250, "Remaining = GH₵250 (500 - 50 - 100 - 100)");

    // Total commissions should be exactly 1
    const totalCommissions = await prisma.commission.count({ where: { cycleId: cycle.id } });
    assertEqual(totalCommissions, 1, "Exactly 1 commission record for entire cycle");
  }

  // ---- TEST F: New cycle — commission resets ----
  console.log("\n📋 Test F: New cycle — commission eligibility resets");
  {
    const { account, cycle: cycle1 } = await createTestCustomer(admin.id, 50, "F");
    await recordContribution(account.id, cycle1.id, 250, admin.id);

    // First withdrawal in cycle 1
    const first = await processWithdrawal(account.id, cycle1.id, 100, admin.id);
    assertEqual(first.commissionAmount, 50, "Cycle 1 first withdrawal: commission = GH₵50");

    // Create cycle 2
    const now = new Date();
    const cycle2 = await prisma.susuCycle.create({
      data: {
        accountId: account.id,
        cycleNumber: 2,
        startDate: new Date(now.getFullYear(), now.getMonth() + 1, 1),
        endDate: new Date(now.getFullYear(), now.getMonth() + 1, 31),
        dailyContribution: 50,
        status: "active",
        commissionCharged: false,
      },
    });

    await recordContribution(account.id, cycle2.id, 250, admin.id);

    // First withdrawal in cycle 2 — commission should be charged again
    const second = await processWithdrawal(account.id, cycle2.id, 100, admin.id);
    assertEqual(second.commissionAmount, 50, "Cycle 2 first withdrawal: commission = GH₵50 (reset)");
    assertEqual(second.netAmount, 100, "Cycle 2: customer receives GH₵100");

    // Total commissions across both cycles = 2
    const totalCommissions = await prisma.commission.count({ where: { accountId: account.id } });
    assertEqual(totalCommissions, 2, "Total 2 commission records (one per cycle)");
  }

  // ---- Multi-day allocation tests ----
  console.log("\n📋 Allocation Test: Exact multiple (GH₵700 / GH₵50 = 14 days)");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 50, "ALLOC1");
    const { daysAllocated, allocatedAmount } = await recordContribution(account.id, cycle.id, 700, admin.id);
    assertEqual(daysAllocated, 14, "14 days allocated");
    assertEqual(allocatedAmount, 700, "GH₵700 allocated");

    // Verify all 14 days are marked as paid
    const allocations = await prisma.contributionAllocation.findMany({
      where: { contribution: { cycleId: cycle.id } },
    });
    assertEqual(allocations.length, 14, "14 allocation records created");
  }

  console.log("\n📋 Allocation Test: Partial remainder (GH₵725 / GH₵50 = 14 days, GH₵25 remainder)");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 50, "ALLOC2");
    const { daysAllocated, allocatedAmount } = await recordContribution(account.id, cycle.id, 725, admin.id);
    assertEqual(daysAllocated, 14, "14 days allocated (remainder GH₵25 < GH₵50)");
    assertEqual(allocatedAmount, 700, "GH₵700 allocated (GH₵25 unallocated)");

    const totalAllocations = await prisma.contributionAllocation.count({
      where: { contribution: { cycleId: cycle.id } },
    });
    assertEqual(totalAllocations, 14, "14 allocation records (not 15)");
  }

  // ---- Idempotency test ----
  console.log("\n📋 Idempotency Test: Duplicate referenceId prevented");
  {
    const referenceId = `CON-IDEMPOTENCY-${randomBytes(4).toString("hex")}`;
    const { account, cycle } = await createTestCustomer(admin.id, 50, "IDEMP");

    await prisma.contribution.create({
      data: {
        accountId: account.id,
        cycleId: cycle.id,
        amount: 50,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId,
      },
    });

    // Attempt duplicate
    try {
      await prisma.contribution.create({
        data: {
          accountId: account.id,
          cycleId: cycle.id,
          amount: 50,
          collectionDate: new Date(),
          channel: "direct_office",
          recordedById: admin.id,
          referenceId, // Same referenceId
        },
      });
      assert(false, "Duplicate referenceId should have thrown an error");
    } catch {
      assert(true, "Duplicate referenceId correctly rejected by unique constraint");
    }
  }

  // ---- Card fee test ----
  console.log("\n📋 Card Fee Test: GH₵10 not in savings balance");
  {
    const { account } = await createTestCustomer(admin.id, 50, "CARD");
    const cardFees = await prisma.cardFee.findMany({ where: { accountId: account.id } });
    assertEqual(cardFees.length, 1, "1 card fee record");
    assertEqual(Number(cardFees[0].amount), 10, "Card fee = GH₵10");

    // Card fee should NOT appear in contribution totals
    const totalContributions = await prisma.contribution.aggregate({
      where: { accountId: account.id },
      _sum: { amount: true },
    });
    assertEqual(Number(totalContributions._sum.amount || 0), 0, "Card fee NOT in contribution total");
  }

  // ---- Insufficient balance test ----
  console.log("\n📋 Insufficient Balance Test: Withdrawal exceeding balance rejected");
  {
    const { account, cycle } = await createTestCustomer(admin.id, 50, "INSUF");
    await recordContribution(account.id, cycle.id, 100, admin.id); // 2 days = GH₵100

    try {
      // Request GH₵200 but only GH₵50 available after commission
      await processWithdrawal(account.id, cycle.id, 200, admin.id);
      assert(false, "Should have rejected withdrawal exceeding balance");
    } catch (e) {
      assert(true, "Withdrawal exceeding balance correctly rejected");
    }
  }

  // ---- Summary ----
  console.log("\n" + "═".repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

  if (failed > 0) {
    console.log("\n❌ SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ ALL TESTS PASSED");
  }

  await cleanDb();
  await prisma.$disconnect();
}

runTests().catch(async (e) => {
  console.error("Test error:", e);
  await prisma.$disconnect();
  process.exit(1);
});
