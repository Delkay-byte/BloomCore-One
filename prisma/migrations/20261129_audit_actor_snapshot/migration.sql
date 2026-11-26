-- Durable actor identity for audit evidence.
--
-- Additive. New audit rows snapshot the actor's name, role and type at the time
-- of the action. Historical rows remain null and are resolved from the current
-- user/customer record by the Activity History API.

ALTER TABLE "AuditLog" ADD COLUMN "actorName" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "actorRole" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "actorType" TEXT;
