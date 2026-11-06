/**
 * Synthetic staging dataset for Zeli team acceptance.
 *
 * Creates fictional customers, branches, contributions, withdrawals, expenses,
 * remittances and daily accounts for the existing staging tenants. It never
 * reads or writes production data and never imports real records.
 *
 * Run inside a PostgreSQL-configured environment:
 *   RUN_SEED=1 npx tsx scripts/seed-staging-synthetic.mjs
 * or pass a Prisma client from a controlled runner.
 */

const TENANT_CODES = ["STG-A", "STG-B"];

function utcStartOfMonth(now, offset = 0) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function day(now, monthOffset, date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, date, 10));
}

const NAMES = [
  "Ama Synthetic",
  "Kojo Fictional",
  "Efua Demo",
  "Yaw Example",
  "Adjoa Sample",
  "Kwame Placeholder",
];

const BRANCH_PLAN = {
  "STG-A": {
    east: [1200, 800, 350],
    west: [600, 450],
    previousEast: [900, 600],
    previousWest: [500, 400],
  },
  "STG-B": {
    east: [700, 500],
    west: [300, 250, 200],
    previousEast: [650, 450],
    previousWest: [280, 220],
  },
};

async function ensureLocation(prisma, tenantId, code, name) {
  return prisma.location.upsert({
    where: { tenantId_code: { tenantId, code } },
    create: { tenantId, code, name, status: "active" },
    update: { name, status: "active" },
  });
}

async function ensureCustomer(prisma, tenantId, customerId, fullName, phone) {
  const existing = await prisma.customer.findFirst({ where: { tenantId, customerId } });
  if (existing) return existing;
  return prisma.customer.create({
    data: { tenantId, customerId, fullName, phone, status: "active" },
  });
}

async function ensureAccount(prisma, tenantId, customerId, accountId, dailyContribution) {
  const existing = await prisma.susuAccount.findUnique({ where: { accountId } });
  if (existing) return existing;
  return prisma.susuAccount.create({
    data: {
      tenantId,
      customerId,
      accountId,
      dailyContribution,
      status: "active",
      cardCustody: "customer",
    },
  });
}

async function ensureCycle(prisma, tenantId, accountId, dailyContribution, now) {
  const existing = await prisma.susuCycle.findFirst({
    where: { accountId, status: "active" },
  });
  if (existing) return existing;
  return prisma.susuCycle.create({
    data: {
      tenantId,
      accountId,
      cycleNumber: 1,
      startDate: utcStartOfMonth(now, -1),
      endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
      dailyContribution,
      status: "active",
      commissionCharged: false,
    },
  });
}

async function ensureCollector(prisma, tenantId, now) {
  const user = await prisma.user.findFirst({
    where: { tenantId, role: "collector", status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (!user) return null;
  let collector = await prisma.collector.findFirst({ where: { tenantId, userId: user.id } });
  if (!collector) {
    collector = await prisma.collector.create({
      data: { tenantId, userId: user.id, status: "active" },
    });
  }
  return collector;
}

async function seedTenant(prisma, code, now) {
  const tenant = await prisma.businessTenant.findFirst({ where: { code } });
  if (!tenant) return { code, skipped: "tenant_not_found" };
  const admin = await prisma.user.findFirst({
    where: { tenantId: tenant.id, role: "admin", status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) return { code, skipped: "admin_not_found" };

  const east = await ensureLocation(prisma, tenant.id, "SYN-EAST", "East Branch");
  const west = await ensureLocation(prisma, tenant.id, "SYN-WEST", "West Branch");
  await ensureLocation(prisma, tenant.id, "SYN-MAIN", "Main Branch");

  const ensureManager = async (suffix, locationId, fullName) => {
    const email = `syn-${suffix}-${code.toLowerCase()}@staging.local`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { locationId } });
      return existing;
    }
    return prisma.user.create({
      data: {
        tenantId: tenant.id,
        email,
        fullName,
        role: "worker",
        status: "active",
        passwordHash: "synthetic-not-for-login",
        momoEnabled: true,
        susuEnabled: true,
        locationId,
      },
    });
  };
  const eastManager = await ensureManager("east", east.id, "Synthetic East Manager");
  const westManager = await ensureManager("west", west.id, "Synthetic West Manager");

  // Remove only rows created by a previous run of this seed.
  await prisma.contribution.deleteMany({
    where: { tenantId: tenant.id, referenceId: { startsWith: "SYN-" } },
  });
  await prisma.withdrawal.deleteMany({
    where: { tenantId: tenant.id, referenceId: { startsWith: "SYN-" } },
  });
  await prisma.collectorRemittance.deleteMany({
    where: { tenantId: tenant.id, referenceId: { startsWith: "SYN-" } },
  });
  await prisma.dailyAccount.deleteMany({
    where: { tenantId: tenant.id, id: { startsWith: `syn-daily-${code}-` } },
  });
  await prisma.collectorCustomerAssignment.deleteMany({
    where: { tenantId: tenant.id, customer: { customerId: { startsWith: "SYN-" } } },
  });

  const plan = BRANCH_PLAN[code];
  const customers = [];
  for (let index = 0; index < NAMES.length; index += 1) {
    const customerId = `SYN-${code}-C-${String(index + 1).padStart(3, "0")}`;
    const customer = await ensureCustomer(
      prisma,
      tenant.id,
      customerId,
      `${NAMES[index]} ${code}`,
      `+23320000${String(index + 1).padStart(4, "0")}`
    );
    const account = await ensureAccount(
      prisma,
      tenant.id,
      customer.id,
      `SYN-${code}-S-${String(index + 1).padStart(3, "0")}`,
      10 + index
    );
    const cycle = await ensureCycle(prisma, tenant.id, account.id, account.dailyContribution, now);
    customers.push({ customer, account, cycle, branch: index < 4 ? east : west });
  }

  const contributions = [];
  let counter = 0;
  const addContributions = (list, manager, monthOffset, prefix) => {
    list.forEach((amount, index) => {
      const target = customers[(counter + index) % customers.length];
      counter += 1;
      contributions.push({
        tenantId: tenant.id,
        accountId: target.account.id,
        cycleId: target.cycle.id,
        amount,
        collectionDate: day(now, monthOffset, Math.min(28, 3 + index * 4)),
        channel: "direct_office",
        recordedById: manager.id,
        referenceId: `SYN-${prefix}-${code}-${index + 1}`,
      });
    });
  };

  addContributions(plan.east, eastManager, 0, "CON-E");
  addContributions(plan.west, westManager, 0, "CON-W");
  addContributions(plan.previousEast, eastManager, -1, "PREV-E");
  addContributions(plan.previousWest, westManager, -1, "PREV-W");
  await prisma.contribution.createMany({ data: contributions });

  const firstEast = customers[0];
  await prisma.withdrawal.createMany({
    data: [
      {
        tenantId: tenant.id,
        accountId: firstEast.account.id,
        cycleId: firstEast.cycle.id,
        requestedAmount: 500,
        commissionAmount: 10,
        netAmount: 490,
        remainingBalance: 900,
        status: "completed",
        authorizedById: eastManager.id,
        referenceId: `SYN-WDR-E-${code}`,
        createdAt: day(now, 0, 2),
      },
      {
        tenantId: tenant.id,
        accountId: customers[4].account.id,
        cycleId: customers[4].cycle.id,
        requestedAmount: 300,
        commissionAmount: 0,
        netAmount: 300,
        remainingBalance: 300,
        status: "pending",
        authorizedById: westManager.id,
        referenceId: `SYN-WDR-P-${code}`,
        createdAt: day(now, 0, 3),
      },
    ],
  });

  const collector = await ensureCollector(prisma, tenant.id, now);
  if (collector) {
    await prisma.collectorCustomerAssignment.createMany({
      data: customers.slice(0, 4).map((entry) => ({
        tenantId: tenant.id,
        collectorId: collector.id,
        customerId: entry.customer.id,
        accountId: entry.account.id,
        active: true,
      })),
      skipDuplicates: true,
    });
    await prisma.collectorRemittance.create({
      data: {
        tenantId: tenant.id,
        collectorId: collector.id,
        expectedAmount: 1000,
        remittedAmount: 940,
        variance: 60,
        status: "discrepancy",
        recordedById: admin.id,
        referenceId: `SYN-REM-${code}`,
        createdAt: day(now, 0, 3),
        notes: "Synthetic shortfall fixture for reconciliation testing.",
      },
    });
  }

  await prisma.dailyAccount.create({
    data: {
      id: `syn-daily-${code}-EAST`,
      tenantId: tenant.id,
      locationId: east.id,
      workerId: eastManager.id,
        businessDate: day(now, 0, 1),
        openingMomoFloat: 200,
        openingCash: 100,
        totalCashIn: 1200,
        totalCashOut: 80,
        totalCashReceived: 500,
        totalCashPaid: 400,
        commission: 80,
        otherIncome: 40,
        closingMomoFloat: 1320,
        closingCash: 140,
        totalExpenses: 240,
        status: "submitted",
        submittedAt: new Date(),
        expenses: {
          create: [
            { tenantId: tenant.id, description: "Synthetic transport", amount: 140 },
            { tenantId: tenant.id, description: "Synthetic supplies", amount: 100 },
          ],
        },
      },
    });
  await prisma.dailyAccount.create({
    data: {
      id: `syn-daily-${code}-WEST`,
      tenantId: tenant.id,
      locationId: west.id,
      workerId: westManager.id,
        businessDate: day(now, 0, 2),
        openingMomoFloat: 150,
        openingCash: 60,
        totalCashIn: 600,
        totalCashOut: 40,
        totalCashReceived: 260,
        totalCashPaid: 240,
        commission: 50,
        otherIncome: 25,
        closingMomoFloat: 710,
        closingCash: 80,
        totalExpenses: 120,
        status: "draft",
        expenses: {
          create: [{ tenantId: tenant.id, description: "Synthetic fuel", amount: 120 }],
        },
      },
    });
  await prisma.zeliEntitlement.upsert({
    where: { tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" } },
    create: {
      tenantId: tenant.id,
      featureKey: "zeli_analytics",
      status: "active",
      source: "manual",
      reason: "Synthetic staging acceptance entitlement",
      grantedByType: "platform",
    },
    update: { status: "active", reason: "Synthetic staging acceptance entitlement" },
  });

  return {
    code,
    customers: customers.length,
    contributions: contributions.length,
    withdrawals: 2,
    remittances: collector ? 1 : 0,
    dailyAccounts: 2,
  };
}

export async function seedStagingSynthetic(prisma) {
  const now = new Date();
  const tenants = [];
  for (const code of TENANT_CODES) {
    tenants.push(await seedTenant(prisma, code, now));
  }
  await prisma.zeliAvailability.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: true, reason: "Synthetic staging availability" },
    update: { enabled: true },
  });
  return { tenants };
}

if (process.env.RUN_SEED === "1") {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const summary = await seedStagingSynthetic(prisma);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
