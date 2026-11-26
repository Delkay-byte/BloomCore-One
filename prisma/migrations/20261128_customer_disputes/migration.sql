-- Customer disputes about a recorded contribution or withdrawal.
--
-- Additive. A dispute is a review record, not a financial mutation. One dispute
-- per tenant per transaction prevents duplicate open cases.

CREATE TABLE "CustomerDispute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "reference" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "accountId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectReference" TEXT NOT NULL,
    "subjectAmount" DECIMAL(65,30) NOT NULL,
    "category" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedByType" TEXT NOT NULL DEFAULT 'customer',
    "openedById" TEXT NOT NULL,
    "resolutionNote" TEXT,
    "resolutionById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "outcomeReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerDispute_tenantId_reference_key" ON "CustomerDispute"("tenantId", "reference");
CREATE UNIQUE INDEX "CustomerDispute_tenantId_subjectType_subjectId_key" ON "CustomerDispute"("tenantId", "subjectType", "subjectId");
CREATE INDEX "CustomerDispute_tenantId_status_idx" ON "CustomerDispute"("tenantId", "status");
CREATE INDEX "CustomerDispute_customerId_createdAt_idx" ON "CustomerDispute"("customerId", "createdAt");
CREATE INDEX "CustomerDispute_accountId_idx" ON "CustomerDispute"("accountId");

CREATE TABLE "CustomerDisputeEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "disputeId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerDisputeEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerDisputeEvent_disputeId_createdAt_idx" ON "CustomerDisputeEvent"("disputeId", "createdAt");
CREATE INDEX "CustomerDisputeEvent_tenantId_createdAt_idx" ON "CustomerDisputeEvent"("tenantId", "createdAt");

ALTER TABLE "CustomerDispute" ADD CONSTRAINT "CustomerDispute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerDispute" ADD CONSTRAINT "CustomerDispute_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerDispute" ADD CONSTRAINT "CustomerDispute_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SusuAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerDisputeEvent" ADD CONSTRAINT "CustomerDisputeEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerDisputeEvent" ADD CONSTRAINT "CustomerDisputeEvent_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "CustomerDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
