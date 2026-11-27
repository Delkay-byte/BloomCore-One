-- Phase 1-3 integration reconciliation.
--
-- This migration closes the gaps left by the three independently developed
-- phase migrations. It is CORRECTIVE AND ADDITIVE ONLY: no financial record is
-- deleted, retyped or rewritten, no historical branch or collector attribution
-- is invented, and no column or table introduced by a phase is removed.
--
-- Gaps this migration closes (each verified against the migration chain and
-- the Prisma PostgreSQL schema):
--   * Phase 2 introduced `activeAccountKey` (at most one ACTIVE assignment per
--     account) but never dropped the legacy (collectorId, accountId) unique
--     pair created by 20260823_init_postgresql. While that index existed, a
--     collector released from an account could never be re-assigned to it,
--     and the database still enforced the wrong invariant.
--   * Phase 2 declared `OfflineTransaction.capturedAt` and the
--     (tenantId, status, createdAt) index but its migration created neither.
--   * Phase 2 created `Contribution_capturedAt_idx`, which the final schema
--     does not declare (the column is evidence, not an access path).
--   * Phase 2 declared relations for `CollectorAssignmentEvent` and
--     `OfflineSyncAttempt` but created no foreign keys for either.
--   * Phase 2 gave `OfflineSyncAttempt.retryable` a DEFAULT of true while the
--     schema declares false; a row written without the field would have been
--     advertised as safely retryable.
--   * Phase 3 shipped no migration at all. Every remittance lifecycle column,
--     the `RemittanceContribution` attribution link and the
--     `RemittanceDiscrepancy` audit trail existed only in the Prisma schema.
--
-- Nothing here is destructive. `updatedAt` is added with a temporary default so
-- the column can be NOT NULL on tables that already hold rows, and the default
-- is then dropped so the schema and the database agree exactly.

-- ---------------------------------------------------------------------------
-- Assignment integrity: replace the legacy collector/account unique pair.
-- ---------------------------------------------------------------------------
DROP INDEX "CollectorCustomerAssignment_collectorId_accountId_key";

-- Backfill the active-assignment key for existing history that is unambiguous.
-- Rows that would collide (two ACTIVE assignments for one account) are left
-- NULL on purpose: this migration must not silently pick a winner or discard
-- an assignment. They stay visible for an authorised administrator to resolve.
UPDATE "CollectorCustomerAssignment" AS a
SET "activeAccountKey" = a."accountId"
WHERE a."active" = true
  AND (
    SELECT COUNT(*) FROM "CollectorCustomerAssignment" AS b
    WHERE b."accountId" = a."accountId" AND b."active" = true
  ) = 1;

-- ---------------------------------------------------------------------------
-- Offline capture evidence on the transaction envelope (Phase 2 schema).
-- ---------------------------------------------------------------------------
ALTER TABLE "OfflineTransaction" ADD COLUMN "capturedAt" TIMESTAMP(3);
CREATE INDEX "OfflineTransaction_tenantId_status_createdAt_idx"
    ON "OfflineTransaction"("tenantId", "status", "createdAt");

DROP INDEX "Contribution_capturedAt_idx";

-- ---------------------------------------------------------------------------
-- Offline sync attempt default must match the declared schema.
-- ---------------------------------------------------------------------------
ALTER TABLE "OfflineSyncAttempt" ALTER COLUMN "retryable" SET DEFAULT false;

-- ---------------------------------------------------------------------------
-- Remittance lifecycle columns (Phase 3 schema, previously migration-less).
-- ---------------------------------------------------------------------------
ALTER TABLE "CollectorRemittance"
    ADD COLUMN "custodyConfirmedAt" TIMESTAMP(3),
    ADD COLUMN "custodyConfirmedById" TEXT,
    ADD COLUMN "declarationNote" TEXT,
    ADD COLUMN "declaredAmount" DECIMAL(65,30),
    ADD COLUMN "declaredById" TEXT,
    ADD COLUMN "disputedAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    ADD COLUMN "evidenceRef" TEXT,
    ADD COLUMN "handoverAmount" DECIMAL(65,30),
    ADD COLUMN "handoverAt" TIMESTAMP(3),
    ADD COLUMN "method" TEXT NOT NULL DEFAULT 'cash',
    ADD COLUMN "outstandingAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    ADD COLUMN "provider" TEXT,
    ADD COLUMN "receiptEvidenceRef" TEXT,
    ADD COLUMN "receiptNote" TEXT,
    ADD COLUMN "receivedAmount" DECIMAL(65,30),
    ADD COLUMN "receivedAt" TIMESTAMP(3),
    ADD COLUMN "receivedById" TEXT,
    ADD COLUMN "receiverId" TEXT,
    ADD COLUMN "receivingBranchId" TEXT,
    ADD COLUMN "reconciliationStatus" TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN "submittedAt" TIMESTAMP(3),
    ADD COLUMN "transactionAt" TIMESTAMP(3),
    ADD COLUMN "transactionReference" TEXT,
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "verificationEvidenceRef" TEXT,
    ADD COLUMN "verificationNote" TEXT,
    ADD COLUMN "verifiedAmount" DECIMAL(65,30),
    ADD COLUMN "verifiedAt" TIMESTAMP(3),
    ADD COLUMN "verifiedById" TEXT;

ALTER TABLE "CollectorRemittance" ALTER COLUMN "updatedAt" DROP DEFAULT;
-- Existing rows predate the lifecycle. They are not rewritten: only the
-- default for NEW declarations changes, from the legacy 'pending' to 'draft'.
ALTER TABLE "CollectorRemittance" ALTER COLUMN "status" SET DEFAULT 'draft';

CREATE INDEX "CollectorRemittance_method_idx" ON "CollectorRemittance"("method");
CREATE INDEX "CollectorRemittance_receivingBranchId_idx" ON "CollectorRemittance"("receivingBranchId");

-- ---------------------------------------------------------------------------
-- Remittance contribution links. A declaration may settle PART of a
-- contribution (for example GH₵3,000 declared against GH₵5,000 collected), so the
-- same contribution can appear in a later declaration for the remainder.
-- Uniqueness is therefore per (remittance, contribution), and the server
-- enforces that the sum allocated to a contribution never exceeds its amount.
-- ---------------------------------------------------------------------------
CREATE TABLE "RemittanceContribution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "remittanceId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RemittanceContribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RemittanceContribution_remittanceId_contributionId_key" ON "RemittanceContribution"("remittanceId", "contributionId");
CREATE INDEX "RemittanceContribution_remittanceId_idx" ON "RemittanceContribution"("remittanceId");
CREATE INDEX "RemittanceContribution_contributionId_idx" ON "RemittanceContribution"("contributionId");
CREATE INDEX "RemittanceContribution_tenantId_idx" ON "RemittanceContribution"("tenantId");

-- ---------------------------------------------------------------------------
-- Discrepancy records and resolution history.
-- ---------------------------------------------------------------------------
CREATE TABLE "RemittanceDiscrepancy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "remittanceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expectedAmount" DECIMAL(65,30) NOT NULL,
    "declaredAmount" DECIMAL(65,30) NOT NULL,
    "receivedAmount" DECIMAL(65,30),
    "verifiedAmount" DECIMAL(65,30),
    "variance" DECIMAL(65,30) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "responsibleParty" TEXT,
    "evidenceRef" TEXT,
    "resolutionActorId" TEXT,
    "resolutionAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RemittanceDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RemittanceDiscrepancy_remittanceId_idx" ON "RemittanceDiscrepancy"("remittanceId");
CREATE INDEX "RemittanceDiscrepancy_status_idx" ON "RemittanceDiscrepancy"("status");
CREATE INDEX "RemittanceDiscrepancy_tenantId_idx" ON "RemittanceDiscrepancy"("tenantId");

-- ---------------------------------------------------------------------------
-- Foreign keys declared by the schema but missing from the phase migrations.
-- ---------------------------------------------------------------------------
ALTER TABLE "CollectorAssignmentEvent"
    ADD CONSTRAINT "CollectorAssignmentEvent_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "CollectorCustomerAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CollectorAssignmentEvent"
    ADD CONSTRAINT "CollectorAssignmentEvent_collectorId_fkey"
    FOREIGN KEY ("collectorId") REFERENCES "Collector"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CollectorAssignmentEvent"
    ADD CONSTRAINT "CollectorAssignmentEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OfflineSyncAttempt"
    ADD CONSTRAINT "OfflineSyncAttempt_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RemittanceContribution"
    ADD CONSTRAINT "RemittanceContribution_remittanceId_fkey"
    FOREIGN KEY ("remittanceId") REFERENCES "CollectorRemittance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemittanceContribution"
    ADD CONSTRAINT "RemittanceContribution_contributionId_fkey"
    FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RemittanceContribution"
    ADD CONSTRAINT "RemittanceContribution_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RemittanceDiscrepancy"
    ADD CONSTRAINT "RemittanceDiscrepancy_remittanceId_fkey"
    FOREIGN KEY ("remittanceId") REFERENCES "CollectorRemittance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemittanceDiscrepancy"
    ADD CONSTRAINT "RemittanceDiscrepancy_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
