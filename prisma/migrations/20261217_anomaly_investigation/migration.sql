-- AlterTable
ALTER TABLE "OperationalAnomaly" ADD COLUMN     "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "reopenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "snapshotHash" TEXT;

-- CreateTable
CREATE TABLE "AnomalyFindingEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "anomalyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT,
    "metricValue" DECIMAL(65,30),
    "thresholdValue" DECIMAL(65,30),
    "summary" TEXT,
    "evidence" TEXT,
    "snapshotHash" TEXT,
    "note" TEXT,
    "actorId" TEXT,
    "scanRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalyFindingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalyInvestigation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "anomalyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigneeId" TEXT,
    "dueAt" TIMESTAMP(3),
    "disposition" TEXT,
    "dispositionNote" TEXT,
    "linkedCorrectionType" TEXT,
    "linkedCorrectionId" TEXT,
    "openedById" TEXT NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnomalyInvestigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalyInvestigationTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "investigationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "doneById" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalyInvestigationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalyInvestigationComment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "investigationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalyInvestigationComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalySuppression" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalySuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalyScanRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "reopened" INTEGER NOT NULL DEFAULT 0,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "periodFrom" TEXT,
    "periodTo" TEXT,
    "error" TEXT,

    CONSTRAINT "AnomalyScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnomalyFindingEvent_tenantId_anomalyId_createdAt_idx" ON "AnomalyFindingEvent"("tenantId", "anomalyId", "createdAt");

-- CreateIndex
CREATE INDEX "AnomalyFindingEvent_tenantId_kind_createdAt_idx" ON "AnomalyFindingEvent"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnomalyInvestigation_anomalyId_key" ON "AnomalyInvestigation"("anomalyId");

-- CreateIndex
CREATE INDEX "AnomalyInvestigation_tenantId_status_dueAt_idx" ON "AnomalyInvestigation"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "AnomalyInvestigation_tenantId_assigneeId_idx" ON "AnomalyInvestigation"("tenantId", "assigneeId");

-- CreateIndex
CREATE INDEX "AnomalyInvestigationTask_investigationId_sequence_idx" ON "AnomalyInvestigationTask"("investigationId", "sequence");

-- CreateIndex
CREATE INDEX "AnomalyInvestigationComment_investigationId_createdAt_idx" ON "AnomalyInvestigationComment"("investigationId", "createdAt");

-- CreateIndex
CREATE INDEX "AnomalySuppression_tenantId_ruleKey_expiresAt_idx" ON "AnomalySuppression"("tenantId", "ruleKey", "expiresAt");

-- CreateIndex
CREATE INDEX "AnomalyScanRun_tenantId_startedAt_idx" ON "AnomalyScanRun"("tenantId", "startedAt");

-- AddForeignKey
ALTER TABLE "AnomalyFindingEvent" ADD CONSTRAINT "AnomalyFindingEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyFindingEvent" ADD CONSTRAINT "AnomalyFindingEvent_anomalyId_fkey" FOREIGN KEY ("anomalyId") REFERENCES "OperationalAnomaly"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyInvestigation" ADD CONSTRAINT "AnomalyInvestigation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyInvestigation" ADD CONSTRAINT "AnomalyInvestigation_anomalyId_fkey" FOREIGN KEY ("anomalyId") REFERENCES "OperationalAnomaly"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyInvestigationTask" ADD CONSTRAINT "AnomalyInvestigationTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyInvestigationTask" ADD CONSTRAINT "AnomalyInvestigationTask_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "AnomalyInvestigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyInvestigationComment" ADD CONSTRAINT "AnomalyInvestigationComment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyInvestigationComment" ADD CONSTRAINT "AnomalyInvestigationComment_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "AnomalyInvestigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalySuppression" ADD CONSTRAINT "AnomalySuppression_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyScanRun" ADD CONSTRAINT "AnomalyScanRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

