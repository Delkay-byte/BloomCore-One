-- Dispute context and evidence references.
-- Additive. Existing disputes keep NULL for cycle and evidence, which reads as
-- "not recorded"; no historical decision or status is rewritten.

ALTER TABLE "CustomerDispute" ADD COLUMN "cycleNumber" INTEGER;
ALTER TABLE "CustomerDispute" ADD COLUMN "customerEvidence" TEXT;
ALTER TABLE "CustomerDispute" ADD COLUMN "resolutionEvidence" TEXT;
