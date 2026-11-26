-- MoMo operational transaction ledger and opening-balance roll-forward.
--
-- Purely additive. Historical DailyAccount rows keep every existing column and
-- remain aggregate snapshots; they are never back-filled with invented
-- transactions and their stored reconciliation is never recalculated.
--
-- `ledgerMode` records the explicit cutover for a business day:
--   aggregate (default) — the existing manual closing is the source of truth.
--   ledger              — commission, debts, other income and expenses derive
--                         from MomoTransaction rows for that day.
--
-- The transaction table stores operator-recorded operational entries only.
-- `recordingSource` makes that explicit; nothing here claims a provider
-- confirmation. Reversal and correction rows are append-only and linked to the
-- row they supersede, which keeps a complete immutable posting history.

ALTER TABLE "DailyAccount" ADD COLUMN "ledgerMode" TEXT NOT NULL DEFAULT 'aggregate';
ALTER TABLE "DailyAccount" ADD COLUMN "ledgerCutoverAt" TIMESTAMP(3);
ALTER TABLE "DailyAccount" ADD COLUMN "openingBalanceSource" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "DailyAccount" ADD COLUMN "carriedFromAccountId" TEXT;
ALTER TABLE "DailyAccount" ADD COLUMN "openingAdjustmentReason" TEXT;

CREATE TABLE "MomoTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "locationId" TEXT NOT NULL,
    "dailyAccountId" TEXT,
    "workerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'unassigned',
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "commissionAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "externalReference" TEXT,
    "recordingSource" TEXT NOT NULL DEFAULT 'manual_operator',
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "idempotencyKey" TEXT NOT NULL,
    "reversesTransactionId" TEXT,
    "correctsTransactionId" TEXT,
    "correctionReason" TEXT,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomoTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MomoTransaction_tenantId_idempotencyKey_key" ON "MomoTransaction"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "MomoTransaction_tenantId_reference_key" ON "MomoTransaction"("tenantId", "reference");
CREATE UNIQUE INDEX "MomoTransaction_tenantId_network_externalReference_key" ON "MomoTransaction"("tenantId", "network", "externalReference");
CREATE UNIQUE INDEX "MomoTransaction_reversesTransactionId_key" ON "MomoTransaction"("reversesTransactionId");
CREATE INDEX "MomoTransaction_tenantId_businessDate_idx" ON "MomoTransaction"("tenantId", "businessDate");
CREATE INDEX "MomoTransaction_locationId_businessDate_idx" ON "MomoTransaction"("locationId", "businessDate");
CREATE INDEX "MomoTransaction_workerId_businessDate_idx" ON "MomoTransaction"("workerId", "businessDate");
CREATE INDEX "MomoTransaction_dailyAccountId_status_idx" ON "MomoTransaction"("dailyAccountId", "status");
CREATE INDEX "MomoTransaction_type_status_idx" ON "MomoTransaction"("type", "status");
CREATE INDEX "MomoTransaction_createdAt_idx" ON "MomoTransaction"("createdAt");

ALTER TABLE "MomoTransaction" ADD CONSTRAINT "MomoTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MomoTransaction" ADD CONSTRAINT "MomoTransaction_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MomoTransaction" ADD CONSTRAINT "MomoTransaction_dailyAccountId_fkey" FOREIGN KEY ("dailyAccountId") REFERENCES "DailyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MomoTransaction" ADD CONSTRAINT "MomoTransaction_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MomoTransaction" ADD CONSTRAINT "MomoTransaction_reversesTransactionId_fkey" FOREIGN KEY ("reversesTransactionId") REFERENCES "MomoTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
