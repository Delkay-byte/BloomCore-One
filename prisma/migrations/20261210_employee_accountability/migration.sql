-- CreateTable
CREATE TABLE "TenantOperationalPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftsRequired" BOOLEAN NOT NULL DEFAULT false,
    "actorProofForSensitiveCounts" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantOperationalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "shiftId" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL,
    "afterJson" TEXT NOT NULL,
    "fields" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantOperationalPolicy_tenantId_key" ON "TenantOperationalPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "ShiftRevision_tenantId_shiftId_idx" ON "ShiftRevision"("tenantId", "shiftId");

-- CreateIndex
CREATE INDEX "ShiftRevision_shiftId_createdAt_idx" ON "ShiftRevision"("shiftId", "createdAt");

-- AddForeignKey
ALTER TABLE "TenantOperationalPolicy" ADD CONSTRAINT "TenantOperationalPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftRevision" ADD CONSTRAINT "ShiftRevision_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftRevision" ADD CONSTRAINT "ShiftRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

