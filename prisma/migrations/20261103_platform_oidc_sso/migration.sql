-- Platform OIDC SSO: identity links and SSO session companions.
-- Feature-flagged (PLATFORM_OIDC_ENABLED, default off); the tables are inert
-- until a platform administrator completes SSO linking. See docs/SSO-INTEGRATION.md.

CREATE TABLE "PlatformOidcLink" (
    "id" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "idpSub" TEXT NOT NULL,
    "linkedVia" TEXT NOT NULL,
    "createdBy" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformOidcLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformOidcLink_idpSub_key" ON "PlatformOidcLink"("idpSub");
CREATE UNIQUE INDEX "PlatformOidcLink_issuer_platformAdminId_key" ON "PlatformOidcLink"("issuer", "platformAdminId");
CREATE INDEX "PlatformOidcLink_platformAdminId_idx" ON "PlatformOidcLink"("platformAdminId");

ALTER TABLE "PlatformOidcLink" ADD CONSTRAINT "PlatformOidcLink_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformSuperAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PlatformOidcSession" (
    "id" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformOidcSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformOidcSession_platformAdminId_idx" ON "PlatformOidcSession"("platformAdminId");
CREATE INDEX "PlatformOidcSession_expiresAt_idx" ON "PlatformOidcSession"("expiresAt");
