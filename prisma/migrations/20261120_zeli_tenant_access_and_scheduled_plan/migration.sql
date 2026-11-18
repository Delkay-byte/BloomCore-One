-- Additive only: no column is dropped, renamed or retyped, and no existing row
-- is deleted. The new table is empty until a Platform Super Admin disables
-- Zeli for a specific business; its absence means "enabled".

ALTER TABLE "ZeliSubscription" ADD COLUMN "scheduledPlanCode" TEXT;
ALTER TABLE "ZeliSubscription" ADD COLUMN "scheduledBillingTerm" TEXT;
ALTER TABLE "ZeliSubscription" ADD COLUMN "scheduledAt" TIMESTAMP(3);

CREATE TABLE "ZeliTenantAccess" (
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZeliTenantAccess_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE "ZeliTenantAccess"
    ADD CONSTRAINT "ZeliTenantAccess_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
