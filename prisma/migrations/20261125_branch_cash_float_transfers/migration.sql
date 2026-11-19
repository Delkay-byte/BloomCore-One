-- Internal cash and float management with branch transfers.
--
-- Purely additive. Declared balances are operator declarations, not provider
-- confirmations. Every transfer transition is recorded as an immutable event,
-- and the transfer row preserves the actor and timestamp of each completed
-- step. Nothing in this migration rewrites an existing financial record.

CREATE TABLE "BranchAssetBalance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "locationId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "declaredBalance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declaredById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchAssetBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BranchAssetBalance_tenantId_locationId_assetType_key" ON "BranchAssetBalance"("tenantId", "locationId", "assetType");
CREATE INDEX "BranchAssetBalance_tenantId_assetType_idx" ON "BranchAssetBalance"("tenantId", "assetType");
CREATE INDEX "BranchAssetBalance_locationId_idx" ON "BranchAssetBalance"("locationId");

CREATE TABLE "BranchTransfer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "reference" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'none',
    "sourceLocationId" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "purpose" TEXT,
    "notes" TEXT,
    "initiatedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "actualAmountReceived" DECIMAL(65,30),
    "variance" DECIMAL(65,30),
    "varianceReason" TEXT,
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BranchTransfer_tenantId_reference_key" ON "BranchTransfer"("tenantId", "reference");
CREATE UNIQUE INDEX "BranchTransfer_tenantId_idempotencyKey_key" ON "BranchTransfer"("tenantId", "idempotencyKey");
CREATE INDEX "BranchTransfer_tenantId_status_createdAt_idx" ON "BranchTransfer"("tenantId", "status", "createdAt");
CREATE INDEX "BranchTransfer_sourceLocationId_assetType_idx" ON "BranchTransfer"("sourceLocationId", "assetType");
CREATE INDEX "BranchTransfer_destinationLocationId_assetType_idx" ON "BranchTransfer"("destinationLocationId", "assetType");
CREATE INDEX "BranchTransfer_status_idx" ON "BranchTransfer"("status");

CREATE TABLE "BranchTransferEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "transferId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchTransferEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BranchTransferEvent_transferId_createdAt_idx" ON "BranchTransferEvent"("transferId", "createdAt");
CREATE INDEX "BranchTransferEvent_tenantId_createdAt_idx" ON "BranchTransferEvent"("tenantId", "createdAt");

ALTER TABLE "BranchAssetBalance" ADD CONSTRAINT "BranchAssetBalance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BranchAssetBalance" ADD CONSTRAINT "BranchAssetBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BranchTransfer" ADD CONSTRAINT "BranchTransfer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BranchTransfer" ADD CONSTRAINT "BranchTransfer_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BranchTransfer" ADD CONSTRAINT "BranchTransfer_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BranchTransferEvent" ADD CONSTRAINT "BranchTransferEvent_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "BranchTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
