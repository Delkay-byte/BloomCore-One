-- ============================================================================
-- Auditable financial reversals
--
-- ADDITIVE ONLY. Original posted rows are preserved. A reversal is written as
-- a compensating row that points at the original and can never be duplicated.
-- ============================================================================

ALTER TABLE "Contribution" ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3);
ALTER TABLE "Contribution" ADD COLUMN IF NOT EXISTS "reversalOfId" TEXT;

ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3);
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "reversalOfId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Contribution_reversalOfId_key"
    ON "Contribution"("reversalOfId");
CREATE UNIQUE INDEX IF NOT EXISTS "Withdrawal_reversalOfId_key"
    ON "Withdrawal"("reversalOfId");
