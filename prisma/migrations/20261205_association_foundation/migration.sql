-- Tenant-scoped association foundation: membership, sponsorship records and
-- training records. Additive. Sponsorships are records only and never move money.

CREATE TABLE "AssociationMember" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "memberCode" TEXT NOT NULL,
  "businessName" TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "region" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "joinedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssociationMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AssociationMember_tenantId_memberCode_key" ON "AssociationMember"("tenantId", "memberCode");
CREATE UNIQUE INDEX "AssociationMember_tenantId_phone_key" ON "AssociationMember"("tenantId", "phone");
CREATE INDEX "AssociationMember_tenantId_status_idx" ON "AssociationMember"("tenantId", "status");
CREATE INDEX "AssociationMember_tenantId_businessName_idx" ON "AssociationMember"("tenantId", "businessName");

CREATE TABLE "AssociationSponsorship" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "memberId" TEXT NOT NULL,
  "sponsorName" TEXT NOT NULL,
  "planCode" TEXT,
  "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'GHS',
  "status" TEXT NOT NULL DEFAULT 'pledged',
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "reference" TEXT,
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssociationSponsorship_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AssociationSponsorship_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AssociationMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AssociationSponsorship_tenantId_reference_key" ON "AssociationSponsorship"("tenantId", "reference");
CREATE INDEX "AssociationSponsorship_tenantId_status_idx" ON "AssociationSponsorship"("tenantId", "status");
CREATE INDEX "AssociationSponsorship_memberId_createdAt_idx" ON "AssociationSponsorship"("memberId", "createdAt");

CREATE TABLE "AssociationTrainingRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT,
  "memberId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "provider" TEXT,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "certificateReference" TEXT,
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssociationTrainingRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AssociationTrainingRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AssociationMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AssociationTrainingRecord_tenantId_status_idx" ON "AssociationTrainingRecord"("tenantId", "status");
CREATE INDEX "AssociationTrainingRecord_memberId_completedAt_idx" ON "AssociationTrainingRecord"("memberId", "completedAt");
