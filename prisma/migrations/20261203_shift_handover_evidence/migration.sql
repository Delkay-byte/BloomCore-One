-- Evidence references for both sides of a shift handover.
-- Additive. Existing handovers keep NULL, read as "no evidence recorded".

ALTER TABLE "ShiftHandover" ADD COLUMN "outgoingEvidence" TEXT;
ALTER TABLE "ShiftHandover" ADD COLUMN "incomingEvidence" TEXT;
