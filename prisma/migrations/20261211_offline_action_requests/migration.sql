-- AlterTable
ALTER TABLE "TenantOperationalPolicy" ADD COLUMN     "offlineIdleLockMinutes" INTEGER;

-- CreateTable
CREATE TABLE "OfflineActionRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "conflictReason" TEXT,
    "deviceId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "resultingEntityType" TEXT,
    "resultingEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfflineActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfflineActionRequest_tenantId_status_requestedAt_idx" ON "OfflineActionRequest"("tenantId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "OfflineActionRequest_requestedById_requestedAt_idx" ON "OfflineActionRequest"("requestedById", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineActionRequest_tenantId_idempotencyKey_key" ON "OfflineActionRequest"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "OfflineActionRequest" ADD CONSTRAINT "OfflineActionRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

