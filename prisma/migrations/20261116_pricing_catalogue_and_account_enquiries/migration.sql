// Package catalogue limits and prospective-customer enquiries.

ALTER TABLE "ZeliPlan" ADD COLUMN "locationLimit" INTEGER;
ALTER TABLE "ZeliPlan" ADD COLUMN "staffLimit" INTEGER;
ALTER TABLE "ZeliPlan" ADD COLUMN "supportLevel" TEXT;

CREATE TABLE "AccountEnquiry" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "locationCount" INTEGER,
    "interestedPlan" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "source" TEXT,
    "notes" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountEnquiry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountEnquiry_status_createdAt_idx" ON "AccountEnquiry"("status", "createdAt");
CREATE INDEX "AccountEnquiry_createdAt_idx" ON "AccountEnquiry"("createdAt");
