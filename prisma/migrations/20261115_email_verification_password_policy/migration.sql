-- Email verification, password-reset eligibility and mandatory legacy password upgrade.
--
-- Additive only. Existing accounts keep every role, tenant, balance, transaction,
-- device enrollment and offline record. No password hash is changed here.
--
-- Existing User rows are marked verified because their addresses were already in
-- operational use. The application only treats accounts explicitly created after
-- this release as pending verification.
--
-- Existing User rows are marked for the one-time password upgrade on their next
-- successful password login. Existing active sessions are NOT revoked.

ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "passwordPolicyVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PlatformSuperAdmin" ADD COLUMN "passwordPolicyVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Customer" ADD COLUMN "passwordPolicyVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");
CREATE INDEX "EmailVerificationToken_tokenHash_idx" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX "EmailVerificationToken_expiresAt_idx" ON "EmailVerificationToken"("expiresAt");
CREATE INDEX "EmailVerificationToken_tenantId_idx" ON "EmailVerificationToken"("tenantId");

ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Explicit backfills. The column default already covers existing rows; these
-- statements make the intent reviewable and idempotent.
UPDATE "User" SET "emailVerified" = true WHERE "emailVerified" IS DISTINCT FROM true;
UPDATE "User" SET "forcePasswordReset" = true;
