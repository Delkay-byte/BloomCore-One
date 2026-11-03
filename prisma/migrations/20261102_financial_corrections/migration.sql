-- Remittance reversal metadata. Originals are kept; reversed rows are excluded
-- from active cash-handover calculations.
ALTER TABLE "CollectorRemittance" ADD COLUMN "reversedAt" TIMESTAMP(3);
ALTER TABLE "CollectorRemittance" ADD COLUMN "reversedById" TEXT;
ALTER TABLE "CollectorRemittance" ADD COLUMN "reversalReason" TEXT;

-- Daily-account correction metadata on the live row.
ALTER TABLE "DailyAccount" ADD COLUMN "correctedAt" TIMESTAMP(3);
ALTER TABLE "DailyAccount" ADD COLUMN "correctedById" TEXT;
ALTER TABLE "DailyAccount" ADD COLUMN "correctionReason" TEXT;
ALTER TABLE "DailyAccount" ADD COLUMN "revisionCount" INTEGER NOT NULL DEFAULT 0;

-- Immutable snapshot of each pre-correction state.
CREATE TABLE "DailyAccountRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "dailyAccountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyAccountRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyAccountRevision_dailyAccountId_version_key" ON "DailyAccountRevision"("dailyAccountId", "version");
CREATE INDEX "DailyAccountRevision_dailyAccountId_idx" ON "DailyAccountRevision"("dailyAccountId");
CREATE INDEX "DailyAccountRevision_tenantId_idx" ON "DailyAccountRevision"("tenantId");
CREATE INDEX "DailyAccountRevision_createdAt_idx" ON "DailyAccountRevision"("createdAt");
ALTER TABLE "DailyAccountRevision" ADD CONSTRAINT "DailyAccountRevision_dailyAccountId_fkey" FOREIGN KEY ("dailyAccountId") REFERENCES "DailyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
