-- CreateTable
CREATE TABLE "MomoOfflineDraft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "conflictReason" TEXT,
    "appliedAccountId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomoOfflineDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MomoOfflineDraft_tenantId_status_businessDate_idx" ON "MomoOfflineDraft"("tenantId", "status", "businessDate");

-- CreateIndex
CREATE INDEX "MomoOfflineDraft_userId_businessDate_idx" ON "MomoOfflineDraft"("userId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "MomoOfflineDraft_tenantId_idempotencyKey_key" ON "MomoOfflineDraft"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "MomoOfflineDraft" ADD CONSTRAINT "MomoOfflineDraft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

