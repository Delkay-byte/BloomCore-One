/**
 * Synthetic staging seed. Refuses to run unless the operator confirms the
 * target. It never reads production data and never prints to application logs;
 * credentials are printed once to the operator console for out-of-band delivery.
 *
 * Required:
 *   APP_ENV=STAGING
 *   STAGING_SEED_CONFIRM=YES
 *   DATABASE_URL=<dedicated staging database>
 * Optional:
 *   STAGING_SEED_PASSWORD=<strong temporary password>
 */
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function guard() {
  const appEnv = (process.env.APP_ENV || "").toUpperCase();
  const confirm = process.env.STAGING_SEED_CONFIRM;
  const url = process.env.DATABASE_URL || "";
  if (appEnv !== "STAGING" || confirm !== "YES") {
    throw new Error("Refusing to seed: set APP_ENV=STAGING and STAGING_SEED_CONFIRM=YES.");
  }
  if (/prod/i.test(url)) {
    throw new Error("Refusing to seed a database URL that looks like production.");
  }
  if (!url) throw new Error("DATABASE_URL is required.");
}

async function main() {
  guard();
  const password =
    process.env.STAGING_SEED_PASSWORD || `Stg-${randomBytes(9).toString("base64url")}!7`;
  const passwordHash = await bcrypt.hash(password, 12);

  const tenants = [
    { code: "STG-A", name: "Staging Tenant A", email: "a" },
    { code: "STG-B", name: "Staging Tenant B", email: "b" },
  ];

  const accounts: Array<{ email: string; role: string; tenant: string }> = [];

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.max(1, now.getUTCDate() - 1)));

  for (const tenantInfo of tenants) {
    const tenant = await prisma.businessTenant.upsert({
      where: { code: tenantInfo.code },
      create: {
        code: tenantInfo.code,
        name: tenantInfo.name,
        status: "ACTIVE",
        onboardingStatus: "COMPLETED",
        momoEnabled: true,
        susuEnabled: true,
        contactEmail: `${tenantInfo.email}.owner@example.com`,
      },
      update: {
        name: tenantInfo.name,
        status: "ACTIVE",
        onboardingStatus: "COMPLETED",
        momoEnabled: true,
        susuEnabled: true,
      },
    });
    const location = await prisma.location.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "STG-MAIN" } },
      create: {
        tenantId: tenant.id,
        code: "STG-MAIN",
        name: `${tenantInfo.name} Main`,
        status: "active",
      },
      update: { name: `${tenantInfo.name} Main`, status: "active" },
    });

    let collectorUserId: string | null = null;
    const staff = [
      { role: "admin", label: "owner", momo: true, susu: true },
      { role: "worker", label: "worker", momo: true, susu: false },
      { role: "worker", label: "agent", momo: true, susu: false },
      { role: "collector", label: "collector", momo: false, susu: true },
    ];
    for (const person of staff) {
      const email = `${tenantInfo.email}.${person.label}@example.com`;
      const user = await prisma.user.upsert({
        where: { email },
        create: {
          tenantId: tenant.id,
          email,
          fullName: `${tenantInfo.name} ${person.label}`,
          role: person.role,
          status: "active",
          passwordHash,
          forcePasswordReset: true,
          momoEnabled: person.momo,
          susuEnabled: person.susu,
          locationId: location.id,
        },
        update: {
          tenantId: tenant.id,
          role: person.role,
          status: "active",
          forcePasswordReset: true,
          momoEnabled: person.momo,
          susuEnabled: person.susu,
          locationId: location.id,
        },
      });
      accounts.push({ email, role: person.label, tenant: tenantInfo.code });
      if (person.role === "collector") {
        collectorUserId = user.id;
        await prisma.collector.upsert({
          where: { userId: user.id },
          create: { tenantId: tenant.id, userId: user.id, status: "active" },
          update: { status: "active" },
        });
      }
      if (person.label === "owner") {
        await prisma.businessTenant.update({
          where: { id: tenant.id },
          data: { primaryAdminUserId: user.id },
        });
      }
    }

    const customerId = `STG-C-${tenantInfo.code}`;
    const customer = await prisma.customer.upsert({
      where: { customerId },
      create: {
        tenantId: tenant.id,
        customerId,
        fullName: `${tenantInfo.name} Customer`,
        phone: `+2332000${tenantInfo.code === "STG-A" ? "001" : "002"}`,
        email: `${tenantInfo.email}.customer@example.com`,
        status: "active",
        portalEnabled: true,
        portalPasswordHash: passwordHash,
        forcePortalPasswordReset: true,
      },
      update: {
        tenantId: tenant.id,
        status: "active",
        portalEnabled: true,
        forcePortalPasswordReset: true,
      },
    });
    accounts.push({
      email: customer.email ?? `${tenantInfo.email}.customer@example.com`,
      role: "customer",
      tenant: tenantInfo.code,
    });

    // Synthetic financial activity so analytics/charts exercise real domain
    // tables. Values are clearly test-only and never copied to production.
    const account = await prisma.susuAccount.upsert({
      where: { accountId: `STG-S-${tenantInfo.code}` },
      create: {
        tenantId: tenant.id,
        accountId: `STG-S-${tenantInfo.code}`,
        customerId: customer.id,
        dailyContribution: 10,
        status: "active",
      },
      update: { status: "active" },
    });
    const cycle = await prisma.susuCycle.upsert({
      where: { accountId_cycleNumber: { accountId: account.id, cycleNumber: 1 } },
      create: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleNumber: 1,
        startDate: monthStart,
        endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
        dailyContribution: 10,
        status: "active",
      },
      update: { status: "active" },
    });
    const contributions = [
      { ref: `STG-${tenantInfo.code}-CON-1`, amount: 120, day: 2 },
      { ref: `STG-${tenantInfo.code}-CON-2`, amount: 80, day: 1 },
    ];
    for (const item of contributions) {
      const existing = await prisma.contribution.findUnique({ where: { referenceId: item.ref } });
      if (!existing) {
        await prisma.contribution.create({
          data: {
            tenantId: tenant.id,
            accountId: account.id,
            cycleId: cycle.id,
            amount: item.amount,
            collectionDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), item.day)),
            channel: "direct_office",
            recordedById: (await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: "admin" } })).id,
            referenceId: item.ref,
          },
        });
      }
    }
    const withdrawalRef = `STG-${tenantInfo.code}-WDR-1`;
    if (!(await prisma.withdrawal.findUnique({ where: { referenceId: withdrawalRef } }))) {
      const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: "admin" } });
      await prisma.withdrawal.create({
        data: {
          tenantId: tenant.id,
          accountId: account.id,
          cycleId: cycle.id,
          requestedAmount: 30,
          commissionAmount: 10,
          netAmount: 30,
          remainingBalance: 160,
          status: "completed",
          authorizedById: admin.id,
          referenceId: withdrawalRef,
          createdAt: currentDay,
        },
      });
    }
    const collector = await prisma.collector.findFirst({ where: { tenantId: tenant.id, status: "active" } });
    const adminUser = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: "admin" } });
    const remittanceRef = `STG-${tenantInfo.code}-REM-1`;
    if (collector && !(await prisma.collectorRemittance.findUnique({ where: { referenceId: remittanceRef } }))) {
      await prisma.collectorRemittance.create({
        data: {
          tenantId: tenant.id,
          collectorId: collector.id,
          expectedAmount: 120,
          remittedAmount: 110,
          variance: 10,
          status: "discrepancy",
          recordedById: adminUser.id,
          referenceId: remittanceRef,
          createdAt: currentDay,
        },
      });
    }
    const dailyDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.max(1, now.getUTCDate() - 1)));
    await prisma.dailyAccount.upsert({
      where: { locationId_businessDate: { locationId: location.id, businessDate: dailyDate } },
      create: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: collectorUserId ?? adminUser.id,
        businessDate: dailyDate,
        openingMomoFloat: 100,
        openingCash: 50,
        totalCashIn: 120,
        totalCashOut: 20,
        totalCashReceived: 80,
        totalCashPaid: 30,
        commission: 5,
        otherIncome: 0,
        closingMomoFloat: 200,
        closingCash: 100,
        totalExpenses: 5,
        status: "submitted",
        submittedAt: now,
        expenses: { create: [{ tenantId: tenant.id, description: "Synthetic transport", amount: 5 }] },
      },
      update: {},
    });
  }

  await prisma.zeliAvailability.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: true, reason: "Staging default" },
    update: { enabled: true, reason: "Staging default" },
  });

  const platformEmail = "platform@example.com";
  await prisma.platformSuperAdmin.upsert({
    where: { email: platformEmail },
    create: {
      email: platformEmail,
      fullName: "Staging Platform Operator",
      passwordHash,
      status: "active",
      forcePasswordReset: true,
    },
    update: { status: "active", forcePasswordReset: true },
  });

  const outputFile = process.env.STAGING_SEED_OUTPUT_FILE;
  const payload = JSON.stringify({ password, platformEmail, accounts }, null, 2);
  if (outputFile) {
    writeFileSync(outputFile, payload, { encoding: "utf8", mode: 0o600 });
    console.log("STAGING SEED COMPLETE. Credentials written to the operator-specified secure file.");
    console.log(`Accounts: ${accounts.length}; platform admin: ${platformEmail}`);
  } else {
    // Never print passwords to a shared log. The operator must supply a secure
    // output file (outside the repository) or deliver credentials out of band.
    console.log("STAGING SEED COMPLETE. Set STAGING_SEED_OUTPUT_FILE to receive credentials.");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
