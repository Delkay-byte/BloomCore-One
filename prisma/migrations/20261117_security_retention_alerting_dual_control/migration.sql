-- Residual risk C, D and E remediation.
--
-- Additive only. No existing financial, audit, session or user row is modified
-- or deleted. Financial audit history (AuditLog / PlatformAuditLog) is
-- deliberately NOT touched by security-event retention.

-- ---------------------------------------------------------------------------
-- Residual C: persisted security events (365-day retention, cleaned by the
-- scheduled maintenance sweep, never by an application request path)
-- ---------------------------------------------------------------------------
CREATE TABLE "SecurityEventRecord" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "actorType" TEXT,
    "actorId" TEXT,
    "tenantId" TEXT,
    "ipHash" TEXT,
    "route" TEXT,
    "reason" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEventRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityEventRecord_createdAt_idx" ON "SecurityEventRecord"("createdAt");
CREATE INDEX "SecurityEventRecord_severity_createdAt_idx" ON "SecurityEventRecord"("severity", "createdAt");
CREATE INDEX "SecurityEventRecord_tenantId_createdAt_idx" ON "SecurityEventRecord"("tenantId", "createdAt");
CREATE INDEX "SecurityEventRecord_event_createdAt_idx" ON "SecurityEventRecord"("event", "createdAt");

-- ---------------------------------------------------------------------------
-- Residual C: durable in-app security alerts (critical alerts also emailed)
-- ---------------------------------------------------------------------------
CREATE TABLE "SecurityAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "audience" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "severity" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "emailStatus" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SecurityAlert_dedupeKey_key" ON "SecurityAlert"("dedupeKey");
CREATE INDEX "SecurityAlert_audience_createdAt_idx" ON "SecurityAlert"("audience", "createdAt");
CREATE INDEX "SecurityAlert_tenantId_createdAt_idx" ON "SecurityAlert"("tenantId", "createdAt");
CREATE INDEX "SecurityAlert_severity_createdAt_idx" ON "SecurityAlert"("severity", "createdAt");

-- ---------------------------------------------------------------------------
-- Residual D: second-person approval for high-impact platform operations
-- ---------------------------------------------------------------------------
CREATE TABLE "PlatformApprovalRequest" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformApprovalRequest_status_createdAt_idx" ON "PlatformApprovalRequest"("status", "createdAt");
CREATE INDEX "PlatformApprovalRequest_targetType_targetId_idx" ON "PlatformApprovalRequest"("targetType", "targetId");

-- ---------------------------------------------------------------------------
-- Residual E: maker-checker for sensitive financial operations
-- ---------------------------------------------------------------------------
CREATE TABLE "FinancialApproval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "amountMinor" INTEGER,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "exceptionUsed" BOOLEAN NOT NULL DEFAULT false,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinancialApproval_tenantId_status_createdAt_idx" ON "FinancialApproval"("tenantId", "status", "createdAt");
CREATE INDEX "FinancialApproval_action_targetId_idx" ON "FinancialApproval"("action", "targetId");
