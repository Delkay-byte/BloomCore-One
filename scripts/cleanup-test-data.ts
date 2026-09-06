import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ════════════════════════════════════════════════════════════════
//  BIK PRESTIGE ENTERPRISE — PRE-PILOT DATABASE CLEANUP
//  Removes all test/pilot business data.
//  Preserves: admin account, locations, schema, system config.
// ════════════════════════════════════════════════════════════════

const PRESERVED_ADMIN_EMAIL = "admin@bikprestige.com";

// Known test user emails (non-admin) to delete
const TEST_USER_EMAILS = [
  "kwame@bikprestige.com",
  "ama@bikprestige.com",
  "kofi@bikprestige.com",
  "efua@bikprestige.com",
  "kwadwo@bikprestige.com",
  "akosua@bikprestige.com",
];

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  BIK PRESTIGE — PRE-PILOT DATABASE CLEANUP");
  console.log("═══════════════════════════════════════════════════\n");

  // ── Step 1: Identify the permanent admin ──
  const admin = await prisma.user.findUnique({
    where: { email: PRESERVED_ADMIN_EMAIL },
    select: { id: true, email: true, fullName: true, role: true, status: true },
  });

  if (!admin) {
    console.error("❌ CRITICAL: Admin account not found! Aborting cleanup.");
    process.exit(1);
  }

  console.log(`✅ Permanent admin identified: ${admin.fullName} (${admin.email})`);
  console.log(`   ID: ${admin.id}`);
  console.log(`   Role: ${admin.role} | Status: ${admin.status}\n`);

  // ── Step 2: Pre-cleanup counts ──
  console.log("── PRE-CLEANUP COUNTS ──");
  const preCounts = {
    users: await prisma.user.count(),
    workers: await prisma.user.count({ where: { role: "worker" } }),
    collectors: await prisma.user.count({ where: { role: "collector" } }),
    locations: await prisma.location.count(),
    customers: await prisma.customer.count(),
    susuAccounts: await prisma.susuAccount.count(),
    susuCycles: await prisma.susuCycle.count(),
    contributions: await prisma.contribution.count(),
    contributionAllocations: await prisma.contributionAllocation.count(),
    withdrawals: await prisma.withdrawal.count(),
    commissions: await prisma.commission.count(),
    cardFees: await prisma.cardFee.count(),
    collectorRecords: await prisma.collector.count(),
    collectorAssignments: await prisma.collectorCustomerAssignment.count(),
    collectorRemittances: await prisma.collectorRemittance.count(),
    dailyAccounts: await prisma.dailyAccount.count(),
    expenses: await prisma.expense.count(),
    passwordResetTokens: await prisma.passwordResetToken.count(),
    deviceEnrollments: await prisma.deviceEnrollment.count(),
    offlineTransactions: await prisma.offlineTransaction.count(),
    auditLogs: await prisma.auditLog.count(),
  };

  for (const [key, val] of Object.entries(preCounts)) {
    console.log(`  ${key}: ${val}`);
  }

  // ── Step 3: Begin deletion in FK-safe order ──
  console.log("\n── EXECUTING CLEANUP (FK-safe order) ──\n");

  let totalDeleted = 0;

  // 3.1. Password Reset Tokens (FK → User, onDelete: Cascade)
  const delPasswordTokens = await prisma.passwordResetToken.deleteMany({});
  console.log(`  ✓ Password Reset Tokens deleted: ${delPasswordTokens.count}`);
  totalDeleted += delPasswordTokens.count;

  // 3.2. Offline Transactions (no FK constraint on schema, but logically child)
  const delOfflineTxns = await prisma.offlineTransaction.deleteMany({});
  console.log(`  ✓ Offline Transactions deleted: ${delOfflineTxns.count}`);
  totalDeleted += delOfflineTxns.count;

  // 3.3. Device Enrollments (FK → User)
  const delDevices = await prisma.deviceEnrollment.deleteMany({});
  console.log(`  ✓ Device Enrollments deleted: ${delDevices.count}`);
  totalDeleted += delDevices.count;

  // 3.4. Audit Logs (test-related, preserve admin security events if any)
  // Delete all audit logs since there are 0 admin audit logs in test data
  const delAuditLogs = await prisma.auditLog.deleteMany({});
  console.log(`  ✓ Audit Logs deleted: ${delAuditLogs.count}`);
  totalDeleted += delAuditLogs.count;

  // 3.5. Contribution Allocations (FK → Contribution, onDelete: Cascade)
  const delAllocations = await prisma.contributionAllocation.deleteMany({});
  console.log(`  ✓ Contribution Allocations deleted: ${delAllocations.count}`);
  totalDeleted += delAllocations.count;

  // 3.6. Contributions (FK → SusuAccount, SusuCycle, Collector, User)
  const delContributions = await prisma.contribution.deleteMany({});
  console.log(`  ✓ Contributions deleted: ${delContributions.count}`);
  totalDeleted += delContributions.count;

  // 3.7. Commissions (FK → SusuAccount, SusuCycle)
  const delCommissions = await prisma.commission.deleteMany({});
  console.log(`  ✓ Commissions deleted: ${delCommissions.count}`);
  totalDeleted += delCommissions.count;

  // 3.8. Withdrawals (FK → SusuAccount, SusuCycle)
  const delWithdrawals = await prisma.withdrawal.deleteMany({});
  console.log(`  ✓ Withdrawals deleted: ${delWithdrawals.count}`);
  totalDeleted += delWithdrawals.count;

  // 3.9. Card Fees (FK → SusuAccount)
  const delCardFees = await prisma.cardFee.deleteMany({});
  console.log(`  ✓ Card Fees deleted: ${delCardFees.count}`);
  totalDeleted += delCardFees.count;

  // 3.10. Collector Remittances (FK → Collector)
  const delRemittances = await prisma.collectorRemittance.deleteMany({});
  console.log(`  ✓ Collector Remittances deleted: ${delRemittances.count}`);
  totalDeleted += delRemittances.count;

  // 3.11. Collector-Customer Assignments (FK → Collector, Customer, SusuAccount)
  const delAssignments = await prisma.collectorCustomerAssignment.deleteMany({});
  console.log(`  ✓ Collector-Customer Assignments deleted: ${delAssignments.count}`);
  totalDeleted += delAssignments.count;

  // 3.12. Susu Cycles (FK → SusuAccount)
  const delCycles = await prisma.susuCycle.deleteMany({});
  console.log(`  ✓ Susu Cycles deleted: ${delCycles.count}`);
  totalDeleted += delCycles.count;

  // 3.13. Susu Accounts (FK → Customer)
  const delSusuAccounts = await prisma.susuAccount.deleteMany({});
  console.log(`  ✓ Susu Accounts deleted: ${delSusuAccounts.count}`);
  totalDeleted += delSusuAccounts.count;

  // 3.14. Customers (no FK dependencies after above deletions)
  const delCustomers = await prisma.customer.deleteMany({});
  console.log(`  ✓ Customers deleted: ${delCustomers.count}`);
  totalDeleted += delCustomers.count;

  // 3.15. Expenses (FK → DailyAccount, onDelete: Cascade)
  const delExpenses = await prisma.expense.deleteMany({});
  console.log(`  ✓ Expenses deleted: ${delExpenses.count}`);
  totalDeleted += delExpenses.count;

  // 3.16. Daily Accounts (FK → Location, User)
  const delDailyAccounts = await prisma.dailyAccount.deleteMany({});
  console.log(`  ✓ Daily Accounts deleted: ${delDailyAccounts.count}`);
  totalDeleted += delDailyAccounts.count;

  // 3.17. Collector records (FK → User)
  const delCollectorRecords = await prisma.collector.deleteMany({});
  console.log(`  ✓ Collector records deleted: ${delCollectorRecords.count}`);
  totalDeleted += delCollectorRecords.count;

  // 3.18. Test Users (EXCLUDE admin)
  // Delete test workers and test collectors, but NOT the admin
  const delTestUsers = await prisma.user.deleteMany({
    where: {
      email: { in: TEST_USER_EMAILS },
    },
  });
  console.log(`  ✓ Test Users deleted: ${delTestUsers.count}`);
  totalDeleted += delTestUsers.count;

  // Also delete any other non-admin users that might exist
  const delOtherTestUsers = await prisma.user.deleteMany({
    where: {
      role: { not: "admin" },
    },
  });
  console.log(`  ✓ Other non-admin users deleted: ${delOtherTestUsers.count}`);
  totalDeleted += delOtherTestUsers.count;

  // ── Step 4: Verify cleanup ──
  console.log("\n── POST-CLEANUP VERIFICATION ──\n");

  const postCounts = {
    users: await prisma.user.count(),
    admins: await prisma.user.count({ where: { role: "admin" } }),
    workers: await prisma.user.count({ where: { role: "worker" } }),
    collectors: await prisma.user.count({ where: { role: "collector" } }),
    locations: await prisma.location.count(),
    customers: await prisma.customer.count(),
    susuAccounts: await prisma.susuAccount.count(),
    susuCycles: await prisma.susuCycle.count(),
    contributions: await prisma.contribution.count(),
    contributionAllocations: await prisma.contributionAllocation.count(),
    withdrawals: await prisma.withdrawal.count(),
    commissions: await prisma.commission.count(),
    cardFees: await prisma.cardFee.count(),
    collectorRecords: await prisma.collector.count(),
    collectorAssignments: await prisma.collectorCustomerAssignment.count(),
    collectorRemittances: await prisma.collectorRemittance.count(),
    dailyAccounts: await prisma.dailyAccount.count(),
    expenses: await prisma.expense.count(),
    passwordResetTokens: await prisma.passwordResetToken.count(),
    deviceEnrollments: await prisma.deviceEnrollment.count(),
    offlineTransactions: await prisma.offlineTransaction.count(),
    auditLogs: await prisma.auditLog.count(),
  };

  for (const [key, val] of Object.entries(postCounts)) {
    console.log(`  ${key}: ${val}`);
  }

  // ── Step 5: Verify admin preserved ──
  const adminCheck = await prisma.user.findUnique({
    where: { email: PRESERVED_ADMIN_EMAIL },
    select: { id: true, email: true, fullName: true, role: true, status: true, passwordHash: true },
  });

  console.log("\n── ADMIN ACCOUNT VERIFICATION ──\n");
  if (adminCheck) {
    console.log(`  ✅ Admin preserved: ${adminCheck.fullName} (${adminCheck.email})`);
    console.log(`     ID: ${adminCheck.id}`);
    console.log(`     Role: ${adminCheck.role} | Status: ${adminCheck.status}`);
    console.log(`     Password hash present: ${adminCheck.passwordHash ? "YES" : "NO"}`);
  } else {
    console.error("  ❌ CRITICAL: Admin account was deleted!");
  }

  // ── Step 6: Verify locations preserved ──
  const locCheck = await prisma.location.findMany({
    select: { name: true, code: true, status: true },
  });
  console.log("\n── LOCATIONS PRESERVED ──\n");
  for (const l of locCheck) {
    console.log(`  ✅ ${l.name} (${l.code}) — status: ${l.status}`);
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  CLEANUP COMPLETE`);
  console.log(`  Total records deleted: ${totalDeleted}`);
  console.log(`  Admin preserved: ${adminCheck ? "YES" : "NO"}`);
  console.log(`  Locations preserved: ${locCheck.length}`);
  console.log(`  Test customers removed: ${preCounts.customers}`);
  console.log(`  Test contributions removed: ${preCounts.contributions}`);
  console.log(`  Test withdrawals removed: ${preCounts.withdrawals}`);
  console.log(`  Test daily accounts removed: ${preCounts.dailyAccounts}`);
  console.log(`  Test expenses removed: ${preCounts.expenses}`);
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
