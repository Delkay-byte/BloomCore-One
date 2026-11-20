-- AlterTable
ALTER TABLE "AssociationSponsorship" ADD COLUMN     "fundedCapPesewa" INTEGER,
ADD COLUMN     "sponsorId" TEXT,
ADD COLUMN     "subjectTenantId" TEXT;

-- CreateTable
CREATE TABLE "Sponsor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "subjectTenantId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'business',
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "taxId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "annualCapPesewa" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorshipFunding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "sponsorshipId" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'allocation',
    "amountPesewa" INTEGER NOT NULL,
    "fundedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorshipFunding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorshipCoverage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "sponsorshipId" TEXT NOT NULL,
    "subjectTenantId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountPesewa" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorshipCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sponsor_tenantId_status_idx" ON "Sponsor"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Sponsor_tenantId_name_key" ON "Sponsor"("tenantId", "name");

-- CreateIndex
CREATE INDEX "SponsorshipFunding_sponsorshipId_fundedAt_idx" ON "SponsorshipFunding"("sponsorshipId", "fundedAt");

-- CreateIndex
CREATE INDEX "SponsorshipFunding_sponsorId_fundedAt_idx" ON "SponsorshipFunding"("sponsorId", "fundedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipFunding_tenantId_reference_key" ON "SponsorshipFunding"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "SponsorshipCoverage_tenantId_sponsorshipId_periodEnd_idx" ON "SponsorshipCoverage"("tenantId", "sponsorshipId", "periodEnd");

-- CreateIndex
CREATE INDEX "SponsorshipCoverage_subjectTenantId_periodEnd_idx" ON "SponsorshipCoverage"("subjectTenantId", "periodEnd");

-- CreateIndex
CREATE INDEX "AssociationSponsorship_sponsorId_idx" ON "AssociationSponsorship"("sponsorId");

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipFunding" ADD CONSTRAINT "SponsorshipFunding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipFunding" ADD CONSTRAINT "SponsorshipFunding_sponsorshipId_fkey" FOREIGN KEY ("sponsorshipId") REFERENCES "AssociationSponsorship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipFunding" ADD CONSTRAINT "SponsorshipFunding_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipCoverage" ADD CONSTRAINT "SponsorshipCoverage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipCoverage" ADD CONSTRAINT "SponsorshipCoverage_sponsorshipId_fkey" FOREIGN KEY ("sponsorshipId") REFERENCES "AssociationSponsorship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociationSponsorship" ADD CONSTRAINT "AssociationSponsorship_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

