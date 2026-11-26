-- AlterTable
ALTER TABLE "ZeliPlan" ADD COLUMN     "addonKey" TEXT;

-- CreateTable
CREATE TABLE "AiInvestigationEntitlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "subscriptionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "activatedById" TEXT NOT NULL,
    "activatedByEmail" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "revokedById" TEXT,
    "revokedByEmail" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiInvestigationEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInvestigationUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "limit" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInvestigationUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiInvestigationEntitlement_tenantId_key" ON "AiInvestigationEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX "AiInvestigationEntitlement_status_idx" ON "AiInvestigationEntitlement"("status");

-- CreateIndex
CREATE INDEX "AiInvestigationEntitlement_expiresAt_idx" ON "AiInvestigationEntitlement"("expiresAt");

-- CreateIndex
CREATE INDEX "AiInvestigationUsage_period_idx" ON "AiInvestigationUsage"("period");

-- CreateIndex
CREATE UNIQUE INDEX "AiInvestigationUsage_tenantId_period_key" ON "AiInvestigationUsage"("tenantId", "period");

-- CreateIndex
CREATE INDEX "ZeliPlan_addonKey_idx" ON "ZeliPlan"("addonKey");

-- AddForeignKey
ALTER TABLE "AiInvestigationEntitlement" ADD CONSTRAINT "AiInvestigationEntitlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInvestigationUsage" ADD CONSTRAINT "AiInvestigationUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

