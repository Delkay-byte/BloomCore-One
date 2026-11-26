-- Shared agent risk intelligence — DPC governance safeguards (ENG-01..ENG-08)
-- Additive migration. No existing column is dropped, renamed or repurposed and
-- no existing record is modified. Applies on top of 20261221_shared_risk_intelligence.

-- AlterTable
ALTER TABLE "RiskIntelligenceConsent"
    ADD COLUMN "eligibilityVerified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "controllerRegistrationChecked" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "suspendedAt" TIMESTAMP(3),
    ADD COLUMN "suspensionReason" TEXT,
    ADD COLUMN "suspendedById" TEXT;

-- AlterTable
ALTER TABLE "AgentRiskSignal"
    ADD COLUMN "withdrawnAt" TIMESTAMP(3),
    ADD COLUMN "frozenAt" TIMESTAMP(3),
    ADD COLUMN "disputedAt" TIMESTAMP(3),
    ADD COLUMN "resolvedAt" TIMESTAMP(3),
    ADD COLUMN "deletedAt" TIMESTAMP(3),
    ADD COLUMN "scrubbedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RiskIntelligenceDisclosure"
    ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "RiskIntelligenceDisclosure_createdAt_idx" ON "RiskIntelligenceDisclosure"("createdAt");

-- CreateTable
CREATE TABLE "RiskGlobalControl" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiskGlobalControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskSubjectFreeze" (
    "id" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'frozen',
    "reason" TEXT NOT NULL,
    "caseRef" TEXT,
    "frozenById" TEXT NOT NULL,
    "notifiedTenantId" TEXT,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolutionById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RiskSubjectFreeze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubjectRightsRequest" (
    "id" TEXT NOT NULL,
    "caseRef" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectKey" TEXT,
    "subjectUserId" TEXT,
    "type" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'received',
    "reviewerId" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "ackDeadline" TIMESTAMP(3) NOT NULL,
    "resolutionDeadline" TIMESTAMP(3) NOT NULL,
    "extendedDeadline" TIMESTAMP(3),
    "extensionReason" TEXT,
    "extensionApprovedById" TEXT,
    "decision" TEXT,
    "decisionReason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubjectRightsRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsRequestCommunication" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RightsRequestCommunication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeePrivacyNotice" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentText" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeePrivacyNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeNoticeAttestation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "deliveryMethod" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "deliveryEvidence" TEXT NOT NULL,
    "documentSha256" TEXT,
    "acknowledgementState" TEXT NOT NULL DEFAULT 'delivered',
    "acknowledgedAt" TIMESTAMP(3),
    "recordedById" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeNoticeAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipationAgreement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "documentText" TEXT NOT NULL,
    "documentSha256" TEXT NOT NULL,
    "documentRef" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "signatoryId" TEXT NOT NULL,
    "signatoryName" TEXT NOT NULL,
    "signatoryRole" TEXT NOT NULL,
    "signatoryAuthority" TEXT NOT NULL,
    "authenticationMethod" TEXT NOT NULL,
    "authenticationEvidence" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "countersignedById" TEXT,
    "countersignedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParticipationAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskLegalHold" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "tenantId" TEXT,
    "dpoReference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorisedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewDate" TIMESTAMP(3) NOT NULL,
    "caseClosureDate" TIMESTAMP(3),
    "extensionUntil" TIMESTAMP(3),
    "extensionReason" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releaseReason" TEXT,
    CONSTRAINT "RiskLegalHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskControlEvent" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "scopeId" TEXT,
    "tenantId" TEXT,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "history" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RiskControlEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskKeyVersion" (
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "providerRef" TEXT,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredById" TEXT,
    CONSTRAINT "RiskKeyVersion_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "RiskPrivacyAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RiskPrivacyAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceDocumentDelivery" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "tenantId" TEXT,
    "recipientUserId" TEXT,
    "recipientHash" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "retryHistory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    CONSTRAINT "GovernanceDocumentDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskSubjectFreeze_subjectKey_status_idx" ON "RiskSubjectFreeze"("subjectKey", "status");
CREATE INDEX "RiskSubjectFreeze_status_frozenAt_idx" ON "RiskSubjectFreeze"("status", "frozenAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectRightsRequest_caseRef_key" ON "SubjectRightsRequest"("caseRef");
CREATE INDEX "SubjectRightsRequest_tenantId_status_idx" ON "SubjectRightsRequest"("tenantId", "status");
CREATE INDEX "SubjectRightsRequest_ackDeadline_idx" ON "SubjectRightsRequest"("ackDeadline");
CREATE INDEX "SubjectRightsRequest_resolutionDeadline_idx" ON "SubjectRightsRequest"("resolutionDeadline");

-- CreateIndex
CREATE INDEX "RightsRequestCommunication_requestId_createdAt_idx" ON "RightsRequestCommunication"("requestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeePrivacyNotice_version_key" ON "EmployeePrivacyNotice"("version");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeNoticeAttestation_tenantId_userId_noticeVersion_key" ON "EmployeeNoticeAttestation"("tenantId", "userId", "noticeVersion");
CREATE INDEX "EmployeeNoticeAttestation_tenantId_noticeVersion_idx" ON "EmployeeNoticeAttestation"("tenantId", "noticeVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipationAgreement_tenantId_type_version_key" ON "ParticipationAgreement"("tenantId", "type", "version");
CREATE INDEX "ParticipationAgreement_tenantId_state_idx" ON "ParticipationAgreement"("tenantId", "state");

-- CreateIndex
CREATE INDEX "RiskLegalHold_scopeType_scopeId_idx" ON "RiskLegalHold"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "RiskControlEvent_level_scopeId_createdAt_idx" ON "RiskControlEvent"("level", "scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskKeyVersion_status_idx" ON "RiskKeyVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RiskPrivacyAccess_userId_key" ON "RiskPrivacyAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceDocumentDelivery_eventType_scopeId_recipientHash_key" ON "GovernanceDocumentDelivery"("eventType", "scopeId", "recipientHash");
CREATE INDEX "GovernanceDocumentDelivery_tenantId_createdAt_idx" ON "GovernanceDocumentDelivery"("tenantId", "createdAt");
CREATE INDEX "GovernanceDocumentDelivery_status_createdAt_idx" ON "GovernanceDocumentDelivery"("status", "createdAt");
