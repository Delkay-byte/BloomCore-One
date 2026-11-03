-- Zeli Business Intelligence: entitlement, refresh aggregates and privacy
-- gateway decision log. Financial values are derived from existing records;
-- no second ledger is introduced.

CREATE TABLE "ZeliEntitlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL DEFAULT 'zeli_analytics',
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "reason" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "grantedById" TEXT,
    "grantedByType" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZeliEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZeliEntitlement_tenantId_featureKey_key" ON "ZeliEntitlement"("tenantId", "featureKey");
CREATE INDEX "ZeliEntitlement_tenantId_idx" ON "ZeliEntitlement"("tenantId");
CREATE INDEX "ZeliEntitlement_status_idx" ON "ZeliEntitlement"("status");
CREATE INDEX "ZeliEntitlement_expiresAt_idx" ON "ZeliEntitlement"("expiresAt");

CREATE TABLE "ZeliEntitlementEvent" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT,
    "tenantId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL DEFAULT 'zeli_analytics',
    "action" TEXT NOT NULL,
    "previousStatus" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZeliEntitlementEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ZeliEntitlementEvent_tenantId_createdAt_idx" ON "ZeliEntitlementEvent"("tenantId", "createdAt");
CREATE INDEX "ZeliEntitlementEvent_entitlementId_createdAt_idx" ON "ZeliEntitlementEvent"("entitlementId", "createdAt");

CREATE TABLE "ZeliAnalyticsDaily" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "contributions" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "contributionCount" INTEGER NOT NULL DEFAULT 0,
    "withdrawals" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "withdrawalCount" INTEGER NOT NULL DEFAULT 0,
    "commissions" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "remittances" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "remittanceVariance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "remittanceCount" INTEGER NOT NULL DEFAULT 0,
    "expenses" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "expenseCount" INTEGER NOT NULL DEFAULT 0,
    "cashIncome" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "activeCustomers" INTEGER NOT NULL DEFAULT 0,
    "newCustomers" INTEGER NOT NULL DEFAULT 0,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZeliAnalyticsDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZeliAnalyticsDaily_tenantId_scope_businessDate_key" ON "ZeliAnalyticsDaily"("tenantId", "scope", "businessDate");
CREATE INDEX "ZeliAnalyticsDaily_tenantId_businessDate_idx" ON "ZeliAnalyticsDaily"("tenantId", "businessDate");
CREATE INDEX "ZeliAnalyticsDaily_tenantId_scope_businessDate_idx" ON "ZeliAnalyticsDaily"("tenantId", "scope", "businessDate");

CREATE TABLE "ZeliAnalyticsRefresh" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "rangeStart" TEXT NOT NULL,
    "rangeEnd" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZeliAnalyticsRefresh_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZeliAnalyticsRefresh_tenantId_scope_rangeStart_rangeEnd_key" ON "ZeliAnalyticsRefresh"("tenantId", "scope", "rangeStart", "rangeEnd");
CREATE INDEX "ZeliAnalyticsRefresh_tenantId_refreshedAt_idx" ON "ZeliAnalyticsRefresh"("tenantId", "refreshedAt");

CREATE TABLE "ZeliProviderGatewayEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "provider" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "payloadCategories" TEXT,
    "observationCount" INTEGER,
    "suppressedGroupCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZeliProviderGatewayEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ZeliProviderGatewayEvent_createdAt_idx" ON "ZeliProviderGatewayEvent"("createdAt");
CREATE INDEX "ZeliProviderGatewayEvent_tenantId_createdAt_idx" ON "ZeliProviderGatewayEvent"("tenantId", "createdAt");
CREATE INDEX "ZeliProviderGatewayEvent_decision_idx" ON "ZeliProviderGatewayEvent"("decision");

ALTER TABLE "ZeliEntitlement" ADD CONSTRAINT "ZeliEntitlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZeliEntitlementEvent" ADD CONSTRAINT "ZeliEntitlementEvent_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "ZeliEntitlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ZeliEntitlementEvent" ADD CONSTRAINT "ZeliEntitlementEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZeliAnalyticsDaily" ADD CONSTRAINT "ZeliAnalyticsDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZeliAnalyticsRefresh" ADD CONSTRAINT "ZeliAnalyticsRefresh_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
