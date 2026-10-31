import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  BIK PRESTIGE ENTERPRISE — DATABASE INVENTORY");
  console.log("═══════════════════════════════════════════════════\n");

  // Users
  const users = await prisma.user.findMany({
    select: { id: true, email: true, fullName: true, role: true, status: true, momoEnabled: true, susuEnabled: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`USERS: ${users.length}`);
  for (const u of users) {
    console.log(`  [${u.role}] ${u.fullName} (${u.email}) — status: ${u.status}, momo: ${u.momoEnabled}, susu: ${u.susuEnabled}`);
  }

  // Collectors
  const collectors = await prisma.collector.findMany({
    select: { id: true, userId: true, status: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nCOLLECTORS: ${collectors.length}`);
  for (const c of collectors) {
    const user = users.find(u => u.id === c.userId);
    console.log(`  ${user?.fullName || "UNKNOWN"} (${c.userId}) — status: ${c.status}`);
  }

  // Locations
  const locations = await prisma.location.findMany({
    select: { id: true, name: true, code: true, status: true },
    orderBy: { code: "asc" },
  });
  console.log(`\nLOCATIONS: ${locations.length}`);
  for (const l of locations) {
    console.log(`  ${l.name} (${l.code}) — status: ${l.status}`);
  }

  // Customers
  const customers = await prisma.customer.findMany({
    select: { id: true, customerId: true, fullName: true, phone: true, status: true, portalEnabled: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nCUSTOMERS: ${customers.length}`);
  for (const c of customers) {
    console.log(`  ${c.fullName} (${c.customerId}) — phone: ${c.phone}, portal: ${c.portalEnabled}`);
  }

  // Susu Accounts
  const susuAccounts = await prisma.susuAccount.findMany({
    select: { id: true, accountId: true, customerId: true, dailyContribution: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nSUSU ACCOUNTS: ${susuAccounts.length}`);
  for (const sa of susuAccounts) {
    const cust = customers.find(c => c.id === sa.customerId);
    console.log(`  ${sa.accountId} — ${cust?.fullName || "UNKNOWN"} — GH₵${sa.dailyContribution}/day — status: ${sa.status}`);
  }

  // Susu Cycles
  const susuCycles = await prisma.susuCycle.findMany({
    select: { id: true, accountId: true, cycleNumber: true, startDate: true, endDate: true, status: true, dailyContribution: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nSUSU CYCLES: ${susuCycles.length}`);
  for (const sc of susuCycles) {
    const acct = susuAccounts.find(a => a.id === sc.accountId);
    console.log(`  Cycle #${sc.cycleNumber} for ${acct?.accountId || "UNKNOWN"} — ${sc.startDate.toISOString().split("T")[0]} to ${sc.endDate.toISOString().split("T")[0]} — status: ${sc.status}`);
  }

  // Contributions
  const contributions = await prisma.contribution.findMany({
    select: { id: true, accountId: true, cycleId: true, amount: true, collectionDate: true, channel: true, referenceId: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nCONTRIBUTIONS: ${contributions.length}`);
  let totalContributions = 0;
  for (const c of contributions) {
    totalContributions += Number(c.amount);
    const acct = susuAccounts.find(a => a.id === c.accountId);
    console.log(`  ${acct?.accountId || "UNKNOWN"} — GH₵${c.amount} on ${c.collectionDate.toISOString().split("T")[0]} via ${c.channel}`);
  }
  console.log(`  Total contribution amount: GH₵${totalContributions}`);

  // Contribution Allocations
  const allocations = await prisma.contributionAllocation.findMany({
    select: { id: true, contributionId: true, cycleDay: true, amount: true },
  });
  console.log(`\nCONTRIBUTION ALLOCATIONS: ${allocations.length}`);

  // Withdrawals
  const withdrawals = await prisma.withdrawal.findMany({
    select: { id: true, accountId: true, cycleId: true, requestedAmount: true, commissionAmount: true, netAmount: true, remainingBalance: true, status: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nWITHDRAWALS: ${withdrawals.length}`);
  let totalWithdrawn = 0;
  for (const w of withdrawals) {
    totalWithdrawn += Number(w.netAmount);
    const acct = susuAccounts.find(a => a.id === w.accountId);
    console.log(`  ${acct?.accountId || "UNKNOWN"} — GH₵${w.netAmount} (requested: GH₵${w.requestedAmount}, commission: GH₵${w.commissionAmount}) — status: ${w.status}`);
  }
  console.log(`  Total withdrawn: GH₵${totalWithdrawn}`);

  // Commissions
  const commissions = await prisma.commission.findMany({
    select: { id: true, accountId: true, cycleId: true, amount: true, basis: true, triggeredBy: true },
  });
  console.log(`\nCOMMISSIONS: ${commissions.length}`);

  // Card Fees
  const cardFees = await prisma.cardFee.findMany({
    select: { id: true, accountId: true, amount: true, notes: true },
  });
  console.log(`\nCARD FEES: ${cardFees.length}`);

  // Collector-Customer Assignments
  const assignments = await prisma.collectorCustomerAssignment.findMany({
    select: { id: true, collectorId: true, customerId: true, accountId: true, active: true, unassignedAt: true },
  });
  console.log(`\nCOLLECTOR-CUSTOMER ASSIGNMENTS: ${assignments.length}`);

  // Collector Remittances
  const remittances = await prisma.collectorRemittance.findMany({
    select: { id: true, collectorId: true, expectedAmount: true, remittedAmount: true, variance: true, status: true, createdAt: true },
  });
  console.log(`\nCOLLECTOR REMITTANCES: ${remittances.length}`);
  let totalRemitted = 0;
  for (const r of remittances) {
    totalRemitted += Number(r.remittedAmount);
    const coll = collectors.find(c => c.id === r.collectorId);
    const user = coll ? users.find(u => u.id === coll.userId) : null;
    console.log(`  ${user?.fullName || "UNKNOWN"} — expected: GH₵${r.expectedAmount}, remitted: GH₵${r.remittedAmount}, variance: GH₵${r.variance} — status: ${r.status}`);
  }
  console.log(`  Total remitted: GH₵${totalRemitted}`);

  // Money Handed In (check if model exists)
  try {
    // @ts-expect-error -- optional model may not exist in this schema
    const moneyHandedIn = await prisma.moneyHandedIn?.findMany({
      select: { id: true },
    });
    console.log(`\nMONEY HANDED IN: ${moneyHandedIn?.length || 0}`);
  } catch {
    console.log(`\nMONEY HANDED IN: Model not found (may use different name)`);
  }

  // Daily Accounts (MoMo)
  const dailyAccounts = await prisma.dailyAccount.findMany({
    select: { id: true, locationId: true, workerId: true, businessDate: true, totalCashIn: true, totalCashOut: true, totalExpenses: true, status: true },
    orderBy: { businessDate: "asc" },
  });
  console.log(`\nDAILY ACCOUNTS (MoMo): ${dailyAccounts.length}`);
  for (const da of dailyAccounts) {
    const loc = locations.find(l => l.id === da.locationId);
    const worker = users.find(u => u.id === da.workerId);
    console.log(`  ${loc?.name || "UNKNOWN"} — ${da.businessDate.toISOString().split("T")[0]} — cash in: GH₵${da.totalCashIn}, cash out: GH₵${da.totalCashOut} — status: ${da.status}`);
  }

  // Expenses
  const expenses = await prisma.expense.findMany({
    select: { id: true, dailyAccountId: true, description: true, amount: true },
  });
  console.log(`\nEXPENSES: ${expenses.length}`);
  let totalExpenses = 0;
  for (const e of expenses) {
    totalExpenses += Number(e.amount);
  }
  console.log(`  Total expenses: GH₵${totalExpenses}`);

  // Password Reset Tokens
  const passwordTokens = await prisma.passwordResetToken.findMany({
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });
  console.log(`\nPASSWORD RESET TOKENS: ${passwordTokens.length}`);

  // Device Enrollments
  const devices = await prisma.deviceEnrollment.findMany({
    select: { id: true, userId: true, deviceId: true, deviceName: true, module: true, status: true },
  });
  console.log(`\nDEVICE ENROLLMENTS: ${devices.length}`);
  for (const d of devices) {
    const user = users.find(u => u.id === d.userId);
    console.log(`  ${d.deviceName || d.deviceId} — module: ${d.module} — user: ${user?.fullName || "UNKNOWN"} — status: ${d.status}`);
  }

  // Offline Transactions
  const offlineTxns = await prisma.offlineTransaction.findMany({
    select: { id: true, deviceId: true, userId: true, type: true, status: true },
  });
  console.log(`\nOFFLINE TRANSACTIONS: ${offlineTxns.length}`);

  // Audit Logs
  const auditLogs = await prisma.auditLog.findMany({
    select: { id: true, userId: true, action: true, entityType: true, entityId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nAUDIT LOGS: ${auditLogs.length}`);

  // Identify admin
  const admins = users.filter(u => u.role === "admin");
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  ADMIN ACCOUNT(S): ${admins.length}`);
  for (const a of admins) {
    console.log(`  → ${a.fullName} (${a.email}) — ID: ${a.id}`);
  }

  // Summary
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`═══════════════════════════════════════════════════`);
  console.log(`  Users:                    ${users.length}`);
  console.log(`    Admin:                  ${admins.length}`);
  console.log(`    Workers:                ${users.filter(u => u.role === "worker").length}`);
  console.log(`    Collectors:             ${users.filter(u => u.role === "collector").length}`);
  console.log(`  Locations:                ${locations.length}`);
  console.log(`  Customers:                ${customers.length}`);
  console.log(`  Susu Accounts:            ${susuAccounts.length}`);
  console.log(`  Susu Cycles:              ${susuCycles.length}`);
  console.log(`  Contributions:            ${contributions.length} (total: GH₵${totalContributions})`);
  console.log(`  Contribution Allocations: ${allocations.length}`);
  console.log(`  Withdrawals:              ${withdrawals.length} (total: GH₵${totalWithdrawn})`);
  console.log(`  Commissions:              ${commissions.length}`);
  console.log(`  Card Fees:                ${cardFees.length}`);
  console.log(`  Collector Assignments:    ${assignments.length}`);
  console.log(`  Collector Remittances:    ${remittances.length} (total: GH₵${totalRemitted})`);
  console.log(`  Daily Accounts (MoMo):    ${dailyAccounts.length}`);
  console.log(`  Expenses:                 ${expenses.length} (total: GH₵${totalExpenses})`);
  console.log(`  Password Reset Tokens:    ${passwordTokens.length}`);
  console.log(`  Device Enrollments:       ${devices.length}`);
  console.log(`  Offline Transactions:     ${offlineTxns.length}`);
  console.log(`  Audit Logs:               ${auditLogs.length}`);
  console.log(`═══════════════════════════════════════════════════`);
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
