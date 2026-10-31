-- ============================================================================
-- Tenant ownership integrity (Phase 1 follow-up)
--
-- ADDITIVE ONLY apart from removing the now-obsolete global unique index on
-- Location.code (replaced by the per-tenant composite index created in
-- 20261029_multitenant_platform_foundation).
--
-- Why this migration exists
-- ------------------------
-- 20261029_multitenant_platform_foundation adds the nullable tenantId columns
-- and their indexes, but it does not create the tenantId foreign keys that
-- prisma/schema-pg.prisma declares, and it removes Location.code's global
-- uniqueness with `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`, which is a
-- no-op on databases where `Location_code_key` was created as a unique INDEX
-- (that is what `prisma db push` produces). This migration closes both gaps so
-- the migrated database matches the Prisma schema exactly.
--
-- Every statement is re-runnable and safe on a live database:
--   * the obsolete index is dropped in whichever form it exists;
--   * the idempotency index is created only when absent;
--   * each foreign key is skipped when it already exists.
--
-- No row is read, written, updated or deleted by this migration.
-- ============================================================================

-- ------------------------------------- Location.code: drop the global unique --
-- Databases built by `prisma migrate deploy` hold a unique constraint, databases
-- built by `prisma db push` hold a unique index. Handle both.
ALTER TABLE "Location" DROP CONSTRAINT IF EXISTS "Location_code_key";
DROP INDEX IF EXISTS "Location_code_key";

-- ------------------------------------------- offline idempotency index -------
-- Declared in the Prisma schema as @@index([idempotencyKey]); the historical
-- migrations only ever created the unique index for that column.
CREATE INDEX IF NOT EXISTS "OfflineTransaction_idempotencyKey_idx"
    ON "OfflineTransaction"("idempotencyKey");

-- ------------------------------------------------- tenantId foreign keys -----
-- MATCH the Prisma relations (`tenant BusinessTenant?`), whose default referential
-- action for an optional relation is ON DELETE SET NULL ON UPDATE CASCADE.
DO $$ BEGIN
    ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "DailyAccount" ADD CONSTRAINT "DailyAccount_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "SusuAccount" ADD CONSTRAINT "SusuAccount_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "SusuCycle" ADD CONSTRAINT "SusuCycle_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ContributionAllocation" ADD CONSTRAINT "ContributionAllocation_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Commission" ADD CONSTRAINT "Commission_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CardFee" ADD CONSTRAINT "CardFee_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Collector" ADD CONSTRAINT "Collector_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CollectorCustomerAssignment" ADD CONSTRAINT "CollectorCustomerAssignment_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "CollectorRemittance" ADD CONSTRAINT "CollectorRemittance_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "DeviceEnrollment" ADD CONSTRAINT "DeviceEnrollment_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "OfflineTransaction" ADD CONSTRAINT "OfflineTransaction_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
