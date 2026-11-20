-- AlterTable
ALTER TABLE "CustomerDispute" ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalationNote" TEXT,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'normal';

-- CreateTable
CREATE TABLE "EvidenceAttachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedByType" TEXT NOT NULL DEFAULT 'admin',
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerWithdrawalRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "reference" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "cycleId" TEXT,
    "amountPesewa" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "resultingWithdrawalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerWithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceAttachment_storageKey_key" ON "EvidenceAttachment"("storageKey");

-- CreateIndex
CREATE INDEX "EvidenceAttachment_tenantId_subjectType_subjectId_idx" ON "EvidenceAttachment"("tenantId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "EvidenceAttachment_retentionUntil_idx" ON "EvidenceAttachment"("retentionUntil");

-- CreateIndex
CREATE INDEX "CustomerWithdrawalRequest_customerId_status_idx" ON "CustomerWithdrawalRequest"("customerId", "status");

-- CreateIndex
CREATE INDEX "CustomerWithdrawalRequest_tenantId_status_createdAt_idx" ON "CustomerWithdrawalRequest"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerWithdrawalRequest_tenantId_reference_key" ON "CustomerWithdrawalRequest"("tenantId", "reference");

-- AddForeignKey
ALTER TABLE "EvidenceAttachment" ADD CONSTRAINT "EvidenceAttachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerWithdrawalRequest" ADD CONSTRAINT "CustomerWithdrawalRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerWithdrawalRequest" ADD CONSTRAINT "CustomerWithdrawalRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerWithdrawalRequest" ADD CONSTRAINT "CustomerWithdrawalRequest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SusuAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

