-- CreateTable
CREATE TABLE "AnomalyInvestigationDraft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "anomalyId" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'deterministic',
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "payload" TEXT NOT NULL,
    "generatedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalyInvestigationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnomalyInvestigationDraft_tenantId_anomalyId_createdAt_idx" ON "AnomalyInvestigationDraft"("tenantId", "anomalyId", "createdAt");

-- CreateIndex
CREATE INDEX "AnomalyInvestigationDraft_tenantId_status_idx" ON "AnomalyInvestigationDraft"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "AnomalyInvestigationDraft" ADD CONSTRAINT "AnomalyInvestigationDraft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyInvestigationDraft" ADD CONSTRAINT "AnomalyInvestigationDraft_anomalyId_fkey" FOREIGN KEY ("anomalyId") REFERENCES "OperationalAnomaly"("id") ON DELETE CASCADE ON UPDATE CASCADE;

