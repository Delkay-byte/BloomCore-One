CREATE TABLE "ZeliConversation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "userId" TEXT NOT NULL,
  "userType" TEXT NOT NULL DEFAULT 'user',
  "title" TEXT NOT NULL DEFAULT 'New conversation',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ZeliConversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ZeliConversation_tenantId_userId_updatedAt_idx" ON "ZeliConversation"("tenantId","userId","updatedAt");
CREATE INDEX "ZeliConversation_deletedAt_idx" ON "ZeliConversation"("deletedAt");

CREATE TABLE "ZeliMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "sources" TEXT,
  "toolCalls" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "feedback" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ZeliMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ZeliMessage_conversationId_createdAt_idx" ON "ZeliMessage"("conversationId","createdAt");
CREATE INDEX "ZeliMessage_feedback_idx" ON "ZeliMessage"("feedback");
ALTER TABLE "ZeliMessage" ADD CONSTRAINT "ZeliMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ZeliConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ZeliUsage" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "userId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "requests" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ZeliUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ZeliUsage_tenantId_userId_day_key" ON "ZeliUsage"("tenantId","userId","day");
CREATE INDEX "ZeliUsage_day_idx" ON "ZeliUsage"("day");
