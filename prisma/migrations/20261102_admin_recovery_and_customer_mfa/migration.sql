-- ============================================================================
-- Administrator-assisted recovery + MFA coverage for customer accounts
--
-- ADDITIVE ONLY.
--   * Customer gains the same MFA columns as User / PlatformSuperAdmin
--   * AccountRecoveryRequest stores hashed, single-use administrator codes
-- ============================================================================

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "mfaRecoveryCodes" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "mfaEnrolledAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "mfaLastUsedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AccountRecoveryRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedByType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountRecoveryRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccountRecoveryRequest_codeHash_key"
    ON "AccountRecoveryRequest"("codeHash");
CREATE INDEX IF NOT EXISTS "AccountRecoveryRequest_tenantId_idx"
    ON "AccountRecoveryRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "AccountRecoveryRequest_targetType_targetId_idx"
    ON "AccountRecoveryRequest"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "AccountRecoveryRequest_expiresAt_idx"
    ON "AccountRecoveryRequest"("expiresAt");
