-- Additive: remember which customer input a pending charge is waiting for, and
-- add a durable, one-row-per-event outbox for internal platform email.
--
-- No existing column is altered or rewritten. The new column is nullable, so
-- every existing charge attempt stays valid and is treated as "no required
-- action" by the application. The outbox never stores an OTP, PIN, full wallet
-- number or provider payload.

ALTER TABLE "ZeliChargeAttempt" ADD COLUMN "requiredAction" TEXT;
ALTER TABLE "ZeliChargeAttempt" ADD COLUMN "checkoutUrl" TEXT;

CREATE TABLE "PlatformEmailOutbox" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'payment_received',
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformEmailOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformEmailOutbox_eventKey_key" ON "PlatformEmailOutbox"("eventKey");
CREATE INDEX "PlatformEmailOutbox_status_updatedAt_idx" ON "PlatformEmailOutbox"("status", "updatedAt");
