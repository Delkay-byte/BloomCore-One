-- Reconcile the Zeli team-tester table with schema-pg.prisma.
--
-- The model was added to both Prisma schemas without a matching migration. A
-- fresh PostgreSQL database therefore drifted from the schema. This migration
-- is additive and idempotent so it is safe whether the table was already
-- created by an earlier db push or is absent.
--
-- No financial table is touched and no existing row is changed or deleted.

CREATE TABLE IF NOT EXISTS "ZeliTeamTester" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "disclosureVersion" TEXT,
    "disclosureAcceptedAt" TIMESTAMP(3),
    "grantedById" TEXT,
    "revokedById" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZeliTeamTester_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ZeliTeamTester_tenantId_userId_key"
    ON "ZeliTeamTester"("tenantId", "userId");

CREATE INDEX IF NOT EXISTS "ZeliTeamTester_tenantId_status_idx"
    ON "ZeliTeamTester"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "ZeliTeamTester_userId_status_idx"
    ON "ZeliTeamTester"("userId", "status");
