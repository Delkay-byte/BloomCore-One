import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ════════════════════════════════════════════════════════════════
//  BIK PRESTIGE — PRODUCTION DATABASE CLEANUP (PostgreSQL)
//  Run against Render database: DATABASE_URL=<render-postgres-url>
//  Usage: npx tsx scripts/cleanup-production.ts
// ════════════════════════════════════════════════════════════════

const PRESERVED_ADMIN_EMAIL = "admin@bikprestige.com";

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  BIK PRESTIGE — PRODUCTION DATABASE CLEANUP");
  console.log("═══════════════════════════════════════════════════\n");

  // Identify admin
  const admin = await prisma.user.findUnique({
    where: { email: PRESERVED_ADMIN_EMAIL },
    select: { id: true, email: true, fullName: true, role: true },
  });

  if (!admin) {
    console.error("❌ CRITICAL: Admin account not found! Aborting.");
    process.exit(1);
  }
  console.log(`✅ Admin preserved: ${admin.fullName} (${admin.email}) — ID: ${admin.id}\n`);

  let totalDeleted = 0;

  // FK-safe deletion order
  const steps = [
    ["Password Reset Tokens", () => prisma.passwordResetToken.deleteMany({})],
    ["Offline Transactions", () => prisma.offlineTransaction.deleteMany({})],
    ["Device Enrollments", () => prisma.deviceEnrollment.deleteMany({})],
    ["Audit Logs", () => prisma.auditLog.deleteMany({})],
    ["Contribution Allocations", () => prisma.contributionAllocation.deleteMany({})],
    ["Contributions", () => prisma.contribution.deleteMany({})],
    ["Commissions", () => prisma.commission.deleteMany({})],
    ["Withdrawals", () => prisma.withdrawal.deleteMany({})],
    ["Card Fees", () => prisma.cardFee.deleteMany({})],
    ["Collector Remittances", () => prisma.collectorRemittance.deleteMany({})],
    ["Collector-Customer Assignments", () => prisma.collectorCustomerAssignment.deleteMany({})],
    ["Susu Cycles", () => prisma.susuCycle.deleteMany({})],
    ["Susu Accounts", () => prisma.susuAccount.deleteMany({})],
    ["Customers", () => prisma.customer.deleteMany({})],
    ["Expenses", () => prisma.expense.deleteMany({})],
    ["Daily Accounts", () => prisma.dailyAccount.deleteMany({})],
    ["Collector Records", () => prisma.collector.deleteMany({})],
    ["Non-Admin Users", () => prisma.user.deleteMany({ where: { role: { not: "admin" } } })],
  ];

  for (const [name, fn] of steps) {
    const result = await (fn as () => Promise<{ count: number }>)();
    console.log(`  ✓ ${name}: ${result.count} deleted`);
    totalDeleted += result.count;
  }

  // Verify
  const userCount = await prisma.user.count();
  const adminExists = await prisma.user.findUnique({ where: { email: PRESERVED_ADMIN_EMAIL } });

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  CLEANUP COMPLETE — ${totalDeleted} records deleted`);
  console.log(`  Admin preserved: ${adminExists ? "YES" : "NO"}`);
  console.log(`  Users remaining: ${userCount}`);
  console.log(`═══════════════════════════════════════════════════`);
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
