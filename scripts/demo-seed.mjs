/**
 * LOCAL DEMO SEED — synthetic data only.
 *
 * Creates one demo business, its owner, three staff, two locations, a founding
 * Business subscription, one enquiry and one platform administrator so the
 * commercial journey can be exercised on localhost. Never point DATABASE_URL at
 * a hosted database: the script exits unless the URL is a SQLite file.
 *
 * Run: DATABASE_URL="file:./demo.db" node scripts/demo-seed.mjs
 */
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL || "file:./demo.db";
if (!url.startsWith("file:")) {
  console.error("demo-seed refuses to run: DATABASE_URL must be a local SQLite file.");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

const PASSWORD = "DemoOwner!2026";
const PLATFORM_PASSWORD = "DemoPlatform!2026";

const plans = [
  { code: "starter", name: "Starter", billingInterval: "month", price: 99, foundingPrice: 79, usageAllowance: 250, locationLimit: 1, staffLimit: 3, supportLevel: "Standard support", sortOrder: 1 },
  { code: "business", name: "Business", billingInterval: "month", price: 169, foundingPrice: 149, usageAllowance: 600, locationLimit: 3, staffLimit: 10, supportLevel: "Standard support", sortOrder: 2 },
  { code: "multi-branch", name: "Multi-Branch", billingInterval: "month", price: 339, foundingPrice: 225, usageAllowance: 1500, locationLimit: 5, staffLimit: 20, supportLevel: "Priority support", sortOrder: 3 },
  { code: "starter-annual", name: "Starter Annual", billingInterval: "year", price: 1070, foundingPrice: null, usageAllowance: 250, locationLimit: 1, staffLimit: 3, supportLevel: "Standard support", sortOrder: 4 },
  { code: "business-annual", name: "Business Annual", billingInterval: "year", price: 1825, foundingPrice: null, usageAllowance: 600, locationLimit: 3, staffLimit: 10, supportLevel: "Standard support", sortOrder: 5 },
  { code: "multi-branch-annual", name: "Multi-Branch Annual", billingInterval: "year", price: 3660, foundingPrice: null, usageAllowance: 1500, locationLimit: 5, staffLimit: 20, supportLevel: "Priority support", sortOrder: 6 },
];

const passwordHash = await bcrypt.hash(PASSWORD, 12);
const platformHash = await bcrypt.hash(PLATFORM_PASSWORD, 12);

for (const plan of plans) {
  await prisma.zeliPlan.upsert({
    where: { code: plan.code },
    create: { ...plan, currency: "GHS", status: "active", isPublic: true, zeliIncluded: true },
    update: { ...plan, currency: "GHS", status: "active", isPublic: true, zeliIncluded: true },
  });
}

await prisma.zeliAvailability.upsert({
  where: { id: "global" },
  create: { id: "global", enabled: true, reason: null },
  update: { enabled: true, reason: null },
});

const existing = await prisma.businessTenant.findUnique({ where: { code: "DEMO-001" } });
if (existing) {
  await prisma.businessTenant.delete({ where: { id: existing.id } });
}

const tenant = await prisma.businessTenant.create({
  data: {
    code: "DEMO-001",
    name: "Demo Business",
    legalName: "Demo Business Ltd",
    contactEmail: "owner@demo.local",
    contactPhone: "0244000000",
    momoEnabled: true,
    susuEnabled: true,
    status: "ACTIVE",
    onboardingStatus: "COMPLETED",
    activatedAt: new Date(),
  },
});

const admin = await prisma.user.create({
  data: {
    tenantId: tenant.id,
    email: "owner@demo.local",
    fullName: "Demo Owner",
    role: "admin",
    status: "active",
    passwordHash,
    emailVerifiedAt: new Date(),
  },
});
await prisma.businessTenant.update({ where: { id: tenant.id }, data: { primaryAdminUserId: admin.id } });

const locationA = await prisma.location.create({
  data: { tenantId: tenant.id, name: "Accra Main", code: "ACC", status: "active", address: "Accra" },
});
const locationB = await prisma.location.create({
  data: { tenantId: tenant.id, name: "Kumasi Branch", code: "KUM", status: "active", address: "Kumasi" },
});

for (const [index, name] of ["Ama Worker", "Kojo Worker", "Efua Worker"].entries()) {
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      locationId: index === 0 ? locationB.id : locationA.id,
      email: `worker${index + 1}@demo.local`,
      fullName: name,
      role: "worker",
      status: "active",
      passwordHash,
      emailVerifiedAt: new Date(),
    },
  });
}

const business = await prisma.zeliPlan.findUniqueOrThrow({ where: { code: "business" } });
const reference = `DEMO-${Date.now()}`;
await prisma.zeliSubscription.create({
  data: {
    tenantId: tenant.id,
    planId: business.id,
    status: "pending_payment",
    provider: "paystack",
    providerReference: reference,
    amount: 149,
    currency: "GHS",
    billingTerm: "monthly",
    standardAmount: 169,
    pendingKey: `${tenant.id}:${business.id}`,
  },
});

await prisma.accountEnquiry.create({
  data: {
    businessName: "Synthetic Prospect Ltd",
    contactName: "Nana Prospect",
    phone: "0244000009",
    email: "prospect@demo.local",
    locationCount: 2,
    interestedPlan: "Business",
    message: "I run two mobile money points and want to manage both in one place.",
    status: "new",
    source: "public-pricing",
  },
});

await prisma.zeliEntitlement.upsert({
  where: { tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" } },
  create: {
    tenantId: tenant.id,
    featureKey: "zeli_analytics",
    status: "active",
    source: "manual",
    startsAt: new Date(),
  },
  update: { status: "active" },
});

await prisma.platformSuperAdmin.upsert({
  where: { email: "platform@demo.local" },
  create: {
    email: "platform@demo.local",
    fullName: "Demo Platform Admin",
    passwordHash: platformHash,
    status: "active",
  },
  update: { passwordHash: platformHash, status: "active" },
});

console.log(JSON.stringify({ tenant: tenant.code, locations: 2, staff: 3, subscription: reference, plan: business.code }));
await prisma.$disconnect();
