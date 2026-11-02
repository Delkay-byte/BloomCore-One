-- ============================================================================
-- Security hardening: persistent abuse controls, session registry and MFA
--
-- ADDITIVE ONLY. No existing row is updated, rewritten or deleted.
--
--   * User / PlatformSuperAdmin gain nullable MFA columns
--   * new tables: RateLimitCounter, AuthThrottle, TurnstileTokenUse, SessionRecord
--
-- Safe to apply to a live database that already holds financial history.
-- Rollback: drop the new tables and columns (see docs/security/
-- PRODUCTION-SECURITY-ROLLOUT.md). Dropping the security tables logs every
-- session out; it does not touch business data.
-- ============================================================================

-- ------------------------------------------------------------------ MFA ---
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaRecoveryCodes" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaEnrolledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaLastUsedAt" TIMESTAMP(3);

ALTER TABLE "PlatformSuperAdmin" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformSuperAdmin" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
ALTER TABLE "PlatformSuperAdmin" ADD COLUMN IF NOT EXISTS "mfaRecoveryCodes" TEXT;
ALTER TABLE "PlatformSuperAdmin" ADD COLUMN IF NOT EXISTS "mfaEnrolledAt" TIMESTAMP(3);
ALTER TABLE "PlatformSuperAdmin" ADD COLUMN IF NOT EXISTS "mfaLastUsedAt" TIMESTAMP(3);

-- --------------------------------------------------- request rate limits ---
CREATE TABLE IF NOT EXISTS "RateLimitCounter" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RateLimitCounter_key_key"
    ON "RateLimitCounter"("key");
CREATE INDEX IF NOT EXISTS "RateLimitCounter_expiresAt_idx"
    ON "RateLimitCounter"("expiresAt");

-- ------------------------------------------- progressive login cooldown ---
CREATE TABLE IF NOT EXISTS "AuthThrottle" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "lastFailedAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthThrottle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AuthThrottle_key_key"
    ON "AuthThrottle"("key");
CREATE INDEX IF NOT EXISTS "AuthThrottle_expiresAt_idx"
    ON "AuthThrottle"("expiresAt");
CREATE INDEX IF NOT EXISTS "AuthThrottle_blockedUntil_idx"
    ON "AuthThrottle"("blockedUntil");

-- ------------------------------------------ Turnstile single-use ledger ---
CREATE TABLE IF NOT EXISTS "TurnstileTokenUse" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TurnstileTokenUse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TurnstileTokenUse_tokenHash_key"
    ON "TurnstileTokenUse"("tokenHash");
CREATE INDEX IF NOT EXISTS "TurnstileTokenUse_expiresAt_idx"
    ON "TurnstileTokenUse"("expiresAt");

-- ------------------------------------------------------ session registry ---
CREATE TABLE IF NOT EXISTS "SessionRecord" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "tenantId" TEXT,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    CONSTRAINT "SessionRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SessionRecord_subjectType_subjectId_idx"
    ON "SessionRecord"("subjectType", "subjectId");
CREATE INDEX IF NOT EXISTS "SessionRecord_expiresAt_idx"
    ON "SessionRecord"("expiresAt");
