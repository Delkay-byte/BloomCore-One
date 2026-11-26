-- Evidence references for the dispatch and receipt steps of a branch transfer.
-- Additive. Existing transfers keep NULL, which reads as "no evidence recorded";
-- no historical transition is rewritten.

ALTER TABLE "BranchTransfer" ADD COLUMN "dispatchEvidence" TEXT;
ALTER TABLE "BranchTransfer" ADD COLUMN "receiptEvidence" TEXT;
