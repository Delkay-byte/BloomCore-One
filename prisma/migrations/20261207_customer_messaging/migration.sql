CREATE TABLE "CustomerMessagingPreference" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "customerId" TEXT NOT NULL,
  "tenantId" TEXT,
  "whatsappNumber" TEXT,
  "whatsappStatus" TEXT NOT NULL DEFAULT 'unverified',
  "whatsappOptInAt" TIMESTAMP(3),
  "whatsappOptInSource" TEXT,
  "whatsappOptOutAt" TIMESTAMP(3),
  "smsNumber" TEXT,
  "smsStatus" TEXT NOT NULL DEFAULT 'unverified',
  "smsOptInAt" TIMESTAMP(3),
  "smsOptInSource" TEXT,
  "smsOptOutAt" TIMESTAMP(3),
  "preferredChannel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerMessagingPreference_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CustomerMessagingPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerMessagingPreference_customerId_key" ON "CustomerMessagingPreference"("customerId");
CREATE INDEX "CustomerMessagingPreference_tenantId_idx" ON "CustomerMessagingPreference"("tenantId");
CREATE INDEX "CustomerMessagingPreference_preferredChannel_idx" ON "CustomerMessagingPreference"("preferredChannel");

CREATE TABLE "CustomerMessageOutbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventKey" TEXT NOT NULL,
  "tenantId" TEXT,
  "customerId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'receipt',
  "reference" TEXT NOT NULL,
  "recipientEncrypted" TEXT NOT NULL,
  "recipientMasked" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "providerId" TEXT,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerMessageOutbox_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CustomerMessageOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerMessageOutbox_eventKey_key" ON "CustomerMessageOutbox"("eventKey");
CREATE INDEX "CustomerMessageOutbox_tenantId_status_idx" ON "CustomerMessageOutbox"("tenantId", "status");
CREATE INDEX "CustomerMessageOutbox_status_nextAttemptAt_idx" ON "CustomerMessageOutbox"("status", "nextAttemptAt");
CREATE INDEX "CustomerMessageOutbox_customerId_createdAt_idx" ON "CustomerMessageOutbox"("customerId", "createdAt");
CREATE INDEX "CustomerMessageOutbox_providerMessageId_idx" ON "CustomerMessageOutbox"("providerMessageId");

CREATE TABLE "CustomerMessageStatusEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "outboxId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerMessageStatusEvent_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "CustomerMessageOutbox" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerMessageStatusEvent_eventId_key" ON "CustomerMessageStatusEvent"("eventId");
CREATE INDEX "CustomerMessageStatusEvent_outboxId_occurredAt_idx" ON "CustomerMessageStatusEvent"("outboxId", "occurredAt");
