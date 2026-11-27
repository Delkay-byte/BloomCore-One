-- Phase 7 — customer onboarding, bulk import and data migration.
--
-- ADDITIVE ONLY. No existing column, index, row or financial record is
-- dropped, renamed, retyped or rewritten. Existing customers and accounts keep
-- working: every new column is nullable, so historical rows stay valid and
-- remain visibly unattributed rather than silently guessed.
--
-- Design notes that matter for correctness:
--   * `Customer.externalReference` is deliberately NOT unique. It is the
--     business's own paper/legacy key; two real people can be typed with the
--     same value and the database must not refuse a customer because of it.
--     Duplicate detection treats an exact match as a signal for a human.
--   * Branch attribution lives on `SusuAccount`, not `Customer`, because one
--     customer may hold accounts in several branches.
--   * `SusuAccount.openingDate` is kept apart from `createdAt` so a migrated
--     account preserves the real opening date while its audit timestamps
--     honestly record when MaaCash learned about it.
--   * The import tables store no financial activity. A migration creates
--     customer/account identity only; balances and transactions are never
--     synthesised.

-- ---------------------------------------------------------------------------
-- Customer: migration provenance.
-- ---------------------------------------------------------------------------
ALTER TABLE "Customer" ADD COLUMN "externalReference" TEXT;
ALTER TABLE "Customer" ADD COLUMN "registeredVia" TEXT;
ALTER TABLE "Customer" ADD COLUMN "registeredById" TEXT;
ALTER TABLE "Customer" ADD COLUMN "registeredBranchId" TEXT;
ALTER TABLE "Customer" ADD COLUMN "notes" TEXT;

CREATE INDEX "Customer_tenantId_externalReference_idx"
    ON "Customer"("tenantId", "externalReference");
CREATE INDEX "Customer_tenantId_registeredBranchId_idx"
    ON "Customer"("tenantId", "registeredBranchId");

-- ---------------------------------------------------------------------------
-- SusuAccount: account-level branch attribution and migration provenance.
-- ---------------------------------------------------------------------------
ALTER TABLE "SusuAccount" ADD COLUMN "branchId" TEXT;
ALTER TABLE "SusuAccount" ADD COLUMN "openingDate" TIMESTAMP(3);
ALTER TABLE "SusuAccount" ADD COLUMN "openedVia" TEXT;
ALTER TABLE "SusuAccount" ADD COLUMN "openedById" TEXT;
ALTER TABLE "SusuAccount" ADD COLUMN "externalAccountReference" TEXT;
ALTER TABLE "SusuAccount" ADD COLUMN "importBatchId" TEXT;

CREATE INDEX "SusuAccount_tenantId_branchId_idx"
    ON "SusuAccount"("tenantId", "branchId");
CREATE INDEX "SusuAccount_tenantId_externalAccountReference_idx"
    ON "SusuAccount"("tenantId", "externalAccountReference");
CREATE INDEX "SusuAccount_importBatchId_idx"
    ON "SusuAccount"("importBatchId");

-- ---------------------------------------------------------------------------
-- Staged import batches.
-- ---------------------------------------------------------------------------
CREATE TABLE "CustomerImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "branchId" TEXT,
    "branchMode" TEXT NOT NULL DEFAULT 'single_branch',
    "name" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL DEFAULT 'csv',
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "sourceText" TEXT,
    "headerHash" TEXT NOT NULL,
    "headers" TEXT NOT NULL,
    "columnMapping" TEXT,
    "status" TEXT NOT NULL DEFAULT 'staged',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "newCustomerRows" INTEGER NOT NULL DEFAULT 0,
    "existingCustomerRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "reviewRows" INTEGER NOT NULL DEFAULT 0,
    "importedCustomers" INTEGER NOT NULL DEFAULT 0,
    "importedAccounts" INTEGER NOT NULL DEFAULT 0,
    "linkedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "planHash" TEXT,
    "initiatedById" TEXT NOT NULL,
    "validatedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "commitToken" TEXT,
    "commitStartedAt" TIMESTAMP(3),
    "commitLeaseUntil" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "committedById" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerImportBatch_tenantId_fileHash_key"
    ON "CustomerImportBatch"("tenantId", "fileHash");
CREATE INDEX "CustomerImportBatch_tenantId_status_createdAt_idx"
    ON "CustomerImportBatch"("tenantId", "status", "createdAt");
CREATE INDEX "CustomerImportBatch_tenantId_branchId_idx"
    ON "CustomerImportBatch"("tenantId", "branchId");
CREATE INDEX "CustomerImportBatch_tenantId_initiatedById_idx"
    ON "CustomerImportBatch"("tenantId", "initiatedById");

-- ---------------------------------------------------------------------------
-- Staged rows: the operator's original values, the classification, the
-- decision and the outcome.
-- ---------------------------------------------------------------------------
CREATE TABLE "CustomerImportRow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawRow" TEXT,
    "customerName" TEXT,
    "phone" TEXT,
    "phoneNormalized" TEXT,
    "email" TEXT,
    "externalReference" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "accountNumber" TEXT,
    "dailyContribution" DECIMAL(65,30),
    "openingDate" TIMESTAMP(3),
    "branchRef" TEXT,
    "collectorRef" TEXT,
    "classification" TEXT NOT NULL DEFAULT 'invalid',
    "issues" TEXT,
    "matchReasons" TEXT,
    "matchedCustomerId" TEXT,
    "matchedAccountId" TEXT,
    "branchId" TEXT,
    "collectorId" TEXT,
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "outcome" TEXT,
    "outcomeMessage" TEXT,
    "createdCustomerId" TEXT,
    "createdAccountId" TEXT,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerImportRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerImportRow_batchId_rowNumber_key"
    ON "CustomerImportRow"("batchId", "rowNumber");
CREATE INDEX "CustomerImportRow_batchId_classification_idx"
    ON "CustomerImportRow"("batchId", "classification");
CREATE INDEX "CustomerImportRow_batchId_outcome_idx"
    ON "CustomerImportRow"("batchId", "outcome");
CREATE INDEX "CustomerImportRow_tenantId_matchedCustomerId_idx"
    ON "CustomerImportRow"("tenantId", "matchedCustomerId");
CREATE INDEX "CustomerImportRow_tenantId_matchedAccountId_idx"
    ON "CustomerImportRow"("tenantId", "matchedAccountId");

-- ---------------------------------------------------------------------------
-- Append-only per-row decision history.
-- ---------------------------------------------------------------------------
CREATE TABLE "CustomerImportRowEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "batchId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" TEXT,
    "fromResolution" TEXT,
    "toResolution" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerImportRowEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerImportRowEvent_tenantId_batchId_createdAt_idx"
    ON "CustomerImportRowEvent"("tenantId", "batchId", "createdAt");
CREATE INDEX "CustomerImportRowEvent_rowId_createdAt_idx"
    ON "CustomerImportRowEvent"("rowId", "createdAt");

-- ---------------------------------------------------------------------------
-- Foreign keys. ON DELETE CASCADE only for the row/event children of a batch:
-- a deleted batch must not leave orphaned staging rows. Tenant links stay
-- RESTRICT-equivalent (no action) so a tenant cannot be removed while it still
-- owns migration evidence.
-- ---------------------------------------------------------------------------
ALTER TABLE "CustomerImportBatch" ADD CONSTRAINT "CustomerImportBatch_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerImportRow" ADD CONSTRAINT "CustomerImportRow_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "CustomerImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerImportRow" ADD CONSTRAINT "CustomerImportRow_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerImportRowEvent" ADD CONSTRAINT "CustomerImportRowEvent_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "CustomerImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerImportRowEvent" ADD CONSTRAINT "CustomerImportRowEvent_rowId_fkey"
    FOREIGN KEY ("rowId") REFERENCES "CustomerImportRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerImportRowEvent" ADD CONSTRAINT "CustomerImportRowEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
