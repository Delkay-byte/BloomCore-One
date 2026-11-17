-- AlterTable
ALTER TABLE "ZeliPlan" ADD COLUMN     "foundingPrice" DECIMAL(65,30),
ADD COLUMN     "zeliIncluded" BOOLEAN NOT NULL DEFAULT true;
-- AlterTable
ALTER TABLE "ZeliSubscription" ADD COLUMN     "billingTerm" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "foundingAllocationId" TEXT,
ADD COLUMN     "graceEndsAt" TIMESTAMP(3),
ADD COLUMN     "reminderStage" TEXT,
ADD COLUMN     "standardAmount" DECIMAL(65,30);
-- AlterTable
ALTER TABLE "AccountEnquiry" ADD COLUMN     "assignedPlanCode" TEXT,
ADD COLUMN     "billingTerm" TEXT,
ADD COLUMN     "convertedAt" TIMESTAMP(3),
ADD COLUMN     "tenantId" TEXT;
-- CreateTable
CREATE TABLE "FoundingAllocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "monthlyPrice" DECIMAL(65,30) NOT NULL,
    "standardPrice" DECIMAL(65,30) NOT NULL,
    "periodsGranted" INTEGER NOT NULL DEFAULT 3,
    "periodsUsed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FoundingAllocation_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "TenantNotification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'tenant',
    "kind" TEXT NOT NULL DEFAULT 'system',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantNotification_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ZeliUsagePeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "limit" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZeliUsagePeriod_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "FoundingAllocation_tenantId_key" ON "FoundingAllocation"("tenantId");
-- CreateIndex
CREATE UNIQUE INDEX "FoundingAllocation_slot_key" ON "FoundingAllocation"("slot");
-- CreateIndex
CREATE INDEX "FoundingAllocation_status_idx" ON "FoundingAllocation"("status");
-- CreateIndex
CREATE UNIQUE INDEX "TenantNotification_dedupeKey_key" ON "TenantNotification"("dedupeKey");
-- CreateIndex
CREATE INDEX "TenantNotification_tenantId_createdAt_idx" ON "TenantNotification"("tenantId", "createdAt");
-- CreateIndex
CREATE INDEX "TenantNotification_audience_createdAt_idx" ON "TenantNotification"("audience", "createdAt");
-- CreateIndex
CREATE INDEX "TenantNotification_resolvedAt_idx" ON "TenantNotification"("resolvedAt");
-- CreateIndex
CREATE INDEX "ZeliUsagePeriod_period_idx" ON "ZeliUsagePeriod"("period");
-- CreateIndex
CREATE UNIQUE INDEX "ZeliUsagePeriod_tenantId_period_key" ON "ZeliUsagePeriod"("tenantId", "period");
-- CreateIndex
CREATE INDEX "AccountEnquiry_tenantId_idx" ON "AccountEnquiry"("tenantId");
-- AddForeignKey
ALTER TABLE "AccountEnquiry" ADD CONSTRAINT "AccountEnquiry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FoundingAllocation" ADD CONSTRAINT "FoundingAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "FoundingAllocation" ADD CONSTRAINT "FoundingAllocation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ZeliPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "TenantNotification" ADD CONSTRAINT "TenantNotification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Approved commercial catalogue (six plans, GHS). Idempotent: an existing row
-- or a later Platform Super Admin edit is never overwritten.
-- usageAllowance is the included Zeli request allowance per calendar month.
-- ---------------------------------------------------------------------------
INSERT INTO "ZeliPlan" (
  "id", "code", "name", "description", "billingInterval", "price", "currency",
  "features", "usageAllowance", "trialDays", "locationLimit", "staffLimit",
  "supportLevel", "foundingPrice", "zeliIncluded", "status", "isPublic",
  "sortOrder", "updatedAt"
) VALUES
  ('plan_starter', 'starter', 'Starter',
   'For a single-branch business moving its mobile money and Susu records online.',
   'month', 99, 'GHS',
   '["Mobile money records","Susu collections","Zeli AI assistant","Branch dashboard","Staff accounts","Daily reconciliation"]',
   250, 0, 1, 3, 'Standard', 79, true, 'active', true, 10, CURRENT_TIMESTAMP),
  ('plan_business', 'business', 'Business',
   'For a growing business with up to three branches and a larger team.',
   'month', 169, 'GHS',
   '["Everything in Starter","Up to 3 branches","Customer portal","Collector assignments","Remittance tracking","Zeli AI with larger allowance"]',
   600, 0, 3, 10, 'Priority', 149, true, 'active', true, 20, CURRENT_TIMESTAMP),
  ('plan_multi_branch', 'multi-branch', 'Multi-Branch',
   'For multi-branch operations that need branch-level oversight and insights.',
   'month', 339, 'GHS',
   '["Everything in Business","Up to 5 branches","Branch-level Zeli insights","Advanced reporting","Dedicated support","Highest Zeli allowance"]',
   1500, 0, 5, 20, 'Dedicated', 225, true, 'active', true, 30, CURRENT_TIMESTAMP),
  ('plan_starter_annual', 'starter-annual', 'Starter (Annual)',
   'Starter billed once a year at a lower effective monthly rate.',
   'year', 1070, 'GHS',
   '["Mobile money records","Susu collections","Zeli AI assistant","Branch dashboard","Staff accounts","Daily reconciliation"]',
   250, 0, 1, 3, 'Standard', NULL, true, 'active', true, 40, CURRENT_TIMESTAMP),
  ('plan_business_annual', 'business-annual', 'Business (Annual)',
   'Business billed once a year at a lower effective monthly rate.',
   'year', 1825, 'GHS',
   '["Everything in Starter","Up to 3 branches","Customer portal","Collector assignments","Remittance tracking","Zeli AI with larger allowance"]',
   600, 0, 3, 10, 'Priority', NULL, true, 'active', true, 50, CURRENT_TIMESTAMP),
  ('plan_multi_branch_annual', 'multi-branch-annual', 'Multi-Branch (Annual)',
   'Multi-Branch billed once a year at a lower effective monthly rate.',
   'year', 3660, 'GHS',
   '["Everything in Business","Up to 5 branches","Branch-level Zeli insights","Advanced reporting","Dedicated support","Highest Zeli allowance"]',
   1500, 0, 5, 20, 'Dedicated', NULL, true, 'active', true, 60, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
