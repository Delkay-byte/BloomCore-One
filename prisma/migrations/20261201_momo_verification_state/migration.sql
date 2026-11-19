-- Ledger verification state and evidence attribution.
--
-- Additive. Every existing row is operator-recorded because no provider or
-- statement integration created it. A manual operator can never mark a row as
-- provider-confirmed; only a future verified integration may do that.

ALTER TABLE "MomoTransaction" ADD COLUMN "verificationStatus" TEXT NOT NULL DEFAULT 'operator_recorded';
ALTER TABLE "MomoTransaction" ADD COLUMN "recordedDeviceId" TEXT;
ALTER TABLE "MomoTransaction" ADD COLUMN "recordedDeviceName" TEXT;
ALTER TABLE "MomoTransaction" ADD COLUMN "supportingEvidence" TEXT;

CREATE INDEX "MomoTransaction_tenantId_verificationStatus_idx" ON "MomoTransaction"("tenantId", "verificationStatus");
