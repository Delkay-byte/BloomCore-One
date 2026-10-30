import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { BIK_TENANT_CODE } from "./seed";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding BIK Prestige Enterprise pilot database...\n");

  const adminPassword = await bcrypt.hash("Admin123", 12);

  // 0. Ensure the BIK Prestige Enterprise tenant exists (idempotent)
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
  const tenantId = bikTenant.id;
  console.log(`✅ Tenant: ${bikTenant.name} (${bikTenant.code})`);

  // 1. Create Admin User (idempotent)
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

  // 2. Create MoMo Locations (idempotent)
  const locations = [
    { name: "BIK Prestige - Accra Central", code: "ACC-001", address: "123 Independence Ave, Accra", contactPhone: "+233241111111", description: "Main branch in central Accra" },
    { name: "BIK Prestige - Kumasi", code: "KMS-001", address: "45 Adum Road, Kumasi", contactPhone: "+233242222222", description: "Kumasi branch" },
    { name: "BIK Prestige - Takoradi", code: "TKD-001", address: "78 Market Road, Takoradi", contactPhone: "+233243333333", description: "Takoradi branch" },
    { name: "BIK Prestige - Tamale", code: "TML-001", address: "90 Liberation Road, Tamale", contactPhone: "+233244444444", description: "Tamale branch" },
  ];

  for (const loc of locations) {
    const created = await prisma.location.upsert({
      where: { tenantId_code: { tenantId, code: loc.code } },
      update: {},
      create: { ...loc, tenantId },
    });
    console.log(`✅ Location: ${created.name} (${created.code})`);
  }

  console.log("\n🎉 Seed complete! Admin can now log in and create workers/collectors/customers from the dashboard.");
  console.log("\n📋 Admin Login:");
  console.log("   Email:    admin@bikprestige.com");
  console.log("   Password: Admin123");
  console.log("   (Change password after first login)");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
