-- SEC-04, SEC-06, SEC-07, SEC-14 and SEC-15 remediation.
--
-- Additive only. Existing financial rows, sessions, recovery codes and email
-- tokens are preserved unless a legacy value cannot be proven safe.

-- ---------------------------------------------------------------------------
-- SEC-04: server-side single-use step-up grants
-- ---------------------------------------------------------------------------
CREATE TABLE "StepUpGrant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "contextHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "StepUpGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StepUpGrant_tokenHash_key" ON "StepUpGrant"("tokenHash");
CREATE INDEX "StepUpGrant_sessionId_idx" ON "StepUpGrant"("sessionId");
CREATE INDEX "StepUpGrant_subjectType_subjectId_idx" ON "StepUpGrant"("subjectType", "subjectId");
CREATE INDEX "StepUpGrant_expiresAt_idx" ON "StepUpGrant"("expiresAt");

-- ---------------------------------------------------------------------------
-- SEC-06: collector remittance idempotency
-- ---------------------------------------------------------------------------
ALTER TABLE "CollectorRemittance" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "CollectorRemittance" ADD COLUMN "requestHash" TEXT;

-- Historical rows are intentionally left with NULL keys. PostgreSQL treats
-- NULLs as distinct in a unique index, so every legacy row survives.
CREATE UNIQUE INDEX "CollectorRemittance_tenantId_idempotencyKey_key"
    ON "CollectorRemittance"("tenantId", "idempotencyKey");

-- ---------------------------------------------------------------------------
-- SEC-07: one hashed row per MFA recovery code
-- ---------------------------------------------------------------------------
CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MfaRecoveryCode_subjectType_subjectId_codeHash_key"
    ON "MfaRecoveryCode"("subjectType", "subjectId", "codeHash");
CREATE INDEX "MfaRecoveryCode_subjectType_subjectId_idx"
    ON "MfaRecoveryCode"("subjectType", "subjectId");
CREATE INDEX "MfaRecoveryCode_createdAt_idx" ON "MfaRecoveryCode"("createdAt");

-- Preserve every existing valid recovery-code hash. Only the SHA-256 hashes in
-- the legacy JSON array are copied; no plaintext code is exposed or created.
-- The json_array_elements_text cast is guarded by a shape check.
WITH user_codes AS (
    SELECT u."id" AS subject_id, value AS code_hash
    FROM "User" u,
         LATERAL json_array_elements_text(
             CASE
                 WHEN u."mfaRecoveryCodes" LIKE '[%' THEN u."mfaRecoveryCodes"::json
                 ELSE '[]'::json
             END
         ) AS value
)
INSERT INTO "MfaRecoveryCode" ("id", "subjectType", "subjectId", "codeHash", "createdAt")
SELECT gen_random_uuid()::text, 'user', subject_id, code_hash, CURRENT_TIMESTAMP
FROM user_codes
WHERE code_hash ~ '^[0-9a-f]{64}$'
ON CONFLICT ("subjectType", "subjectId", "codeHash") DO NOTHING;

WITH platform_codes AS (
    SELECT p."id" AS subject_id, value AS code_hash
    FROM "PlatformSuperAdmin" p,
         LATERAL json_array_elements_text(
             CASE
                 WHEN p."mfaRecoveryCodes" LIKE '[%' THEN p."mfaRecoveryCodes"::json
                 ELSE '[]'::json
             END
         ) AS value
)
INSERT INTO "MfaRecoveryCode" ("id", "subjectType", "subjectId", "codeHash", "createdAt")
SELECT gen_random_uuid()::text, 'platform', subject_id, code_hash, CURRENT_TIMESTAMP
FROM platform_codes
WHERE code_hash ~ '^[0-9a-f]{64}$'
ON CONFLICT ("subjectType", "subjectId", "codeHash") DO NOTHING;

WITH customer_codes AS (
    SELECT c."id" AS subject_id, value AS code_hash
    FROM "Customer" c,
         LATERAL json_array_elements_text(
             CASE
                 WHEN c."mfaRecoveryCodes" LIKE '[%' THEN c."mfaRecoveryCodes"::json
                 ELSE '[]'::json
             END
         ) AS value
)
INSERT INTO "MfaRecoveryCode" ("id", "subjectType", "subjectId", "codeHash", "createdAt")
SELECT gen_random_uuid()::text, 'customer', subject_id, code_hash, CURRENT_TIMESTAMP
FROM customer_codes
WHERE code_hash ~ '^[0-9a-f]{64}$'
ON CONFLICT ("subjectType", "subjectId", "codeHash") DO NOTHING;

-- ---------------------------------------------------------------------------
-- SEC-14: bind verification tokens to their destination address
-- ---------------------------------------------------------------------------
ALTER TABLE "EmailVerificationToken" ADD COLUMN "destinationEmailHash" TEXT;

-- Legacy outstanding tokens did not record their destination, so the original
-- target cannot be established. Invalidate only unused legacy tokens; consumed
-- history is retained unchanged. Affected users receive a fresh link.
UPDATE "EmailVerificationToken"
SET "usedAt" = CURRENT_TIMESTAMP
WHERE "usedAt" IS NULL AND "destinationEmailHash" IS NULL;

-- ---------------------------------------------------------------------------
-- SEC-15: idempotent, time-bounded MFA enrolment
-- ---------------------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "mfaPendingSecretAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "mfaPendingSecretAt" TIMESTAMP(3);
ALTER TABLE "PlatformSuperAdmin" ADD COLUMN "mfaPendingSecretAt" TIMESTAMP(3);
