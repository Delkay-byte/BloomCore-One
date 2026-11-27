-- Phase 1 — Susu multi-branch foundation.
-- Additive only. No existing column is dropped, renamed or rewritten.
-- Historical financial rows keep NULL branchId = LEGACY_UNASSIGNED.

-- CreateTable
CREATE TABLE "BranchMembership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'branch_manager',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BranchMembership_tenantId_userId_locationId_role_key" ON "BranchMembership"("tenantId", "userId", "locationId", "role");
CREATE INDEX "BranchMembership_tenantId_userId_status_idx" ON "BranchMembership"("tenantId", "userId", "status");
CREATE INDEX "BranchMembership_locationId_idx" ON "BranchMembership"("locationId");
CREATE INDEX "BranchMembership_tenantId_idx" ON "BranchMembership"("tenantId");

-- Branch responsibility on financial and operational records.
ALTER TABLE "Collector" ADD COLUMN "branchId" TEXT;
ALTER TABLE "Contribution" ADD COLUMN "branchId" TEXT;
ALTER TABLE "CollectorRemittance" ADD COLUMN "branchId" TEXT;
ALTER TABLE "Withdrawal" ADD COLUMN "branchId" TEXT;
ALTER TABLE "CustomerWithdrawalRequest" ADD COLUMN "branchId" TEXT;
ALTER TABLE "OfflineTransaction" ADD COLUMN "branchId" TEXT;
ALTER TABLE "OfflineActionRequest" ADD COLUMN "branchId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "branchId" TEXT;

CREATE INDEX "Collector_branchId_idx" ON "Collector"("branchId");
CREATE INDEX "Contribution_branchId_idx" ON "Contribution"("branchId");
CREATE INDEX "CollectorRemittance_branchId_idx" ON "CollectorRemittance"("branchId");
CREATE INDEX "Withdrawal_branchId_idx" ON "Withdrawal"("branchId");
CREATE INDEX "CustomerWithdrawalRequest_branchId_idx" ON "CustomerWithdrawalRequest"("branchId");
CREATE INDEX "OfflineTransaction_branchId_idx" ON "OfflineTransaction"("branchId");
CREATE INDEX "OfflineActionRequest_branchId_idx" ON "OfflineActionRequest"("branchId");
CREATE INDEX "AuditLog_branchId_idx" ON "AuditLog"("branchId");
