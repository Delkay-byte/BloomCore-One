-- AlterTable
ALTER TABLE "BranchTransfer" ADD COLUMN     "followUpTransferId" TEXT,
ADD COLUMN     "outstandingAmount" DECIMAL(65,30),
ADD COLUMN     "parentTransferId" TEXT,
ADD COLUMN     "settledAmount" DECIMAL(65,30),
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settledById" TEXT,
ADD COLUMN     "settlementStatus" TEXT;

-- CreateTable
CREATE TABLE "ProviderStatementImport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "provider" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileSizeBytes" INTEGER,
    "columnMapping" TEXT,
    "status" TEXT NOT NULL DEFAULT 'parsed',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "matchedRows" INTEGER NOT NULL DEFAULT 0,
    "unmatchedRows" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "note" TEXT,
    "importedById" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderStatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderStatementRow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "externalReference" TEXT,
    "transactionAt" TIMESTAMP(3),
    "direction" TEXT,
    "amount" DECIMAL(65,30),
    "fee" DECIMAL(65,30),
    "balanceAfter" DECIMAL(65,30),
    "description" TEXT,
    "rawRow" TEXT,
    "status" TEXT NOT NULL DEFAULT 'valid',
    "validationError" TEXT,
    "duplicateOfId" TEXT,
    "matchedEntityType" TEXT,
    "matchedEntityId" TEXT,
    "matchType" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderStatementRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchLiquiditySnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "locationId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "dailyAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchLiquiditySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchLiquidityLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "snapshotId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "openingDeclared" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "transferAdjustment" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "expectedClose" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "countedClose" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "variance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchLiquidityLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationExceptionCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "caseNumber" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "evidence" TEXT,
    "resolutionType" TEXT,
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationExceptionCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationExceptionLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "caseId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationExceptionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationExceptionEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT,
    "note" TEXT,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationExceptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderStatementImport_tenantId_provider_createdAt_idx" ON "ProviderStatementImport"("tenantId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderStatementImport_tenantId_status_idx" ON "ProviderStatementImport"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderStatementImport_tenantId_fileHash_key" ON "ProviderStatementImport"("tenantId", "fileHash");

-- CreateIndex
CREATE INDEX "ProviderStatementRow_tenantId_fingerprint_idx" ON "ProviderStatementRow"("tenantId", "fingerprint");

-- CreateIndex
CREATE INDEX "ProviderStatementRow_importId_status_idx" ON "ProviderStatementRow"("importId", "status");

-- CreateIndex
CREATE INDEX "ProviderStatementRow_tenantId_matchedEntityId_idx" ON "ProviderStatementRow"("tenantId", "matchedEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderStatementRow_importId_rowNumber_key" ON "ProviderStatementRow"("importId", "rowNumber");

-- CreateIndex
CREATE INDEX "BranchLiquiditySnapshot_tenantId_businessDate_idx" ON "BranchLiquiditySnapshot"("tenantId", "businessDate");

-- CreateIndex
CREATE INDEX "BranchLiquiditySnapshot_tenantId_status_idx" ON "BranchLiquiditySnapshot"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BranchLiquiditySnapshot_tenantId_locationId_businessDate_key" ON "BranchLiquiditySnapshot"("tenantId", "locationId", "businessDate");

-- CreateIndex
CREATE INDEX "BranchLiquidityLine_tenantId_assetType_idx" ON "BranchLiquidityLine"("tenantId", "assetType");

-- CreateIndex
CREATE UNIQUE INDEX "BranchLiquidityLine_snapshotId_assetType_key" ON "BranchLiquidityLine"("snapshotId", "assetType");

-- CreateIndex
CREATE INDEX "ReconciliationExceptionCase_tenantId_status_severity_idx" ON "ReconciliationExceptionCase"("tenantId", "status", "severity");

-- CreateIndex
CREATE INDEX "ReconciliationExceptionCase_tenantId_category_idx" ON "ReconciliationExceptionCase"("tenantId", "category");

-- CreateIndex
CREATE INDEX "ReconciliationExceptionCase_tenantId_ownerId_idx" ON "ReconciliationExceptionCase"("tenantId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationExceptionCase_tenantId_caseNumber_key" ON "ReconciliationExceptionCase"("tenantId", "caseNumber");

-- CreateIndex
CREATE INDEX "ReconciliationExceptionLink_tenantId_entityType_entityId_idx" ON "ReconciliationExceptionLink"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "ReconciliationExceptionLink_caseId_createdAt_idx" ON "ReconciliationExceptionLink"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationExceptionEvent_caseId_createdAt_idx" ON "ReconciliationExceptionEvent"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationExceptionEvent_tenantId_type_idx" ON "ReconciliationExceptionEvent"("tenantId", "type");

-- AddForeignKey
ALTER TABLE "BranchTransfer" ADD CONSTRAINT "BranchTransfer_parentTransferId_fkey" FOREIGN KEY ("parentTransferId") REFERENCES "BranchTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderStatementImport" ADD CONSTRAINT "ProviderStatementImport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderStatementRow" ADD CONSTRAINT "ProviderStatementRow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderStatementRow" ADD CONSTRAINT "ProviderStatementRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ProviderStatementImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchLiquiditySnapshot" ADD CONSTRAINT "BranchLiquiditySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchLiquiditySnapshot" ADD CONSTRAINT "BranchLiquiditySnapshot_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchLiquiditySnapshot" ADD CONSTRAINT "BranchLiquiditySnapshot_dailyAccountId_fkey" FOREIGN KEY ("dailyAccountId") REFERENCES "DailyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchLiquidityLine" ADD CONSTRAINT "BranchLiquidityLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchLiquidityLine" ADD CONSTRAINT "BranchLiquidityLine_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BranchLiquiditySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationExceptionCase" ADD CONSTRAINT "ReconciliationExceptionCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationExceptionLink" ADD CONSTRAINT "ReconciliationExceptionLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationExceptionLink" ADD CONSTRAINT "ReconciliationExceptionLink_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ReconciliationExceptionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationExceptionEvent" ADD CONSTRAINT "ReconciliationExceptionEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationExceptionEvent" ADD CONSTRAINT "ReconciliationExceptionEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ReconciliationExceptionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

