-- CreateTable
CREATE TABLE "RiskIntelligenceConsent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "policyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "scope" TEXT NOT NULL DEFAULT 'share_signals',
    "consentedById" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnById" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawReason" TEXT,
    "billingBasis" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskIntelligenceConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRiskSignal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "keyBasis" TEXT NOT NULL,
    "saltVersion" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "internalNote" TEXT,
    "observedFrom" TIMESTAMP(3) NOT NULL,
    "observedTo" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRiskSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskIntelligenceDisclosure" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "disclosed" TEXT NOT NULL,
    "contributorCount" INTEGER NOT NULL,
    "viewerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskIntelligenceDisclosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskIntelligenceConsent_tenantId_status_idx" ON "RiskIntelligenceConsent"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RiskIntelligenceConsent_tenantId_policyVersion_key" ON "RiskIntelligenceConsent"("tenantId", "policyVersion");

-- CreateIndex
CREATE INDEX "AgentRiskSignal_subjectKey_status_idx" ON "AgentRiskSignal"("subjectKey", "status");

-- CreateIndex
CREATE INDEX "AgentRiskSignal_tenantId_status_idx" ON "AgentRiskSignal"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AgentRiskSignal_expiresAt_idx" ON "AgentRiskSignal"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRiskSignal_tenantId_subjectKey_sourceType_sourceId_key" ON "AgentRiskSignal"("tenantId", "subjectKey", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "RiskIntelligenceDisclosure_tenantId_createdAt_idx" ON "RiskIntelligenceDisclosure"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskIntelligenceDisclosure_subjectKey_createdAt_idx" ON "RiskIntelligenceDisclosure"("subjectKey", "createdAt");

-- AddForeignKey
ALTER TABLE "RiskIntelligenceConsent" ADD CONSTRAINT "RiskIntelligenceConsent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRiskSignal" ADD CONSTRAINT "AgentRiskSignal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskIntelligenceDisclosure" ADD CONSTRAINT "RiskIntelligenceDisclosure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

