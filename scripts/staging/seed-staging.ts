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
        contactEmail: `${tenantInfo.email}.owner@staging.bloomcore.test`,
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

    const staff = [
      { role: "admin", label: "owner", momo: true, susu: true },
      { role: "worker", label: "worker", momo: true, susu: false },
      { role: "worker", label: "agent", momo: true, susu: false },
      { role: "collector", label: "collector", momo: false, susu: true },
    ];
    for (const person of staff) {
      const email = `${tenantInfo.email}.${person.label}@staging.bloomcore.test`;
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
        email: `${tenantInfo.email}.customer@staging.bloomcore.test`,
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
      email: customer.email ?? `${tenantInfo.email}.customer@staging.bloomcore.test`,
      role: "customer",
      tenant: tenantInfo.code,
    });
  }

  const platformEmail = "platform@staging.bloomcore.test";
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

  console.log("STAGING SEED COMPLETE — deliver these out of band, never commit them:");
  console.log(JSON.stringify({ password, platformEmail, accounts }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
