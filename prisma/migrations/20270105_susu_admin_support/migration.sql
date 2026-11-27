-- Phase 8 - enterprise administration and support.
--
-- ADDITIVE ONLY. Three new tables (SupportRequest, SupportMessage,
-- SupportEvent) and their indexes. No existing table, column, index or row is
-- dropped, renamed, retyped or rewritten. Nothing here holds money, a
-- balance or a ledger entry: a support request records a conversation, never
-- a financial fact, so no historical financial record is touched.
--
-- SupportMessage / SupportEvent cascade only with their own request. Author
-- ids are deliberate snapshots (no foreign keys) so a later staff or platform
-- account lifecycle change cannot delete or rewrite support history.

CREATE TABLE "SupportRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "branchId" TEXT,
    "reference" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'open',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignedAgentId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolvedAgentId" TEXT,
    "resolutionNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "reopenedCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportRequest_reference_key" ON "SupportRequest"("reference");
CREATE INDEX "SupportRequest_tenantId_status_createdAt_idx" ON "SupportRequest"("tenantId", "status", "createdAt");
CREATE INDEX "SupportRequest_status_priority_createdAt_idx" ON "SupportRequest"("status", "priority", "createdAt");
CREATE INDEX "SupportRequest_assignedAgentId_status_idx" ON "SupportRequest"("assignedAgentId", "status");
CREATE INDEX "SupportRequest_tenantId_branchId_idx" ON "SupportRequest"("tenantId", "branchId");
CREATE INDEX "SupportRequest_tenantId_createdAt_idx" ON "SupportRequest"("tenantId", "createdAt");

ALTER TABLE "SupportRequest"
    ADD CONSTRAINT "SupportRequest_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportRequest"
    ADD CONSTRAINT "SupportRequest_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportRequest"
    ADD CONSTRAINT "SupportRequest_assignedAgentId_fkey"
    FOREIGN KEY ("assignedAgentId") REFERENCES "PlatformSuperAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorAgentId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'tenant',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportMessage_requestId_createdAt_idx" ON "SupportMessage"("requestId", "createdAt");
CREATE INDEX "SupportMessage_requestId_visibility_idx" ON "SupportMessage"("requestId", "visibility");

ALTER TABLE "SupportMessage"
    ADD CONSTRAINT "SupportMessage_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SupportEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorAgentId" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportEvent_requestId_createdAt_idx" ON "SupportEvent"("requestId", "createdAt");
CREATE INDEX "SupportEvent_type_createdAt_idx" ON "SupportEvent"("type", "createdAt");

ALTER TABLE "SupportEvent"
    ADD CONSTRAINT "SupportEvent_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
