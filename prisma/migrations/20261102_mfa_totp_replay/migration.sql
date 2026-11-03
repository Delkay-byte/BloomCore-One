-- Replay prevention for TOTP MFA. Nullable so existing enrolments remain valid;
-- the first successful verification records the accepted time step.
ALTER TABLE "User" ADD COLUMN "mfaLastTotpStep" INTEGER;
ALTER TABLE "Customer" ADD COLUMN "mfaLastTotpStep" INTEGER;
ALTER TABLE "PlatformSuperAdmin" ADD COLUMN "mfaLastTotpStep" INTEGER;
