/**
 * Deterministic Playwright fixtures: two synthetic tenants, one entitled and
 * one not, plus a platform operator. Credentials are test-only and are never
 * used outside tests/e2e.db.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("E2ePass123!", 10);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 12));
  const day = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.max(1, now.getUTCDate() - offset), 10));
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.max(1, now.getUTCDate() - 1)));

  const tenantA = await prisma.businessTenant.create({
    data: {
      id: "e2e-tenant-a",
      code: "E2E-A",
      name: "E2E Bloom Business A",
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  const tenantB = await prisma.businessTenant.create({
    data: {
      id: "e2e-tenant-b",
      code: "E2E-B",
      name: "E2E Bloom Business B",
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
      momoEnabled: true,
      susuEnabled: true,
    },
  });

  const tenantC = await prisma.businessTenant.create({
    data: {
      id: "e2e-tenant-c",
      code: "E2E-C",
      name: "E2E Bloom Business C",
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
      // A MoMo-only tenant. Draft persistence must not assume the Susu module.
      momoEnabled: true,
      susuEnabled: false,
    },
  });

  const adminA = await prisma.user.create({
    data: {
      id: "e2e-user-a",
      tenantId: tenantA.id,
      email: "e2e-admin-a@test.local",
      fullName: "E2E Admin A",
      role: "admin",
      status: "active",
      passwordHash,
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  await prisma.user.create({
    data: {
      id: "e2e-user-b",
      tenantId: tenantB.id,
      email: "e2e-admin-b@test.local",
      fullName: "E2E Admin B",
      role: "admin",
      status: "active",
      passwordHash,
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  await prisma.user.create({
    data: {
      id: "e2e-user-c",
      tenantId: tenantC.id,
      email: "e2e-admin-c@test.local",
      fullName: "E2E Admin C",
      role: "admin",
      status: "active",
      passwordHash,
      momoEnabled: true,
      susuEnabled: false,
    },
  });
  await prisma.businessTenant.update({
    where: { id: tenantA.id },
    data: { primaryAdminUserId: adminA.id },
  });

  const locationA = await prisma.location.create({
    data: {
      id: "e2e-location-a",
      tenantId: tenantA.id,
      code: "E2E-LOC",
      name: "E2E Accra Branch",
      status: "active",
    },
  });
  await prisma.user.update({
    where: { id: adminA.id },
    data: { locationId: locationA.id },
  });

  const workerUser = await prisma.user.create({
    data: {
      id: "e2e-worker-user",
      tenantId: tenantA.id,
      email: "e2e-worker@test.local",
      fullName: "E2E MoMo Agent",
      role: "worker",
      status: "active",
      passwordHash,
      momoEnabled: true,
      susuEnabled: false,
      locationId: locationA.id,
    },
  });

  const customerA = await prisma.customer.create({
    data: {
      id: "e2e-customer-a",
      tenantId: tenantA.id,
      customerId: "E2E-C-001",
      fullName: "E2E Customer A",
      phone: "+233200000901",
      email: "e2e-customer@test.local",
      status: "active",
      registeredAt: day(2),
      portalEnabled: true,
      portalPasswordHash: passwordHash,
    },
  });
  const accountA = await prisma.susuAccount.create({
    data: {
      id: "e2e-account-a",
      tenantId: tenantA.id,
      accountId: "E2E-S-001",
      customerId: customerA.id,
      dailyContribution: 10,
      status: "active",
    },
  });
  const cycleA = await prisma.susuCycle.create({
    data: {
      id: "e2e-cycle-a",
      tenantId: tenantA.id,
      accountId: accountA.id,
      cycleNumber: 1,
      startDate: monthStart,
      endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
      dailyContribution: 10,
      status: "active",
    },
  });

  await prisma.contribution.createMany({
    data: [
      {
        tenantId: tenantA.id,
        accountId: accountA.id,
        cycleId: cycleA.id,
        amount: 350,
        collectionDate: day(1),
        channel: "direct_office",
        recordedById: adminA.id,
        referenceId: "E2E-CON-1",
      },
      {
        tenantId: tenantA.id,
        accountId: accountA.id,
        cycleId: cycleA.id,
        amount: 150,
        collectionDate: day(0),
        channel: "direct_office",
        recordedById: adminA.id,
        referenceId: "E2E-CON-2",
      },
      {
        tenantId: tenantA.id,
        accountId: accountA.id,
        cycleId: cycleA.id,
        amount: 275,
        collectionDate: previousMonth,
        channel: "direct_office",
        recordedById: adminA.id,
        referenceId: "E2E-CON-PREV",
      },
      {
        tenantId: tenantA.id,
        accountId: accountA.id,
        cycleId: cycleA.id,
        amount: 9999,
        collectionDate: day(3),
        channel: "direct_office",
        recordedById: adminA.id,
        referenceId: "E2E-CON-REVERSED",
        reversedAt: day(2),
      },
    ],
  });

  await prisma.withdrawal.createMany({
    data: [
      {
        tenantId: tenantA.id,
        accountId: accountA.id,
        cycleId: cycleA.id,
        requestedAmount: 80,
        commissionAmount: 10,
        netAmount: 80,
        remainingBalance: 100,
        status: "completed",
        authorizedById: adminA.id,
        referenceId: "E2E-WDR-1",
        createdAt: day(1),
      },
      {
        tenantId: tenantA.id,
        accountId: accountA.id,
        cycleId: cycleA.id,
        requestedAmount: 40,
        commissionAmount: 0,
        netAmount: 40,
        remainingBalance: 60,
        status: "pending",
        authorizedById: adminA.id,
        referenceId: "E2E-WDR-PENDING",
        createdAt: day(0),
      },
    ],
  });

  const collectorUser = await prisma.user.create({
    data: {
      id: "e2e-collector-user",
      tenantId: tenantA.id,
      email: "e2e-collector@test.local",
      fullName: "E2E Collector",
      role: "collector",
      status: "active",
      passwordHash,
      susuEnabled: true,
      locationId: locationA.id,
    },
  });
  const collector = await prisma.collector.create({
    data: { id: "e2e-collector", tenantId: tenantA.id, userId: collectorUser.id, status: "active" },
  });
  await prisma.collectorCustomerAssignment.create({
    data: {
      id: "e2e-assignment-1",
      tenantId: tenantA.id,
      collectorId: collector.id,
      customerId: customerA.id,
      accountId: accountA.id,
      active: true,
    },
  });

  // A second assigned customer with a fresh 31-day cycle and no contribution
  // recorded today. The collector workflow test can record a real collection
  // for this customer without colliding with the statement fixtures above.
  const customerB = await prisma.customer.create({
    data: {
      id: "e2e-customer-b",
      tenantId: tenantA.id,
      customerId: "E2E-C-002",
      fullName: "E2E Customer B",
      phone: "+233200000902",
      email: "e2e-customer-b@test.local",
      status: "active",
      registeredAt: day(5),
      portalEnabled: true,
      portalPasswordHash: passwordHash,
    },
  });
  const accountB = await prisma.susuAccount.create({
    data: {
      id: "e2e-account-b",
      tenantId: tenantA.id,
      accountId: "E2E-S-002",
      customerId: customerB.id,
      dailyContribution: 20,
      status: "active",
    },
  });
  await prisma.susuCycle.create({
    data: {
      id: "e2e-cycle-b",
      tenantId: tenantA.id,
      accountId: accountB.id,
      cycleNumber: 1,
      startDate: monthStart,
      endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
      dailyContribution: 20,
      status: "active",
    },
  });
  await prisma.collectorCustomerAssignment.create({
    data: {
      id: "e2e-assignment-2",
      tenantId: tenantA.id,
      collectorId: collector.id,
      customerId: customerB.id,
      accountId: accountB.id,
      active: true,
    },
  });
  await prisma.collectorRemittance.create({
    data: {
      tenantId: tenantA.id,
      collectorId: collector.id,
      expectedAmount: 500,
      remittedAmount: 470,
      variance: 30,
      status: "discrepancy",
      recordedById: adminA.id,
      referenceId: "E2E-REM-1",
      createdAt: day(0),
      notes: "Short by GH₵30 pending review",
    },
  });

  await prisma.dailyAccount.create({
    data: {
      id: "e2e-daily-a",
      tenantId: tenantA.id,
      locationId: locationA.id,
      workerId: workerUser.id,
      businessDate: yesterday,
      openingMomoFloat: 100,
      openingCash: 50,
      totalCashIn: 200,
      totalCashOut: 20,
      totalCashReceived: 80,
      totalCashPaid: 10,
      commission: 5,
      otherIncome: 0,
      closingMomoFloat: 280,
      closingCash: 125,
      totalExpenses: 5,
      status: "submitted",
      submittedAt: new Date(),
      expenses: {
        create: [{ tenantId: tenantA.id, description: "Transport", amount: 5 }],
      },
    },
  });

  // Two untouched drafts on their own business dates. The worker can open one
  // and submit a positive or shortage reconciliation without fighting the
  // one-account-per-location-per-day rule.
  const positiveDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 5));
  const shortageDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 6));
  const draftDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 7));
  await prisma.dailyAccount.createMany({
    data: [
      {
        id: "e2e-daily-positive",
        tenantId: tenantA.id,
        locationId: locationA.id,
        workerId: workerUser.id,
        businessDate: positiveDate,
        status: "draft",
      },
      {
        id: "e2e-daily-shortage",
        tenantId: tenantA.id,
        locationId: locationA.id,
        workerId: workerUser.id,
        businessDate: shortageDate,
        status: "draft",
      },
      {
        id: "e2e-daily-draft",
        tenantId: tenantA.id,
        locationId: locationA.id,
        workerId: workerUser.id,
        businessDate: draftDate,
        status: "draft",
      },
    ],
  });

  await prisma.zeliEntitlement.create({
    data: {
      tenantId: tenantA.id,
      featureKey: "zeli_analytics",
      status: "active",
      source: "manual",
      reason: "E2E active subscription fixture",
      grantedByType: "platform",
    },
  });

  await prisma.zeliAvailability.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: true, reason: "E2E default" },
    update: { enabled: true, reason: "E2E default" },
  });

  await prisma.platformSuperAdmin.create({
    data: {
      id: "e2e-platform-admin",
      email: "e2e-platform@test.local",
      fullName: "E2E Platform Operator",
      passwordHash,
      status: "active",
    },
  });

  console.log(
    JSON.stringify(
      {
        tenantA: tenantA.code,
        tenantB: tenantB.code,
        adminA: "e2e-admin-a@test.local",
        adminB: "e2e-admin-b@test.local",
        adminC: "e2e-admin-c@test.local",
        platform: "e2e-platform@test.local",
        dailyAccountId: "e2e-daily-a",
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
