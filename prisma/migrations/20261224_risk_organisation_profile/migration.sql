-- Shared Agent Risk Intelligence - owner-confirmed legal and hosting facts.
-- Additive migration. No existing record or column is modified.

CREATE TABLE "RiskOrganisationProfile" (
    "id" TEXT NOT NULL DEFAULT 'bloomcore',
    "registeredOffice" TEXT,
    "registeredOfficeConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "privacyEmail" TEXT,
    "signatoryName" TEXT,
    "signatoryCapacity" TEXT,
    "hostingProviders" TEXT,
    "hostingRegions" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiskOrganisationProfile_pkey" PRIMARY KEY ("id")
);