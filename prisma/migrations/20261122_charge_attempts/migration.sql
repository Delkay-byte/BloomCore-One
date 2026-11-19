-- Additive: durable, one-per-reference payment charge attempts.
--
-- The unique reference is the concurrency guard that allows at most one
-- in-flight provider charge per payment reference. No existing table or column
-- is altered, and no data is rewritten.

CREATE TABLE "ZeliChargeAttempt" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paystack',
    "method" TEXT NOT NULL,
    "network" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'initiating',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "providerHttpStatus" INTEGER,
    "providerCode" TEXT,
    "reason" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ZeliChargeAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZeliChargeAttempt_reference_key" ON "ZeliChargeAttempt"("reference");
CREATE INDEX "ZeliChargeAttempt_tenantId_state_idx" ON "ZeliChargeAttempt"("tenantId", "state");
CREATE INDEX "ZeliChargeAttempt_subscriptionId_idx" ON "ZeliChargeAttempt"("subscriptionId");
CREATE INDEX "ZeliChargeAttempt_state_updatedAt_idx" ON "ZeliChargeAttempt"("state", "updatedAt");
