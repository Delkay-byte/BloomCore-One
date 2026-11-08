-- Simplified MoMo daily closing.
--
-- Additive and backward compatible. Existing rows keep every legacy column and
-- value. The new closing form records only opening/closing physical cash and
-- E-cash, expenses, commission and debts collected.
--
-- Historical records are NOT recalculated. Their stored calculatedDifference
-- and differenceStatus remain the source of truth for historical periods.

ALTER TABLE "DailyAccount" ADD COLUMN "debtsCollected" DECIMAL(65,30) NOT NULL DEFAULT 0;
