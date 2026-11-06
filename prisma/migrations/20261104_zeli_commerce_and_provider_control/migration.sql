-- Zeli commerce catalogue, subscription lifecycle, payment-event ledger,
-- global provider control and privacy-safe provider usage accounting.

CREATE TABLE "ZeliPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "billingInterval" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "features" TEXT,
    "usageAllowance" INTEGER,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "providerPlanCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZeliPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ZeliPlan_code_key" ON "ZeliPlan"("code");
CREATE INDEX "ZeliPlan_status_idx" ON "ZeliPlan"("status");
CREATE INDEX "ZeliPlan_isPublic_idx" ON "ZeliPlan"("isPublic");

CREATE TABLE "ZeliSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'paystack',
    "providerReference" TEXT NOT NULL,
    "providerSubscriptionCode" TEXT,
    "providerCustomerCode" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZeliSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ZeliSubscription_providerReference_key" ON "ZeliSubscription"("providerReference");
CREATE INDEX "ZeliSubscription_tenantId_status_idx" ON "ZeliSubscription"("tenantId", "status");
CREATE INDEX "ZeliSubscription_providerReference_idx" ON "ZeliSubscription"("providerReference");
CREATE INDEX "ZeliSubscription_periodEnd_idx" ON "ZeliSubscription"("periodEnd");

CREATE TABLE "ZeliPaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paystack',
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reference" TEXT,
    "subscriptionId" TEXT,
    "tenantId" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'received',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "ZeliPaymentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ZeliPaymentEvent_eventId_key" ON "ZeliPaymentEvent"("eventId");
CREATE INDEX "ZeliPaymentEvent_reference_idx" ON "ZeliPaymentEvent"("reference");
CREATE INDEX "ZeliPaymentEvent_tenantId_createdAt_idx" ON "ZeliPaymentEvent"("tenantId", "createdAt");
CREATE INDEX "ZeliPaymentEvent_decision_idx" ON "ZeliPaymentEvent"("decision");

CREATE TABLE "ZeliProviderControl" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "mode" TEXT NOT NULL DEFAULT 'disabled',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "emergencyDisabled" BOOLEAN NOT NULL DEFAULT true,
    "approvedProvider" TEXT,
    "approvedPurposes" TEXT,
    "policyVersion" TEXT,
    "approvalReference" TEXT,
    "reason" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZeliProviderControl_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ZeliAiTenantAuthorization" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZeliAiTenantAuthorization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ZeliAiTenantAuthorization_tenantId_key" ON "ZeliAiTenantAuthorization"("tenantId");

CREATE TABLE "ZeliProviderUsage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "tenantHash" TEXT NOT NULL,
    "userHash" TEXT NOT NULL,
    "roleCategory" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasonCategory" TEXT,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZeliProviderUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ZeliProviderUsage_requestId_key" ON "ZeliProviderUsage"("requestId");
CREATE INDEX "ZeliProviderUsage_tenantHash_createdAt_idx" ON "ZeliProviderUsage"("tenantHash", "createdAt");
CREATE INDEX "ZeliProviderUsage_userHash_createdAt_idx" ON "ZeliProviderUsage"("userHash", "createdAt");
CREATE INDEX "ZeliProviderUsage_decision_createdAt_idx" ON "ZeliProviderUsage"("decision", "createdAt");
CREATE INDEX "ZeliProviderUsage_provider_createdAt_idx" ON "ZeliProviderUsage"("provider", "createdAt");

ALTER TABLE "ZeliSubscription" ADD CONSTRAINT "ZeliSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZeliSubscription" ADD CONSTRAINT "ZeliSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ZeliPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ZeliPaymentEvent" ADD CONSTRAINT "ZeliPaymentEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ZeliSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ZeliPaymentEvent" ADD CONSTRAINT "ZeliPaymentEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ZeliAiTenantAuthorization" ADD CONSTRAINT "ZeliAiTenantAuthorization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
