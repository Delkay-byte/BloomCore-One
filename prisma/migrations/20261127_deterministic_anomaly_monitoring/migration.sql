-- Deterministic anomaly findings.
--
-- Additive. Findings are derived from existing operational rows and carry the
-- rule, measured value, threshold and evidence. Re-running a scan upserts by
-- (tenantId, fingerprint) rather than duplicating the same finding.

CREATE TABLE "OperationalAnomaly" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "locationId" TEXT,
    "workerId" TEXT,
    "businessDate" TIMESTAMP(3),
    "metricValue" DECIMAL(65,30),
    "thresholdValue" DECIMAL(65,30),
    "evidence" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalAnomaly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationalAnomaly_tenantId_fingerprint_key" ON "OperationalAnomaly"("tenantId", "fingerprint");
CREATE INDEX "OperationalAnomaly_tenantId_status_severity_idx" ON "OperationalAnomaly"("tenantId", "status", "severity");
CREATE INDEX "OperationalAnomaly_tenantId_ruleKey_idx" ON "OperationalAnomaly"("tenantId", "ruleKey");
CREATE INDEX "OperationalAnomaly_tenantId_businessDate_idx" ON "OperationalAnomaly"("tenantId", "businessDate");
CREATE INDEX "OperationalAnomaly_locationId_idx" ON "OperationalAnomaly"("locationId");
CREATE INDEX "OperationalAnomaly_workerId_idx" ON "OperationalAnomaly"("workerId");

ALTER TABLE "OperationalAnomaly" ADD CONSTRAINT "OperationalAnomaly_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
