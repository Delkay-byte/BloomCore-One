-- Phase 1.1: session provenance + revocation replay store (ADR-0004)
--
-- Additive only. Existing SessionRecord rows keep authSource/idpSub/idpSid NULL
-- and are therefore treated as local sessions: central revocation and IdP
-- back-channel logout never target them.

ALTER TABLE "SessionRecord" ADD COLUMN IF NOT EXISTS "authSource" TEXT;
ALTER TABLE "SessionRecord" ADD COLUMN IF NOT EXISTS "idpSub" TEXT;
ALTER TABLE "SessionRecord" ADD COLUMN IF NOT EXISTS "idpSid" TEXT;

CREATE INDEX IF NOT EXISTS "SessionRecord_idpSub_idx" ON "SessionRecord"("idpSub");
CREATE INDEX IF NOT EXISTS "SessionRecord_idpSid_idx" ON "SessionRecord"("idpSid");

CREATE TABLE IF NOT EXISTS "OidcRevocationEvent" (
    "eventId"    TEXT NOT NULL,
    "source"     TEXT NOT NULL DEFAULT 'control_center',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OidcRevocationEvent_pkey" PRIMARY KEY ("eventId")
);
