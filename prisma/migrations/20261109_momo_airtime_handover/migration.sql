-- Airtime Sold operational record and physical handover confirmation.
--
-- Additive and backward compatible. `totalAirtimeSold` already exists and is
-- retained for historical rows. Airtime sales move money between physical cash
-- and E-cash, so they never enter the combined accountability formula.
--
-- Handover confirmation is deliberately separate from accounting review: a
-- reviewed account does not prove that money was physically received.

ALTER TABLE "DailyAccount" ADD COLUMN "actualAmountReceived" DECIMAL(65,30);
ALTER TABLE "DailyAccount" ADD COLUMN "handoverDifference" DECIMAL(65,30);
ALTER TABLE "DailyAccount" ADD COLUMN "handoverNote" TEXT;
ALTER TABLE "DailyAccount" ADD COLUMN "handoverConfirmedAt" TIMESTAMP(3);
ALTER TABLE "DailyAccount" ADD COLUMN "handoverConfirmedBy" TEXT;
