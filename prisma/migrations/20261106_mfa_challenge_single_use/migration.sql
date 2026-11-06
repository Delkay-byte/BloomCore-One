-- One-time MFA challenge completion records.
--
-- Additive only. The challenge jti is the primary key, so a replayed or
-- concurrent completion can never mint a second session.

CREATE TABLE "MfaChallengeUse" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MfaChallengeUse_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MfaChallengeUse_expiresAt_idx" ON "MfaChallengeUse"("expiresAt");
