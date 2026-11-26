-- Cross-process execution lease for singleton jobs (F5).
-- Additive only: creates one new table and its index. No existing table,
-- column, index or record is dropped, renamed, truncated or rewritten.

-- CreateTable
CREATE TABLE "SystemJobLease" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "acquiredAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SystemJobLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SystemJobLease_key_key" ON "SystemJobLease"("key");

-- CreateIndex
CREATE INDEX "SystemJobLease_status_expiresAt_idx" ON "SystemJobLease"("status", "expiresAt");
