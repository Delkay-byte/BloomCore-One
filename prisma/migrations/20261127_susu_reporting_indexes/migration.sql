-- Susu reporting: additive composite indexes for report queries.
-- No financial record is changed, rewritten or deleted.
-- Compatible with SQLite and PostgreSQL.

CREATE INDEX IF NOT EXISTS "Contribution_tenantId_branchId_collectionDate_idx" ON "Contribution"("tenantId", "branchId", "collectionDate");
CREATE INDEX IF NOT EXISTS "Withdrawal_tenantId_branchId_createdAt_idx" ON "Withdrawal"("tenantId", "branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "CollectorRemittance_tenantId_branchId_createdAt_idx" ON "CollectorRemittance"("tenantId", "branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "CollectorRemittance_tenantId_collectorId_status_idx" ON "CollectorRemittance"("tenantId", "collectorId", "status");
