-- Additive: distinguish a demonstration request from a general account enquiry
-- and record which operations the business wants to manage.

ALTER TABLE "AccountEnquiry" ADD COLUMN "enquiryType" TEXT NOT NULL DEFAULT 'ACCOUNT_REQUEST';
ALTER TABLE "AccountEnquiry" ADD COLUMN "modules" TEXT;

CREATE INDEX "AccountEnquiry_enquiryType_createdAt_idx" ON "AccountEnquiry"("enquiryType", "createdAt");
