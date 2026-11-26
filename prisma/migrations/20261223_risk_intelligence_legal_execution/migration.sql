-- Shared agent risk intelligence - controlled legal instruments and execution
-- Additive migration. No column is dropped, renamed or repurposed and no record
-- is modified. Applies on top of 20261222_risk_intelligence_governance_safeguards.

ALTER TABLE "BusinessTenant"
    ADD COLUMN "registrationNumber" TEXT,
    ADD COLUMN "dpcRegistrationStatus" TEXT NOT NULL DEFAULT 'not_provided',
    ADD COLUMN "dpcRegistrationNumber" TEXT,
    ADD COLUMN "dpcRegistrationCheckedAt" TIMESTAMP(3);

ALTER TABLE "RiskIntelligenceConsent"
    ADD COLUMN "expelledAt" TIMESTAMP(3),
    ADD COLUMN "expulsionReason" TEXT;

ALTER TABLE "AgentRiskSignal"
    ADD COLUMN "evidenceReference" TEXT,
    ADD COLUMN "goodFaithDeclaredAt" TIMESTAMP(3),
    ADD COLUMN "reportedById" TEXT;

ALTER TABLE "EmployeeNoticeAttestation"
    ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "verifiedAt" TIMESTAMP(3),
    ADD COLUMN "failureReason" TEXT;

ALTER TABLE "ParticipationAgreement"
    ADD COLUMN "countersignatoryName" TEXT,
    ADD COLUMN "countersignatoryCapacity" TEXT,
    ADD COLUMN "executionCertificateSha256" TEXT;

ALTER TABLE "SubjectRightsRequest"
    ADD COLUMN "holidayCalendarVersion" TEXT;

CREATE INDEX "RiskIntelligenceConsent_expelledAt_idx" ON "RiskIntelligenceConsent"("expelledAt");
CREATE INDEX "EmployeeNoticeAttestation_verified_idx" ON "EmployeeNoticeAttestation"("tenantId", "verified");
