-- Phase 2: Collector Management and Field Operations
--
-- Additive only. No existing table, column, index or record is dropped,
-- renamed, truncated or rewritten. Existing collectors with NULL lifecycle
-- metadata keep working unchanged.

-- ---------------------------------------------------------------------------
-- Collector lifecycle metadata (status, reason, actor, timestamp)
-- ---------------------------------------------------------------------------
ALTER TABLE "Collector" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "Collector" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "Collector" ADD COLUMN "statusChangedById" TEXT;

CREATE INDEX "Collector_tenantId_status_idx" ON "Collector"("tenantId", "status");

-- ---------------------------------------------------------------------------
-- Customer assignment integrity: activeAccountKey unique per active account,
-- plus who made each assignment/transfer.
-- ---------------------------------------------------------------------------
ALTER TABLE "CollectorCustomerAssignment" ADD COLUMN "activeAccountKey" TEXT UNIQUE;
ALTER TABLE "CollectorCustomerAssignment" ADD COLUMN "assignedById" TEXT;

CREATE INDEX "CollectorCustomerAssignment_tenantId_active_idx" ON "CollectorCustomerAssignment"("tenantId", "active");

-- ---------------------------------------------------------------------------
-- Append-only assignment history (assigned | reactivated | transferred | unassigned)
-- ---------------------------------------------------------------------------
CREATE TABLE "CollectorAssignmentEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "assignmentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "collectorId" TEXT,
    "previousCollectorId" TEXT,
    "newCollectorId" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CollectorAssignmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CollectorAssignmentEvent_tenantId_accountId_createdAt_idx"
    ON "CollectorAssignmentEvent"("tenantId", "accountId", "createdAt");
CREATE INDEX "CollectorAssignmentEvent_assignmentId_createdAt_idx"
    ON "CollectorAssignmentEvent"("assignmentId", "createdAt");
CREATE INDEX "CollectorAssignmentEvent_collectorId_createdAt_idx"
    ON "CollectorAssignmentEvent"("collectorId", "createdAt");
CREATE INDEX "CollectorAssignmentEvent_actorId_createdAt_idx"
    ON "CollectorAssignmentEvent"("actorId", "createdAt");

-- ---------------------------------------------------------------------------
-- Offline capture timestamp: original device capture time stamped on the
-- contribution (evidence only — collectionDate remains the server posting time).
-- ---------------------------------------------------------------------------
ALTER TABLE "Contribution" ADD COLUMN "capturedAt" TIMESTAMP(3);
ALTER TABLE "Contribution" ALTER COLUMN "localTimestamp" SET DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "Contribution_capturedAt_idx" ON "Contribution"("capturedAt");

-- ---------------------------------------------------------------------------
-- Offline sync attempt trace: rejected/failed syncs visible to authorized
-- admins. Safe context only — no payload, no authentication material.
-- ---------------------------------------------------------------------------
CREATE TABLE "OfflineSyncAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'contribution',
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reason" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT true,
    "httpStatus" INTEGER,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "idempotencyKey" TEXT,
    "accountId" TEXT,
    "collectorId" TEXT,
    "amount" DECIMAL(65,30),
    "capturedAt" TIMESTAMP(3),
    "payloadDigest" TEXT,
    "retriedAt" TIMESTAMP(3),
    "retriedById" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OfflineSyncAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OfflineSyncAttempt_tenantId_createdAt_idx" ON "OfflineSyncAttempt"("tenantId", "createdAt");
CREATE INDEX "OfflineSyncAttempt_tenantId_outcome_createdAt_idx" ON "OfflineSyncAttempt"("tenantId", "outcome", "createdAt");
CREATE INDEX "OfflineSyncAttempt_tenantId_retryable_createdAt_idx" ON "OfflineSyncAttempt"("tenantId", "retryable", "createdAt");
CREATE INDEX "OfflineSyncAttempt_idempotencyKey_idx" ON "OfflineSyncAttempt"("idempotencyKey");
CREATE INDEX "OfflineSyncAttempt_userId_createdAt_idx" ON "OfflineSyncAttempt"("userId", "createdAt");

-- ---------------------------------------------------------------------------
-- BusinessTenant relation surfaces for the new tables (no data change)
-- ---------------------------------------------------------------------------
