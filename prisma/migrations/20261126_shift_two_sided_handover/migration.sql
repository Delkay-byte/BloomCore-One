-- Employee shifts and two-sided handover.
--
-- Additive. Shifts are accountability snapshots and never feed the daily
-- account reconciliation, so introducing them cannot double count money.
-- The outgoing figures on a handover are immutable once submitted; the
-- receiving employee records their own figures and any difference is preserved
-- as an open variance.

CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "locationId" TEXT NOT NULL,
    "dailyAccountId" TEXT,
    "reference" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "assignedUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "openingCash" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "openingMomoFloat" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "openingSource" TEXT NOT NULL DEFAULT 'manual',
    "carriedFromShiftId" TEXT,
    "openingAdjustmentReason" TEXT,
    "closingCash" DECIMAL(65,30),
    "closingMomoFloat" DECIMAL(65,30),
    "closingNotes" TEXT,
    "openedById" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Shift_tenantId_locationId_businessDate_name_key" ON "Shift"("tenantId", "locationId", "businessDate", "name");
CREATE UNIQUE INDEX "Shift_tenantId_reference_key" ON "Shift"("tenantId", "reference");
CREATE INDEX "Shift_tenantId_businessDate_idx" ON "Shift"("tenantId", "businessDate");
CREATE INDEX "Shift_locationId_businessDate_idx" ON "Shift"("locationId", "businessDate");
CREATE INDEX "Shift_assignedUserId_businessDate_idx" ON "Shift"("assignedUserId", "businessDate");
CREATE INDEX "Shift_status_idx" ON "Shift"("status");

CREATE TABLE "ShiftHandover" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "shiftId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "outgoingUserId" TEXT NOT NULL,
    "outgoingCash" DECIMAL(65,30) NOT NULL,
    "outgoingMomoFloat" DECIMAL(65,30) NOT NULL,
    "outstandingOperations" TEXT,
    "outgoingNotes" TEXT,
    "incomingUserId" TEXT,
    "incomingCash" DECIMAL(65,30),
    "incomingMomoFloat" DECIMAL(65,30),
    "operationsAccepted" BOOLEAN,
    "incomingNotes" TEXT,
    "cashVariance" DECIMAL(65,30),
    "floatVariance" DECIMAL(65,30),
    "varianceReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'awaiting_receipt',
    "confirmedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftHandover_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShiftHandover_tenantId_reference_key" ON "ShiftHandover"("tenantId", "reference");
CREATE INDEX "ShiftHandover_shiftId_createdAt_idx" ON "ShiftHandover"("shiftId", "createdAt");
CREATE INDEX "ShiftHandover_tenantId_status_idx" ON "ShiftHandover"("tenantId", "status");
CREATE INDEX "ShiftHandover_outgoingUserId_idx" ON "ShiftHandover"("outgoingUserId");
CREATE INDEX "ShiftHandover_incomingUserId_idx" ON "ShiftHandover"("incomingUserId");

ALTER TABLE "Shift" ADD CONSTRAINT "Shift_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_dailyAccountId_fkey" FOREIGN KEY ("dailyAccountId") REFERENCES "DailyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
