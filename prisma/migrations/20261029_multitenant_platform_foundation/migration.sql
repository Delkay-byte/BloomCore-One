-- ============================================================================
-- Multi-tenant platform foundation (Phase 1)
--
-- ADDITIVE ONLY. This migration:
--   * creates BusinessTenant, PlatformSuperAdmin, PlatformAuditLog
--   * adds a NULLABLE tenantId to every tenant-owned table
--   * swaps Location.code from a global unique to a per-tenant unique
--
-- It does NOT drop, truncate or rewrite any existing row. tenantId is nullable
-- precisely so this migration is safe to apply to a live database that already
-- holds financial history; scripts/backfill-bik-tenant.mjs then assigns
-- existing records to the BIK Prestige Enterprise tenant, and a later
-- migration may tighten the column to NOT NULL once backfill is verified.
--
-- PostgreSQL. The SQLite development database is brought up to date with
-- `prisma db push` / `prisma migrate dev` against prisma/schema.prisma.
-- ============================================================================

-- ---------------------------------------------------------------- tenants ---
CREATE TABLE IF NOT EXISTS "BusinessTenant" (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessTenant_code_key" ON "BusinessTenant"("code");
CREATE INDEX IF NOT EXISTS "BusinessTenant_status_idx" ON "BusinessTenant"("status");
CREATE INDEX IF NOT EXISTS "BusinessTenant_onboardingStatus_idx" ON "BusinessTenant"("onboardingStatus");
CREATE INDEX IF NOT EXISTS "BusinessTenant_momoEnabled_idx" ON "BusinessTenant"("momoEnabled");
CREATE INDEX IF NOT EXISTS "BusinessTenant_susuEnabled_idx" ON "BusinessTenant"("susuEnabled");

-- ------------------------------------------------- platform super admins ---
CREATE TABLE IF NOT EXISTS "PlatformSuperAdmin" (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformSuperAdmin_email_key" ON "PlatformSuperAdmin"("email");
CREATE INDEX IF NOT EXISTS "PlatformSuperAdmin_status_idx" ON "PlatformSuperAdmin"("status");

-- ------------------------------------------------------ platform audit log ---
CREATE TABLE IF NOT EXISTS "PlatformAuditLog" (
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
);

CREATE INDEX IF NOT EXISTS "PlatformAuditLog_actorId_idx" ON "PlatformAuditLog"("actorId");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_action_idx" ON "PlatformAuditLog"("action");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_tenantId_idx" ON "PlatformAuditLog"("tenantId");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt");

DO $$ BEGIN
    ALTER TABLE "PlatformAuditLog"
        ADD CONSTRAINT "PlatformAuditLog_actorId_fkey"
        FOREIGN KEY ("actorId") REFERENCES "PlatformSuperAdmin"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------- tenantId on owned tables ------
-- Nullable on purpose: existing rows are backfilled, never guessed.
ALTER TABLE "User"                       ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Location"                   ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "DailyAccount"               ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Expense"                    ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "AuditLog"                   ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Customer"                   ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SusuAccount"                ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "SusuCycle"                  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Contribution"               ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ContributionAllocation"     ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Withdrawal"                 ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Commission"                 ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CardFee"                    ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Collector"                  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CollectorCustomerAssignment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CollectorRemittance"        ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "PasswordResetToken"         ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "DeviceEnrollment"           ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "OfflineTransaction"         ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "User_tenantId_idx" ON "User"("tenantId");
CREATE INDEX IF NOT EXISTS "Location_tenantId_idx" ON "Location"("tenantId");
CREATE INDEX IF NOT EXISTS "DailyAccount_tenantId_idx" ON "DailyAccount"("tenantId");
CREATE INDEX IF NOT EXISTS "Expense_tenantId_idx" ON "Expense"("tenantId");
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_idx" ON "AuditLog"("tenantId");
CREATE INDEX IF NOT EXISTS "Customer_tenantId_idx" ON "Customer"("tenantId");
CREATE INDEX IF NOT EXISTS "SusuAccount_tenantId_idx" ON "SusuAccount"("tenantId");
CREATE INDEX IF NOT EXISTS "SusuCycle_tenantId_idx" ON "SusuCycle"("tenantId");
CREATE INDEX IF NOT EXISTS "Contribution_tenantId_idx" ON "Contribution"("tenantId");
CREATE INDEX IF NOT EXISTS "ContributionAllocation_tenantId_idx" ON "ContributionAllocation"("tenantId");
CREATE INDEX IF NOT EXISTS "Withdrawal_tenantId_idx" ON "Withdrawal"("tenantId");
CREATE INDEX IF NOT EXISTS "Commission_tenantId_idx" ON "Commission"("tenantId");
CREATE INDEX IF NOT EXISTS "CardFee_tenantId_idx" ON "CardFee"("tenantId");
CREATE INDEX IF NOT EXISTS "Collector_tenantId_idx" ON "Collector"("tenantId");
CREATE INDEX IF NOT EXISTS "CollectorCustomerAssignment_tenantId_idx" ON "CollectorCustomerAssignment"("tenantId");
CREATE INDEX IF NOT EXISTS "CollectorRemittance_tenantId_idx" ON "CollectorRemittance"("tenantId");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_tenantId_idx" ON "PasswordResetToken"("tenantId");
CREATE INDEX IF NOT EXISTS "DeviceEnrollment_tenantId_idx" ON "DeviceEnrollment"("tenantId");
CREATE INDEX IF NOT EXISTS "OfflineTransaction_tenantId_idx" ON "OfflineTransaction"("tenantId");

-- ------------------------------------------- Location.code per-tenant ------
-- Branch codes (ACC-001) must be reusable across independent businesses.
-- Drop the global unique, add the composite. Both statements are safe to
-- re-run: the DROP tolerates a missing constraint, the CREATE tolerates an
-- existing index.
ALTER TABLE "Location" DROP CONSTRAINT IF EXISTS "Location_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Location_tenantId_code_key" ON "Location"("tenantId", "code");
