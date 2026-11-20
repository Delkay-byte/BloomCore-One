-- AlterTable
ALTER TABLE "CustomerMessagingPreference" ADD COLUMN     "smsVerificationMethod" TEXT,
ADD COLUMN     "smsVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "whatsappVerificationMethod" TEXT,
ADD COLUMN     "whatsappVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TenantMessagingConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappTemplateName" TEXT,
    "whatsappTemplateLanguage" TEXT,
    "smsSenderId" TEXT,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantMessagingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'receipt',
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en_US',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingConsentChallenge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "numberHash" TEXT NOT NULL,
    "numberMasked" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagingConsentChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantMessagingConfig_tenantId_key" ON "TenantMessagingConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantMessagingConfig_updatedAt_idx" ON "TenantMessagingConfig"("updatedAt");

-- CreateIndex
CREATE INDEX "MessagingTemplate_tenantId_channel_status_idx" ON "MessagingTemplate"("tenantId", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingTemplate_tenantId_channel_purpose_language_key" ON "MessagingTemplate"("tenantId", "channel", "purpose", "language");

-- CreateIndex
CREATE INDEX "MessagingConsentChallenge_customerId_channel_status_idx" ON "MessagingConsentChallenge"("customerId", "channel", "status");

-- CreateIndex
CREATE INDEX "MessagingConsentChallenge_expiresAt_idx" ON "MessagingConsentChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "TenantMessagingConfig" ADD CONSTRAINT "TenantMessagingConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingTemplate" ADD CONSTRAINT "MessagingTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingConsentChallenge" ADD CONSTRAINT "MessagingConsentChallenge_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingConsentChallenge" ADD CONSTRAINT "MessagingConsentChallenge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

