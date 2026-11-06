-- Zeli renewal, checkout-race and duplicate-payment remediation.
--
-- Additive only: no column is dropped, no row is deleted and no existing value
-- is rewritten. The application keeps working while the previous version is
-- still serving traffic.
--
-- pendingKey is set only while a checkout is pending. The unique index is the
-- database-level guard that prevents two concurrent pending checkouts for the
-- same tenant and plan, even if the application check races.
--
-- periodGranted records whether a subscription actually extended an
-- entitlement period, so a refund for a duplicate settlement does not suspend
-- paid access that a different payment granted.

ALTER TABLE "ZeliSubscription" ADD COLUMN "pendingKey" TEXT;
ALTER TABLE "ZeliSubscription" ADD COLUMN "periodGranted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ZeliSubscription" ADD COLUMN "refundStatus" TEXT;
ALTER TABLE "ZeliSubscription" ADD COLUMN "refundReference" TEXT;
ALTER TABLE "ZeliSubscription" ADD COLUMN "refundFailureReason" TEXT;
ALTER TABLE "ZeliSubscription" ADD COLUMN "supersededByReference" TEXT;

CREATE UNIQUE INDEX "ZeliSubscription_pendingKey_key" ON "ZeliSubscription"("pendingKey");
CREATE UNIQUE INDEX "ZeliSubscription_refundReference_key" ON "ZeliSubscription"("refundReference");
CREATE INDEX "ZeliSubscription_refundStatus_idx" ON "ZeliSubscription"("refundStatus");

CREATE TABLE "ZeliPaymentException" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "tenantId" TEXT,
    "subscriptionId" TEXT,
    "reference" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "amount" DECIMAL(65,30),
    "currency" TEXT,
    "detail" TEXT NOT NULL,
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZeliPaymentException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZeliPaymentException_dedupeKey_key" ON "ZeliPaymentException"("dedupeKey");
CREATE INDEX "ZeliPaymentException_status_createdAt_idx" ON "ZeliPaymentException"("status", "createdAt");
CREATE INDEX "ZeliPaymentException_tenantId_createdAt_idx" ON "ZeliPaymentException"("tenantId", "createdAt");
CREATE INDEX "ZeliPaymentException_reference_idx" ON "ZeliPaymentException"("reference");
