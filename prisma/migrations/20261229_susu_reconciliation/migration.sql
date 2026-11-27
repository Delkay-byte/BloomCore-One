-- Phase 5: Susu reconciliation, daily collector closing and exception management.
--
-- Additive only. No existing table, column, index or record is dropped,
-- renamed, truncated or rewritten. Existing contributions, remittances,
-- offline sync attempts, provider-statement cases and LEGACY_UNASSIGNED
-- branch records keep working unchanged.

-- ---------------------------------------------------------------------------
-- SusuReconciliation: one bounded detection run over one branch/period.
-- ---------------------------------------------------------------------------
CREATE TABLE "SusuReconciliation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "branchId" TEXT,
    "collectorId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "definitionVersion" INTEGER NOT NULL DEFAULT 1,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastRunById" TEXT,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SusuReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SusuReconciliation_tenantId_status_type_idx"
    ON "SusuReconciliation"("tenantId", "status", "type");
CREATE INDEX "SusuReconciliation_tenantId_branchId_status_idx"
    ON "SusuReconciliation"("tenantId", "branchId", "status");
CREATE INDEX "SusuReconciliation_tenantId_collectorId_periodStart_idx"
    ON "SusuReconciliation"("tenantId", "collectorId", "periodStart");
CREATE INDEX "SusuReconciliation_tenantId_type_openedAt_idx"
    ON "SusuReconciliation"("tenantId", "type", "openedAt");
CREATE INDEX "SusuReconciliation_branchId_openedAt_idx"
    ON "SusuReconciliation"("branchId", "openedAt");

ALTER TABLE "SusuReconciliation"
    ADD CONSTRAINT "SusuReconciliation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SusuReconciliation"
    ADD CONSTRAINT "SusuReconciliation_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SusuReconciliation"
    ADD CONSTRAINT "SusuReconciliation_collectorId_fkey"
    FOREIGN KEY ("collectorId") REFERENCES "Collector"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- DailyCollectorClosing: operational daily handover, distinct from a formal
-- Phase 3 remittance. Unique per collector and UTC business day.
-- ---------------------------------------------------------------------------
CREATE TABLE "DailyCollectorClosing" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "branchId" TEXT,
    "collectorId" TEXT NOT NULL,
    "closingDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expectedCash" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "contributionsRecorded" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "contributionsSynced" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "contributionsPending" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "pendingSyncCount" INTEGER NOT NULL DEFAULT 0,
    "failedSyncCount" INTEGER NOT NULL DEFAULT 0,
    "declaredCash" DECIMAL(65,30),
    "declaredAt" TIMESTAMP(3),
    "declaredById" TEXT,
    "declarationNote" TEXT,
    "declarationEvidenceRef" TEXT,
    "handoverAmount" DECIMAL(65,30),
    "handedOverAt" TIMESTAMP(3),
    "handedOverById" TEXT,
    "handoverEvidenceRef" TEXT,
    "receivedAmount" DECIMAL(65,30),
    "receivedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receiptNote" TEXT,
    "receiptEvidenceRef" TEXT,
    "varianceExpectedVsDeclared" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "varianceDeclaredVsReceived" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "varianceExpectedVsReceived" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "outstandingAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "exceptionCaseId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyCollectorClosing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyCollectorClosing_tenantId_collectorId_closingDate_key"
    ON "DailyCollectorClosing"("tenantId", "collectorId", "closingDate");
CREATE INDEX "DailyCollectorClosing_tenantId_branchId_closingDate_idx"
    ON "DailyCollectorClosing"("tenantId", "branchId", "closingDate");
CREATE INDEX "DailyCollectorClosing_tenantId_status_closingDate_idx"
    ON "DailyCollectorClosing"("tenantId", "status", "closingDate");
CREATE INDEX "DailyCollectorClosing_tenantId_collectorId_status_idx"
    ON "DailyCollectorClosing"("tenantId", "collectorId", "status");
CREATE INDEX "DailyCollectorClosing_tenantId_exceptionCaseId_idx"
    ON "DailyCollectorClosing"("tenantId", "exceptionCaseId");

ALTER TABLE "DailyCollectorClosing"
    ADD CONSTRAINT "DailyCollectorClosing_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyCollectorClosing"
    ADD CONSTRAINT "DailyCollectorClosing_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyCollectorClosing"
    ADD CONSTRAINT "DailyCollectorClosing_collectorId_fkey"
    FOREIGN KEY ("collectorId") REFERENCES "Collector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyCollectorClosing"
    ADD CONSTRAINT "DailyCollectorClosing_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "SusuReconciliation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyCollectorClosing"
    ADD CONSTRAINT "DailyCollectorClosing_exceptionCaseId_fkey"
    FOREIGN KEY ("exceptionCaseId") REFERENCES "ReconciliationExceptionCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ReconciliationLine: immutable observation, versioned by fingerprint.
-- ---------------------------------------------------------------------------
CREATE TABLE "ReconciliationLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "branchId" TEXT,
    "collectorId" TEXT,
    "sessionId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "expectedAmount" DECIMAL(65,30),
    "declaredAmount" DECIMAL(65,30),
    "physicalAmount" DECIMAL(65,30),
    "receivedAmount" DECIMAL(65,30),
    "verifiedAmount" DECIMAL(65,30),
    "variance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "severity" TEXT,
    "reason" TEXT,
    "metadataJson" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "exceptionCaseId" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReconciliationLine_sessionId_fingerprint_revision_key"
    ON "ReconciliationLine"("sessionId", "fingerprint", "revision");
CREATE INDEX "ReconciliationLine_tenantId_sessionId_status_idx"
    ON "ReconciliationLine"("tenantId", "sessionId", "status");
CREATE INDEX "ReconciliationLine_sessionId_entityType_entityId_idx"
    ON "ReconciliationLine"("sessionId", "entityType", "entityId");
CREATE INDEX "ReconciliationLine_tenantId_branchId_status_idx"
    ON "ReconciliationLine"("tenantId", "branchId", "status");
CREATE INDEX "ReconciliationLine_tenantId_collectorId_status_idx"
    ON "ReconciliationLine"("tenantId", "collectorId", "status");
CREATE INDEX "ReconciliationLine_tenantId_status_createdAt_idx"
    ON "ReconciliationLine"("tenantId", "status", "createdAt");

ALTER TABLE "ReconciliationLine"
    ADD CONSTRAINT "ReconciliationLine_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReconciliationLine"
    ADD CONSTRAINT "ReconciliationLine_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "SusuReconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReconciliationLine"
    ADD CONSTRAINT "ReconciliationLine_exceptionCaseId_fkey"
    FOREIGN KEY ("exceptionCaseId") REFERENCES "ReconciliationExceptionCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ReconciliationAdjustment: recorded, non-posting justification for a
-- correction performed by its own authorised workflow.
-- ---------------------------------------------------------------------------
CREATE TABLE "ReconciliationAdjustment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "sessionId" TEXT NOT NULL,
    "adjustmentType" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "declaredAmount" DECIMAL(65,30),
    "correctedAmount" DECIMAL(65,30),
    "variance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "reason" TEXT,
    "evidenceRef" TEXT,
    "caseId" TEXT,
    "proposedById" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedById" TEXT,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReconciliationAdjustment_tenantId_sessionId_status_idx"
    ON "ReconciliationAdjustment"("tenantId", "sessionId", "status");
CREATE INDEX "ReconciliationAdjustment_sessionId_referenceType_referenceI_idx"
    ON "ReconciliationAdjustment"("sessionId", "referenceType", "referenceId");
CREATE INDEX "ReconciliationAdjustment_tenantId_caseId_idx"
    ON "ReconciliationAdjustment"("tenantId", "caseId");

ALTER TABLE "ReconciliationAdjustment"
    ADD CONSTRAINT "ReconciliationAdjustment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReconciliationAdjustment"
    ADD CONSTRAINT "ReconciliationAdjustment_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "SusuReconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- OfflineSyncAttempt: optional session link. Original outcome, retryable flag
-- and payload digest are untouched.
-- ---------------------------------------------------------------------------
ALTER TABLE "OfflineSyncAttempt" ADD COLUMN "reconciliationId" TEXT;
CREATE INDEX "OfflineSyncAttempt_reconciliationId_createdAt_idx"
    ON "OfflineSyncAttempt"("reconciliationId", "createdAt");
ALTER TABLE "OfflineSyncAttempt"
    ADD CONSTRAINT "OfflineSyncAttempt_reconciliationId_fkey"
    FOREIGN KEY ("reconciliationId") REFERENCES "SusuReconciliation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ReconciliationExceptionCase: branch/collector ownership, amount at stake,
-- escalation, reopen and independent resolution approval.
-- ---------------------------------------------------------------------------
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "branchId" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "collectorId" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "sourceSessionId" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "amountAtStake" DECIMAL(65,30);
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "escalationLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "resolutionProposedById" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "resolutionProposedAt" TIMESTAMP(3);
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "proposedResolutionType" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "proposedResolutionNote" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "proposedEvidenceRef" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "resolutionApprovedById" TEXT;
ALTER TABLE "ReconciliationExceptionCase" ADD COLUMN "resolutionApprovedAt" TIMESTAMP(3);

CREATE INDEX "ReconciliationExceptionCase_tenantId_branchId_status_idx"
    ON "ReconciliationExceptionCase"("tenantId", "branchId", "status");
CREATE INDEX "ReconciliationExceptionCase_tenantId_collectorId_status_idx"
    ON "ReconciliationExceptionCase"("tenantId", "collectorId", "status");
CREATE INDEX "ReconciliationExceptionCase_tenantId_dueAt_status_idx"
    ON "ReconciliationExceptionCase"("tenantId", "dueAt", "status");
CREATE INDEX "ReconciliationExceptionCase_tenantId_sourceSessionId_idx"
    ON "ReconciliationExceptionCase"("tenantId", "sourceSessionId");

ALTER TABLE "ReconciliationExceptionCase"
    ADD CONSTRAINT "ReconciliationExceptionCase_collectorId_fkey"
    FOREIGN KEY ("collectorId") REFERENCES "Collector"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReconciliationExceptionCase"
    ADD CONSTRAINT "ReconciliationExceptionCase_sourceSessionId_fkey"
    FOREIGN KEY ("sourceSessionId") REFERENCES "SusuReconciliation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ReconciliationExceptionEvent: explicit previous/new state, reason and
-- evidence reference on every material case action.
-- ---------------------------------------------------------------------------
ALTER TABLE "ReconciliationExceptionEvent" ADD COLUMN "fromStatus" TEXT;
ALTER TABLE "ReconciliationExceptionEvent" ADD COLUMN "toStatus" TEXT;
ALTER TABLE "ReconciliationExceptionEvent" ADD COLUMN "reason" TEXT;
ALTER TABLE "ReconciliationExceptionEvent" ADD COLUMN "evidenceRef" TEXT;
