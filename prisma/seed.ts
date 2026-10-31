import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Well-known tenant code for the pre-existing BIK Prestige Enterprise tenant.
// Deliberately deterministic so the seed and the production backfill script
// address the same tenant across environments.
export const BIK_TENANT_CODE = "BIK-HQ-001";

async function main() {
  console.log("🌱 Seeding BIK Prestige Enterprise database...\n");

  const adminPassword = await bcrypt.hash("Admin123", 12);
  const workerPassword = await bcrypt.hash("Worker123", 12);
  const collectorPassword = await bcrypt.hash("Collector123", 12);

  // 0. Ensure the BIK Prestige Enterprise tenant exists
  const bikTenant = await prisma.businessTenant.upsert({
    where: { code: BIK_TENANT_CODE },
    update: {},
    create: {
      code: BIK_TENANT_CODE,
      name: "BIK Prestige Enterprise",
      contactEmail: "admin@bikprestige.com",
      contactPhone: "+233240000000",
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  console.log(`✅ Tenant: ${bikTenant.name} (${bikTenant.code})`);
  const tenantId = bikTenant.id;

  // 1. Create Admin User
  const admin = await prisma.user.upsert({
    where: { email: "admin@bikprestige.com" },
    update: { tenantId },
    create: {
      email: "admin@bikprestige.com",
      fullName: "BIK Admin",
      phone: "+233240000000",
      role: "admin",
      status: "active",
      passwordHash: adminPassword,
      tenantId,
    },
  });
  if (!bikTenant.primaryAdminUserId) {
    await prisma.businessTenant.update({
      where: { id: tenantId },
      data: { primaryAdminUserId: admin.id },
    });
  }
  console.log(`✅ Admin: ${admin.email}`);

  // 2. Create MoMo Locations
  const locations = [
    { name: "BIK Prestige - Accra Central", code: "ACC-001", address: "123 Independence Ave, Accra", contactPhone: "+233241111111", description: "Main branch in central Accra" },
    { name: "BIK Prestige - Kumasi", code: "KMS-001", address: "45 Adum Road, Kumasi", contactPhone: "+233242222222", description: "Kumasi branch" },
    { name: "BIK Prestige - Takoradi", code: "TKD-001", address: "78 Market Road, Takoradi", contactPhone: "+233243333333", description: "Takoradi branch" },
    { name: "BIK Prestige - Tamale", code: "TML-001", address: "90 Liberation Road, Tamale", contactPhone: "+233244444444", description: "Tamale branch" },
  ];

  const createdLocations = [];
  for (const loc of locations) {
    const created = await prisma.location.upsert({
      where: { tenantId_code: { tenantId, code: loc.code } },
      update: {},
      create: { ...loc, tenantId },
    });
    createdLocations.push(created);
    console.log(`✅ Location: ${created.name} (${created.code})`);
  }

  // 3. Create MoMo Workers
  const workers = [
    { email: "kwame@bikprestige.com", fullName: "Kwame Mensah", phone: "+233251111111", locationIndex: 0 },
    { email: "ama@bikprestige.com", fullName: "Ama Asante", phone: "+233252222222", locationIndex: 1 },
    { email: "kofi@bikprestige.com", fullName: "Kofi Boateng", phone: "+233253333333", locationIndex: 2 },
    { email: "efua@bikprestige.com", fullName: "Efua Darko", phone: "+233254444444", locationIndex: 3 },
  ];

  for (const w of workers) {
    const created = await prisma.user.upsert({
      where: { email: w.email },
      update: {},
      create: { email: w.email, fullName: w.fullName, phone: w.phone, role: "worker", status: "active", passwordHash: workerPassword, locationId: createdLocations[w.locationIndex].id, momoEnabled: true, tenantId },
    });
    console.log(`✅ Worker: ${created.fullName} → ${createdLocations[w.locationIndex].name}`);
  }

  // 4. Create Sample MoMo Daily Accounts
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sampleAccounts = [
    { locationId: createdLocations[0].id, workerId: (await prisma.user.findUnique({ where: { email: "kwame@bikprestige.com" } }))!.id, businessDate: new Date(today.getTime() - 2 * 86400000), openingMomoFloat: 500, openingCash: 300, totalCashIn: 2000, totalCashOut: 1500, totalCashReceived: 800, totalCashPaid: 200, commission: 50, otherIncome: 0, closingMomoFloat: 1000, closingCash: 950, totalExpenses: 35, calculatedMomoVariance: 0, calculatedCashVariance: 0, status: "reviewed", submittedAt: new Date(today.getTime() - 2 * 86400000 + 18 * 3600000), expenses: [{ description: "Transport", amount: 15 }, { description: "Airtime", amount: 10 }, { description: "Miscellaneous", amount: 10 }] },
    { locationId: createdLocations[1].id, workerId: (await prisma.user.findUnique({ where: { email: "ama@bikprestige.com" } }))!.id, businessDate: new Date(today.getTime() - 2 * 86400000), openingMomoFloat: 800, openingCash: 500, totalCashIn: 3000, totalCashOut: 2200, totalCashReceived: 1200, totalCashPaid: 400, commission: 75, otherIncome: 0, closingMomoFloat: 1600, closingCash: 1300, totalExpenses: 75, calculatedMomoVariance: 0, calculatedCashVariance: 0, status: "submitted", submittedAt: new Date(today.getTime() - 2 * 86400000 + 17 * 3600000), expenses: [{ description: "Transport", amount: 25 }, { description: "Airtime", amount: 20 }, { description: "Miscellaneous", amount: 30 }] },
    { locationId: createdLocations[2].id, workerId: (await prisma.user.findUnique({ where: { email: "kofi@bikprestige.com" } }))!.id, businessDate: new Date(today.getTime() - 1 * 86400000), openingMomoFloat: 600, openingCash: 400, totalCashIn: 1800, totalCashOut: 1400, totalCashReceived: 900, totalCashPaid: 300, commission: 60, otherIncome: 0, closingMomoFloat: 1000, closingCash: 1000, totalExpenses: 50, calculatedMomoVariance: 0, calculatedCashVariance: -10, status: "submitted", submittedAt: new Date(today.getTime() - 1 * 86400000 + 18 * 3600000), expenses: [{ description: "Transport", amount: 20 }, { description: "Airtime", amount: 15 }, { description: "Miscellaneous", amount: 15 }] },
  ];

  for (const acct of sampleAccounts) {
    const { expenses, ...acctData } = acct;
    try {
      await prisma.dailyAccount.create({ data: { ...acctData, tenantId, expenses: { create: expenses.map((e) => ({ ...e, tenantId })) } } });
      console.log(`✅ Daily Account: ${createdLocations.find((l) => l.id === acct.locationId)?.name} — ${acct.businessDate.toISOString().split("T")[0]}`);
    } catch { console.log(`⚠️  Daily Account skipped: ${acct.businessDate.toISOString().split("T")[0]}`); }
  }

  // =====================
  // SUSU MODULE SEED
  // =====================
  console.log("\n--- Susu Module ---");

  // 5. Create Susu Collectors (users with collector role)
  const collectors = [
    { email: "kwadwo@bikprestige.com", fullName: "Kwadwo Amoako", phone: "+233261111111" },
    { email: "akosua@bikprestige.com", fullName: "Akosua Bemleh", phone: "+233262222222" },
  ];

  const createdCollectorUsers = [];
  for (const c of collectors) {
    const user = await prisma.user.upsert({
      where: { email: c.email },
      update: {},
      create: { email: c.email, fullName: c.fullName, phone: c.phone, role: "collector", status: "active", passwordHash: collectorPassword, susuEnabled: true, tenantId },
    });
    const collector = await prisma.collector.upsert({
      where: { userId: user.id },
      update: { tenantId },
      create: { userId: user.id, status: "active", tenantId },
    });
    createdCollectorUsers.push({ user, collector });
    console.log(`✅ Collector: ${user.fullName}`);
  }

  // 6. Create Susu Customers
  const customers = [
    { fullName: "Ama Mensah", phone: "+233271111111", address: "Accra", dailyContribution: 50 },
    { fullName: "Kofi Annan", phone: "+233272222222", address: "Kumasi", dailyContribution: 20 },
    { fullName: "Efua Nyarko", phone: "+233273333333", address: "Takoradi", dailyContribution: 100 },
    { fullName: "Yaw Boateng", phone: "+233274444444", address: "Tamale", dailyContribution: 1 },
    { fullName: "Abena Osei", phone: "+233275555555", address: "Accra", dailyContribution: 1000 },
  ];

  let cardCounter = 1;
  for (const c of customers) {
    const customerId = `BIK-C-${String(cardCounter).padStart(6, "0")}`;
    const accountId = `BIK-S-${String(cardCounter).padStart(6, "0")}`;

    const customer = await prisma.customer.create({
      data: {
        customerId,
        fullName: c.fullName,
        phone: c.phone,
        address: c.address,
        status: "active",
        tenantId,
      },
    });

    const susuAccount = await prisma.susuAccount.create({
      data: {
        accountId,
        customerId: customer.id,
        dailyContribution: c.dailyContribution,
        status: "active",
        cardCustody: "customer",
        tenantId,
      },
    });

    // Record card fee
    await prisma.cardFee.create({
      data: {
        accountId: susuAccount.id,
        amount: 10,
        recordedById: admin.id,
        notes: "Initial card purchase",
        tenantId,
      },
    });

    // Create first cycle
    const cycleStart = new Date(today);
    cycleStart.setDate(1); // Start of current month
    const cycleEnd = new Date(cycleStart);
    cycleEnd.setDate(31);

    const cycle = await prisma.susuCycle.create({
      data: {
        accountId: susuAccount.id,
        cycleNumber: 1,
        startDate: cycleStart,
        endDate: cycleEnd,
        dailyContribution: c.dailyContribution,
        status: "active",
        commissionCharged: false,
        tenantId,
      },
    });

    // Assign collector (alternate between collectors)
    const collectorIndex = cardCounter <= 3 ? 0 : 1;
    await prisma.collectorCustomerAssignment.create({
      data: {
        collectorId: createdCollectorUsers[collectorIndex].collector.id,
        customerId: customer.id,
        accountId: susuAccount.id,
        tenantId,
      },
    });

    console.log(`✅ Customer: ${customer.fullName} (${customerId}) — Account: ${accountId} — GH₵${c.dailyContribution}/day`);
    cardCounter++;
  }

  console.log("\n🎉 Seeding complete!");
  console.log("\n📋 Dev Credentials:");
  console.log("─────────────────────────────────");
  console.log("Admin:      admin@bikprestige.com / Admin123");
  console.log("Worker 1:   kwame@bikprestige.com / Worker123 (Accra Central)");
  console.log("Worker 2:   ama@bikprestige.com / Worker123 (Kumasi)");
  console.log("Worker 3:   kofi@bikprestige.com / Worker123 (Takoradi)");
  console.log("Worker 4:   efua@bikprestige.com / Worker123 (Tamale)");
  console.log("Collector 1: kwadwo@bikprestige.com / Collector123");
  console.log("Collector 2: akosua@bikprestige.com / Collector123");
  console.log("─────────────────────────────────");
}

main().then(async () => { await prisma.$disconnect(); }).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
