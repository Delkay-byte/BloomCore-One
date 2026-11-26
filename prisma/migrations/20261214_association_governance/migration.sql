-- AlterTable
ALTER TABLE "AssociationMember" ADD COLUMN     "associationId" TEXT,
ADD COLUMN     "zoneId" TEXT;

-- CreateTable
CREATE TABLE "Association" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "charterVersion" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Association_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssociationZone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "associationId" TEXT NOT NULL,
    "parentZoneId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssociationZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssociationRoleAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "associationId" TEXT NOT NULL,
    "zoneId" TEXT,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "AssociationRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssociationConsentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "associationId" TEXT NOT NULL,
    "memberId" TEXT,
    "subjectType" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "documentRef" TEXT,
    "note" TEXT,

    CONSTRAINT "AssociationConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Association_tenantId_status_idx" ON "Association"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Association_tenantId_code_key" ON "Association"("tenantId", "code");

-- CreateIndex
CREATE INDEX "AssociationZone_associationId_parentZoneId_idx" ON "AssociationZone"("associationId", "parentZoneId");

-- CreateIndex
CREATE UNIQUE INDEX "AssociationZone_associationId_code_key" ON "AssociationZone"("associationId", "code");

-- CreateIndex
CREATE INDEX "AssociationRoleAssignment_tenantId_role_idx" ON "AssociationRoleAssignment"("tenantId", "role");

-- CreateIndex
CREATE INDEX "AssociationRoleAssignment_userId_revokedAt_idx" ON "AssociationRoleAssignment"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssociationRoleAssignment_associationId_userId_role_key" ON "AssociationRoleAssignment"("associationId", "userId", "role");

-- CreateIndex
CREATE INDEX "AssociationConsentRecord_tenantId_associationId_subjectType_idx" ON "AssociationConsentRecord"("tenantId", "associationId", "subjectType");

-- CreateIndex
CREATE INDEX "AssociationConsentRecord_expiresAt_idx" ON "AssociationConsentRecord"("expiresAt");

-- AddForeignKey
ALTER TABLE "AssociationMember" ADD CONSTRAINT "AssociationMember_associationId_fkey" FOREIGN KEY ("associationId") REFERENCES "Association"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationMember" ADD CONSTRAINT "AssociationMember_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "AssociationZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Association" ADD CONSTRAINT "Association_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationZone" ADD CONSTRAINT "AssociationZone_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationZone" ADD CONSTRAINT "AssociationZone_associationId_fkey" FOREIGN KEY ("associationId") REFERENCES "Association"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationZone" ADD CONSTRAINT "AssociationZone_parentZoneId_fkey" FOREIGN KEY ("parentZoneId") REFERENCES "AssociationZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationRoleAssignment" ADD CONSTRAINT "AssociationRoleAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationRoleAssignment" ADD CONSTRAINT "AssociationRoleAssignment_associationId_fkey" FOREIGN KEY ("associationId") REFERENCES "Association"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationRoleAssignment" ADD CONSTRAINT "AssociationRoleAssignment_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "AssociationZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationConsentRecord" ADD CONSTRAINT "AssociationConsentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationConsentRecord" ADD CONSTRAINT "AssociationConsentRecord_associationId_fkey" FOREIGN KEY ("associationId") REFERENCES "Association"("id") ON DELETE CASCADE ON UPDATE CASCADE;

