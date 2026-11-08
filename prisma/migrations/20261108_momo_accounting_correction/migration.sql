-- MoMo accounting correction.
--
-- Additive only: historical rows keep every original column and value. The new
-- columns carry the corrected combined-accountability model. Existing
-- calculatedMomoVariance / calculatedCashVariance columns stay in place so old
-- submitted records remain readable and are never rewritten.

ALTER TABLE "DailyAccount" ADD COLUMN "additionalCashReceived" DECIMAL(65,30) NOT NULL DEFAULT 0;
ALTER TABLE "DailyAccount" ADD COLUMN "additionalMomoFloat" DECIMAL(65,30) NOT NULL DEFAULT 0;
ALTER TABLE "DailyAccount" ADD COLUMN "totalAirtimeSold" DECIMAL(65,30) NOT NULL DEFAULT 0;
ALTER TABLE "DailyAccount" ADD COLUMN "calculatedDifference" DECIMAL(65,30) NOT NULL DEFAULT 0;
ALTER TABLE "DailyAccount" ADD COLUMN "differenceStatus" TEXT NOT NULL DEFAULT 'balanced';
