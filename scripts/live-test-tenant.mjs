/**
 * LOCAL LIVE-PAYMENT TEST TENANT — synthetic data only.
 *
 * Creates the one business that is allowed to take a genuine Paystack live
 * mobile money charge from a developer machine. It exists only in the local
 * SQLite demo database and is refused anywhere else.
 *
 * Run:
 *   DATABASE_URL="file:./demo.db" node scripts/live-test-tenant.mjs
 */
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL || "file:./demo.db";
if (!url.startsWith("file:")) {
  console.error("live-test-tenant refuses to run: DATABASE_URL must be a local SQLite file.");
  process.exit(1);
}
if (process.env.RENDER || process.env.VERCEL) {
  console.error("live-test-tenant refuses to run on a hosted deployment.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

const TENANT_CODE = "LOCAL-LIVE-01";
const ADMIN_EMAIL = "livetest@demo.local";
const ADMIN_PASSWORD = "LiveTestOwner!2026";

const existing = await prisma.businessTenant.findUnique({ where: { code: TENANT_CODE } });
if (existing) {
  await prisma.businessTenant.delete({ where: { id: existing.id } });
}

const tenant = await prisma.businessTenant.create({
  data: {
    code: TENANT_CODE,
    name: "Local Live Test Co (synthetic)",
    legalName: "Local Live Test Co (synthetic)",
    contactEmail: ADMIN_EMAIL,
    contactPhone: "0200000000",
    momoEnabled: true,
    susuEnabled: false,
    status: "PENDING_PAYMENT",
    onboardingStatus: "COMPLETED",
  },
});

const admin = await prisma.user.create({
  data: {
    tenantId: tenant.id,
    email: ADMIN_EMAIL,
    fullName: "Local Live Test Owner",
    role: "admin",
    status: "active",
    passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
    emailVerifiedAt: new Date(),
  },
});
await prisma.businessTenant.update({
  where: { id: tenant.id },
  data: { primaryAdminUserId: admin.id },
});

await prisma.zeliAvailability.upsert({
  where: { id: "global" },
  create: { id: "global", enabled: true, reason: null },
  update: { enabled: true, reason: null },
});

const starter = await prisma.zeliPlan.findUnique({ where: { code: "starter" } });
console.log(
  JSON.stringify(
    {
      tenantId: tenant.id,
      tenantCode: tenant.code,
      status: tenant.status,
      adminEmail: ADMIN_EMAIL,
      plan: starter ? { code: starter.code, price: starter.price, currency: starter.currency } : null,
      foundingAllocation: await prisma.foundingAllocation.count({ where: { tenantId: tenant.id } }),
    },
    null,
    2
  )
);
await prisma.$disconnect();
