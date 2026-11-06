-- Per-tab proof-of-possession credentials and one-time proof nonces.
-- Additive only: no existing session or MFA row is modified.

CREATE TABLE "TabCredential" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "tenantId" TEXT,
    "module" TEXT NOT NULL,
    "amr" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "publicKeyJwk" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TabCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TabCredential_sessionId_key" ON "TabCredential"("sessionId");
CREATE INDEX "TabCredential_subjectType_subjectId_idx" ON "TabCredential"("subjectType", "subjectId");

CREATE TABLE "TabProofNonce" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TabProofNonce_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TabProofNonce_expiresAt_idx" ON "TabProofNonce"("expiresAt");
