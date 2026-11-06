-- Entire-Zeli master availability switch. Separate from ZeliProviderControl.
-- The initial row preserves existing availability during rollout.

CREATE TABLE "ZeliAvailability" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZeliAvailability_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ZeliAvailability" ("id", "enabled", "reason", "updatedAt")
VALUES ('global', true, 'Initial rollout: Zeli availability preserved', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
