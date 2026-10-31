#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS node script run directly */
/**
 * Safety-net script: ensures critical columns exist in the production database.
 * Run during build to patch any schema drift that prisma db push may miss.
 * Uses raw SQL via @prisma/client.
 *
 * On PostgreSQL (production): uses IF NOT EXISTS.
 * On SQLite (local dev): uses try/catch for duplicate column errors.
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const PATCHES = [
  {
    table: "Contribution",
    column: "recordedByName",
    pg: 'ALTER TABLE "Contribution" ADD COLUMN IF NOT EXISTS "recordedByName" TEXT',
   lite: 'ALTER TABLE "Contribution" ADD COLUMN "recordedByName" TEXT',
  },
  {
    table: "Contribution",
    column: "receivedByName",
    pg: 'ALTER TABLE "Contribution" ADD COLUMN IF NOT EXISTS "receivedByName" TEXT',
   lite: 'ALTER TABLE "Contribution" ADD COLUMN "receivedByName" TEXT',
  },
  {
    table: "Contribution",
    column: "receivedById",
    pg: 'ALTER TABLE "Contribution" ADD COLUMN IF NOT EXISTS "receivedById" TEXT',
   lite: 'ALTER TABLE "Contribution" ADD COLUMN "receivedById" TEXT',
  },
  {
    table: "User",
    column: "momoEnabled",
    pg: 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "momoEnabled" BOOLEAN NOT NULL DEFAULT false',
    lite: 'ALTER TABLE "User" ADD COLUMN "momoEnabled" INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: "User",
    column: "susuEnabled",
    pg: 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "susuEnabled" BOOLEAN NOT NULL DEFAULT false',
    lite: 'ALTER TABLE "User" ADD COLUMN "susuEnabled" INTEGER NOT NULL DEFAULT 0',
  },
];

/**
 * Multi-tenant foundation (Phase 1).
 *
 * tenantId is added as a NULLABLE column on every tenant-owned table. Existing
 * rows are assigned to the BIK Prestige Enterprise tenant by
 * scripts/backfill-bik-tenant.mjs — this patcher only guarantees the column
 * exists so the deployed Prisma client never selects a missing field.
 *
 * The platform tables are created by the migration; they are also ensured here
 * so a `db push` that silently no-ops cannot leave the platform routes broken.
 */
const TENANT_TABLES = [
  "User",
  "Location",
  "DailyAccount",
  "Expense",
  "AuditLog",
  "Customer",
  "SusuAccount",
  "SusuCycle",
  "Contribution",
  "ContributionAllocation",
  "Withdrawal",
  "Commission",
  "CardFee",
  "Collector",
  "CollectorCustomerAssignment",
  "CollectorRemittance",
  "PasswordResetToken",
  "DeviceEnrollment",
  "OfflineTransaction",
];

for (const table of TENANT_TABLES) {
  PATCHES.push({
    table,
    column: "tenantId",
    pg: `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`,
    lite: `ALTER TABLE "${table}" ADD COLUMN "tenantId" TEXT`,
  });
}

const TENANT_INDEXES = [
  ["BusinessTenant", "code", "CREATE UNIQUE INDEX IF NOT EXISTS \"BusinessTenant_code_key\" ON \"BusinessTenant\"(\"code\")"],
  ["PlatformSuperAdmin", "email", "CREATE UNIQUE INDEX IF NOT EXISTS \"PlatformSuperAdmin_email_key\" ON \"PlatformSuperAdmin\"(\"email\")"],
  ["PlatformAuditLog", "createdAt", "CREATE INDEX IF NOT EXISTS \"PlatformAuditLog_createdAt_idx\" ON \"PlatformAuditLog\"(\"createdAt\")"],
  ["Location", "tenantId_code", "CREATE UNIQUE INDEX IF NOT EXISTS \"Location_tenantId_code_key\" ON \"Location\"(\"tenantId\", \"code\")"],
];

const TENANT_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS "BusinessTenant" (
     "id" TEXT NOT NULL,
     "code" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "legalName" TEXT,
     "contactPhone" TEXT,
     "contactEmail" TEXT,
     "address" TEXT,
     "momoEnabled" BOOLEAN NOT NULL DEFAULT false,
     "susuEnabled" BOOLEAN NOT NULL DEFAULT false,
     "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
     "onboardingStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
     "primaryAdminUserId" TEXT,
     "activatedAt" TIMESTAMP(3),
     "suspendedAt" TIMESTAMP(3),
     "suspensionReason" TEXT,
     "archivedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "BusinessTenant_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE TABLE IF NOT EXISTS "PlatformSuperAdmin" (
     "id" TEXT NOT NULL,
     "email" TEXT NOT NULL,
     "fullName" TEXT NOT NULL,
     "passwordHash" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'active',
     "forcePasswordReset" BOOLEAN NOT NULL DEFAULT false,
     "tokenVersion" INTEGER NOT NULL DEFAULT 0,
     "lastLoginAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "PlatformSuperAdmin_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE TABLE IF NOT EXISTS "PlatformAuditLog" (
     "id" TEXT NOT NULL,
     "actorId" TEXT,
     "actorEmail" TEXT,
     "action" TEXT NOT NULL,
     "tenantId" TEXT,
     "tenantCode" TEXT,
     "entityType" TEXT,
     "entityId" TEXT,
     "details" TEXT,
     "reason" TEXT,
     "ipAddress" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
   )`,
];

async function main() {
  const url = process.env.DATABASE_URL || "";
  const isPg = url.startsWith("postgres");
  console.log(`ensure-columns: targeting ${isPg ? "PostgreSQL" : "SQLite"} database`);

  // 1. Platform tables + indexes first: tenant columns are meaningless without
  //    the tenant table they reference.
  for (const ddl of TENANT_TABLE_DDL) {
    try {
      await prisma.$executeRawUnsafe(ddl);
    } catch (err) {
      console.error(`  ✗ platform table DDL — ${err.message}`);
    }
  }
  for (const [table, what, sql] of TENANT_INDEXES) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      const msg = err.message || "";
      if (!msg.includes("already exists")) {
        console.error(`  ✗ ${table}.${what} index — ${msg}`);
      }
    }
  }

  let patched = 0;
  for (const patch of PATCHES) {
    try {
      const sql = isPg ? patch.pg : patch.lite;
      await prisma.$executeRawUnsafe(sql);
      console.log(`  ✓ ${patch.table}.${patch.column} — ensured`);
      patched++;
    } catch (err) {
      const msg = err.message || "";
      const isDuplicate =
        err.code === "42701" ||              // PostgreSQL: duplicate column
        msg.includes("duplicate column") ||   // SQLite
        msg.includes("already exists");       // generic
      if (isDuplicate) {
        console.log(`  · ${patch.table}.${patch.column} — already exists`);
      } else {
        console.error(`  ✗ ${patch.table}.${patch.column} — ${msg}`);
      }
    }
  }
  console.log(`\nensure-columns: ${patched} patch(es) applied.`);
}

main()
  .catch((e) => {
    console.error("ensure-columns failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
