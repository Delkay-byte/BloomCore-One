import "dotenv/config";
import { db } from "../src/lib/db";

/**
 * Additive SQLite parity for the Shared Agent Risk Intelligence tables.
 *
 * The repository's migration history is PostgreSQL-first, and SQLite does not
 * accept the multi-column ALTER statements used there. This script applies the
 * same additive changes to the existing SQLite database, one column at a time,
 * idempotently. It never drops a table, column or row and never deletes data.
 * PostgreSQL deployments use the reviewed migration files, not this script.
 */

const TABLES: Record<string, string> = {
  RiskIntelligenceConsent: `CREATE TABLE IF NOT EXISTS "RiskIntelligenceConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "policyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "scope" TEXT NOT NULL DEFAULT 'share_signals',
    "consentedById" TEXT NOT NULL,
    "consentedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnById" TEXT,
    "withdrawnAt" DATETIME,
    "withdrawReason" TEXT,
    "billingBasis" TEXT,
    "eligibilityVerified" BOOLEAN NOT NULL DEFAULT false,
    "controllerRegistrationChecked" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" DATETIME,
    "suspensionReason" TEXT,
    "suspendedById" TEXT,
    "expelledAt" DATETIME,
    "expulsionReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  AgentRiskSignal: `CREATE TABLE IF NOT EXISTS "AgentRiskSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "keyBasis" TEXT NOT NULL,
    "saltVersion" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "internalNote" TEXT,
    "observedFrom" DATETIME NOT NULL,
    "observedTo" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "withdrawnAt" DATETIME,
    "frozenAt" DATETIME,
    "disputedAt" DATETIME,
    "resolvedAt" DATETIME,
    "deletedAt" DATETIME,
    "scrubbedAt" DATETIME,
    "evidenceReference" TEXT,
    "goodFaithDeclaredAt" DATETIME,
    "reportedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  RiskIntelligenceDisclosure: `CREATE TABLE IF NOT EXISTS "RiskIntelligenceDisclosure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "disclosed" TEXT NOT NULL,
    "contributorCount" INTEGER NOT NULL,
    "viewerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  RiskGlobalControl: `CREATE TABLE IF NOT EXISTS "RiskGlobalControl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  RiskSubjectFreeze: `CREATE TABLE IF NOT EXISTS "RiskSubjectFreeze" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'frozen',
    "reason" TEXT NOT NULL,
    "caseRef" TEXT,
    "frozenById" TEXT NOT NULL,
    "notifiedTenantId" TEXT,
    "frozenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolutionById" TEXT,
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  SubjectRightsRequest: `CREATE TABLE IF NOT EXISTS "SubjectRightsRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseRef" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectKey" TEXT,
    "subjectUserId" TEXT,
    "type" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'received',
    "reviewerId" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "holidayCalendarVersion" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME,
    "ackDeadline" DATETIME NOT NULL,
    "resolutionDeadline" DATETIME NOT NULL,
    "extendedDeadline" DATETIME,
    "extensionReason" TEXT,
    "extensionApprovedById" TEXT,
    "decision" TEXT,
    "decisionReason" TEXT,
    "resolvedAt" DATETIME,
    "closedAt" DATETIME,
    "evidence" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  RightsRequestCommunication: `CREATE TABLE IF NOT EXISTS "RightsRequestCommunication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  EmployeePrivacyNotice: `CREATE TABLE IF NOT EXISTS "EmployeePrivacyNotice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentText" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "effectiveDate" DATETIME NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  EmployeeNoticeAttestation: `CREATE TABLE IF NOT EXISTS "EmployeeNoticeAttestation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "deliveryMethod" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    "deliveryEvidence" TEXT NOT NULL,
    "documentSha256" TEXT,
    "acknowledgementState" TEXT NOT NULL DEFAULT 'delivered',
    "acknowledgedAt" DATETIME,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" DATETIME,
    "failureReason" TEXT,
    "recordedById" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  ParticipationAgreement: `CREATE TABLE IF NOT EXISTS "ParticipationAgreement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveDate" DATETIME NOT NULL,
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
    "acceptedAt" DATETIME,
    "countersignedById" TEXT,
    "countersignedAt" DATETIME,
    "executedAt" DATETIME,
    "countersignatoryName" TEXT,
    "countersignatoryCapacity" TEXT,
    "executionCertificateSha256" TEXT,
    "supersededById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  RiskLegalHold: `CREATE TABLE IF NOT EXISTS "RiskLegalHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "tenantId" TEXT,
    "dpoReference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorisedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewDate" DATETIME NOT NULL,
    "caseClosureDate" DATETIME,
    "extensionUntil" DATETIME,
    "extensionReason" TEXT,
    "releasedAt" DATETIME,
    "releasedById" TEXT,
    "releaseReason" TEXT
  )`,
  RiskControlEvent: `CREATE TABLE IF NOT EXISTS "RiskControlEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "scopeId" TEXT,
    "tenantId" TEXT,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "history" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  RiskKeyVersion: `CREATE TABLE IF NOT EXISTS "RiskKeyVersion" (
    "version" INTEGER NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "providerRef" TEXT,
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" DATETIME,
    "retiredById" TEXT
  )`,
  RiskPrivacyAccess: `CREATE TABLE IF NOT EXISTS "RiskPrivacyAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  RiskOrganisationProfile: `CREATE TABLE IF NOT EXISTS "RiskOrganisationProfile" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'bloomcore',
    "registeredOffice" TEXT,
    "registeredOfficeConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "privacyEmail" TEXT,
    "signatoryName" TEXT,
    "signatoryCapacity" TEXT,
    "hostingProviders" TEXT,
    "hostingRegions" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  GovernanceDocumentDelivery: `CREATE TABLE IF NOT EXISTS "GovernanceDocumentDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
  )`,
};

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS "RiskIntelligenceConsent_tenantId_status_idx" ON "RiskIntelligenceConsent"("tenantId", "status")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "RiskIntelligenceConsent_tenantId_policyVersion_key" ON "RiskIntelligenceConsent"("tenantId", "policyVersion")',
  'CREATE INDEX IF NOT EXISTS "RiskIntelligenceConsent_expelledAt_idx" ON "RiskIntelligenceConsent"("expelledAt")',
  'CREATE INDEX IF NOT EXISTS "AgentRiskSignal_subjectKey_status_idx" ON "AgentRiskSignal"("subjectKey", "status")',
  'CREATE INDEX IF NOT EXISTS "AgentRiskSignal_tenantId_status_idx" ON "AgentRiskSignal"("tenantId", "status")',
  'CREATE INDEX IF NOT EXISTS "AgentRiskSignal_expiresAt_idx" ON "AgentRiskSignal"("expiresAt")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "AgentRiskSignal_tenantId_subjectKey_sourceType_sourceId_key" ON "AgentRiskSignal"("tenantId", "subjectKey", "sourceType", "sourceId")',
  'CREATE INDEX IF NOT EXISTS "RiskIntelligenceDisclosure_tenantId_createdAt_idx" ON "RiskIntelligenceDisclosure"("tenantId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "RiskIntelligenceDisclosure_subjectKey_createdAt_idx" ON "RiskIntelligenceDisclosure"("subjectKey", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "RiskIntelligenceDisclosure_createdAt_idx" ON "RiskIntelligenceDisclosure"("createdAt")',
  'CREATE INDEX IF NOT EXISTS "RiskSubjectFreeze_subjectKey_status_idx" ON "RiskSubjectFreeze"("subjectKey", "status")',
  'CREATE INDEX IF NOT EXISTS "RiskSubjectFreeze_status_frozenAt_idx" ON "RiskSubjectFreeze"("status", "frozenAt")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "SubjectRightsRequest_caseRef_key" ON "SubjectRightsRequest"("caseRef")',
  'CREATE INDEX IF NOT EXISTS "SubjectRightsRequest_tenantId_status_idx" ON "SubjectRightsRequest"("tenantId", "status")',
  'CREATE INDEX IF NOT EXISTS "SubjectRightsRequest_ackDeadline_idx" ON "SubjectRightsRequest"("ackDeadline")',
  'CREATE INDEX IF NOT EXISTS "SubjectRightsRequest_resolutionDeadline_idx" ON "SubjectRightsRequest"("resolutionDeadline")',
  'CREATE INDEX IF NOT EXISTS "RightsRequestCommunication_requestId_createdAt_idx" ON "RightsRequestCommunication"("requestId", "createdAt")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "EmployeePrivacyNotice_version_key" ON "EmployeePrivacyNotice"("version")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeNoticeAttestation_tenantId_userId_noticeVersion_key" ON "EmployeeNoticeAttestation"("tenantId", "userId", "noticeVersion")',
  'CREATE INDEX IF NOT EXISTS "EmployeeNoticeAttestation_tenantId_noticeVersion_idx" ON "EmployeeNoticeAttestation"("tenantId", "noticeVersion")',
  'CREATE INDEX IF NOT EXISTS "EmployeeNoticeAttestation_verified_idx" ON "EmployeeNoticeAttestation"("tenantId", "verified")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ParticipationAgreement_tenantId_type_version_key" ON "ParticipationAgreement"("tenantId", "type", "version")',
  'CREATE INDEX IF NOT EXISTS "ParticipationAgreement_tenantId_state_idx" ON "ParticipationAgreement"("tenantId", "state")',
  'CREATE INDEX IF NOT EXISTS "RiskLegalHold_scopeType_scopeId_idx" ON "RiskLegalHold"("scopeType", "scopeId")',
  'CREATE INDEX IF NOT EXISTS "RiskControlEvent_level_scopeId_createdAt_idx" ON "RiskControlEvent"("level", "scopeId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "RiskKeyVersion_status_idx" ON "RiskKeyVersion"("status")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "RiskPrivacyAccess_userId_key" ON "RiskPrivacyAccess"("userId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "GovernanceDocumentDelivery_eventType_scopeId_recipientHash_key" ON "GovernanceDocumentDelivery"("eventType", "scopeId", "recipientHash")',
  'CREATE INDEX IF NOT EXISTS "GovernanceDocumentDelivery_tenantId_createdAt_idx" ON "GovernanceDocumentDelivery"("tenantId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "GovernanceDocumentDelivery_status_createdAt_idx" ON "GovernanceDocumentDelivery"("status", "createdAt")',
];

const COLUMNS: [string, string, string][] = [
  ["BusinessTenant", "registrationNumber", "TEXT"],
  ["BusinessTenant", "dpcRegistrationStatus", "TEXT NOT NULL DEFAULT 'not_provided'"],
  ["BusinessTenant", "dpcRegistrationNumber", "TEXT"],
  ["BusinessTenant", "dpcRegistrationCheckedAt", "DATETIME"],
];

async function existingColumns(table: string): Promise<Set<string>> {
  const rows = await db.$queryRawUnsafe<{ name: string }[]>(
    'PRAGMA table_info("' + table + '")'
  );
  return new Set(rows.map((row) => row.name));
}

async function main() {
  for (const [name, ddl] of Object.entries(TABLES)) {
    await db.$executeRawUnsafe(ddl);
    console.log("table ready: " + name);
  }
  for (const statement of INDEXES) await db.$executeRawUnsafe(statement + ";");
  for (const [table, column, definition] of COLUMNS) {
    const columns = await existingColumns(table);
    if (columns.has(column)) continue;
    await db.$executeRawUnsafe(
      'ALTER TABLE "' + table + '" ADD COLUMN "' + column + '" ' + definition + ";"
    );
    console.log("column added: " + table + "." + column);
  }
  console.log("risk intelligence SQLite parity complete");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "SQLite parity failed.");
  process.exitCode = 1;
});
