-- Phase 4 — enterprise withdrawal controls.
-- Additive only. Existing withdrawal records keep their values and history.

-- CreateTable
CREATE TABLE "WithdrawalPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "minAmountPesewa" INTEGER NOT NULL DEFAULT 0,
    "maxAmountPesewa" INTEGER NOT NULL DEFAULT 99999999,
    "highValueThresholdPesewa" INTEGER,
    "highValueRequiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 0,
    "separationOfDuties" BOOLEAN NOT NULL DEFAULT false,
    "requireStepUp" BOOLEAN NOT NULL DEFAULT true,
    "requirePaymentEvidence" BOOLEAN NOT NULL DEFAULT false,
    "requiredEvidenceFields" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WithdrawalPolicyHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WithdrawalPolicyHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WithdrawalApproval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "WithdrawalApproval_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "WithdrawalPolicy_tenantId_key" ON "WithdrawalPolicy"("tenantId");
CREATE INDEX "WithdrawalPolicy_tenantId_active_idx" ON "WithdrawalPolicy"("tenantId", "active");
CREATE INDEX "WithdrawalPolicyHistory_tenantId_createdAt_idx" ON "WithdrawalPolicyHistory"("tenantId", "createdAt");
CREATE INDEX "WithdrawalPolicyHistory_policyId_idx" ON "WithdrawalPolicyHistory"("policyId");
CREATE UNIQUE INDEX "WithdrawalApproval_tenantId_requestId_approverId_key" ON "WithdrawalApproval"("tenantId", "requestId", "approverId");
CREATE INDEX "WithdrawalApproval_tenantId_requestId_status_idx" ON "WithdrawalApproval"("tenantId", "requestId", "status");

-- Foreign key
ALTER TABLE "WithdrawalApproval" ADD CONSTRAINT "WithdrawalApproval_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CustomerWithdrawalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Request lifecycle fields
ALTER TABLE "CustomerWithdrawalRequest"
    ADD COLUMN "highValue" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "requiredApprovals" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "policyVersion" INTEGER,
    ADD COLUMN "approvedById" TEXT,
    ADD COLUMN "approvedAt" TIMESTAMP(3),
    ADD COLUMN "paymentInitiatedById" TEXT,
    ADD COLUMN "paymentInitiatedAt" TIMESTAMP(3),
    ADD COLUMN "paymentMethod" TEXT,
    ADD COLUMN "paymentReference" TEXT,
    ADD COLUMN "paidAt" TIMESTAMP(3),
    ADD COLUMN "evidenceRef" TEXT,
    ADD COLUMN "reasonCode" TEXT,
    ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
    ADD COLUMN "acknowledgedById" TEXT;

-- Payment record fields
ALTER TABLE "Withdrawal"
    ADD COLUMN "requestId" TEXT,
    ADD COLUMN "paymentMethod" TEXT,
    ADD COLUMN "paymentReference" TEXT,
    ADD COLUMN "paidById" TEXT,
    ADD COLUMN "paidAt" TIMESTAMP(3),
    ADD COLUMN "evidenceRef" TEXT,
    ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
    ADD COLUMN "acknowledgedById" TEXT,
    ADD COLUMN "reasonCode" TEXT;
