-- Track whether a Zeli conversation title was generated or manually chosen.
ALTER TABLE "ZeliConversation" ADD COLUMN "titleSource" TEXT NOT NULL DEFAULT 'auto';
