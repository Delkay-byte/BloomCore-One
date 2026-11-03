"use server";

import { db } from "@/lib/db";
import { getTenantContext } from "@/lib/tenant";
import { getZeliProviderStatus } from "@/lib/zeli/provider";
import {
  assertConversationOwner,
  runZeliTurn,
  ZeliUsageError,
} from "@/lib/zeli/service";
import type { ZeliIdentity } from "@/lib/zeli/types";

export interface ZeliActionResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

async function resolveIdentity(): Promise<ZeliIdentity | null> {
  for (const moduleName of ["admin", "momo", "susu", "customer"] as const) {
    const ctx = await getTenantContext(moduleName);
    if (ctx) {
      return {
        userId: ctx.userId,
        fullName: "",
        role: ctx.role as ZeliIdentity["role"],
        tenantId: ctx.tenantId,
        module: moduleName,
      };
    }
  }
  return null;
}

async function requireIdentity(): Promise<ZeliIdentity> {
  const identity = await resolveIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity;
}

const SUGGESTIONS: Record<string, string[]> = {
  admin: [
    "Summarise today's contributions and cash handed in.",
    "Which daily accounts are still draft or submitted?",
    "Show today's remittance variance.",
    "Find a customer by name or account id.",
  ],
  worker: [
    "What is the status of today's daily account?",
    "Explain the MoMo and cash variance on my latest account.",
    "Find a customer account I need to reference.",
  ],
  collector: [
    "How many customers are assigned to me?",
    "Summarise what I collected and handed in today.",
    "Find a customer by name or account id.",
  ],
  customer: [
    "Summarise my savings account and active cycle.",
    "How much have I contributed in this cycle?",
    "How do I request a withdrawal?",
  ],
};

export async function getZeliBootstrap(): Promise<
  ZeliActionResponse<{
    status: Awaited<ReturnType<typeof getZeliProviderStatus>>;
    suggestions: string[];
    role: string;
  }>
> {
  const identity = await resolveIdentity();
  if (!identity) return { success: false, error: "Not authenticated" };
  return {
    success: true,
    data: {
      status: await getZeliProviderStatus(undefined),
      suggestions: SUGGESTIONS[identity.role] ?? SUGGESTIONS.admin,
      role: identity.role,
    },
  };
}

export async function createZeliConversation(): Promise<
  ZeliActionResponse<{ id: string; title: string }>
> {
  const identity = await requireIdentity();
  const count = await db.zeliConversation.count({
    where: { tenantId: identity.tenantId, userId: identity.userId, deletedAt: null },
  });
  if (count >= 30) {
    return {
      success: false,
      error: "You have reached the conversation limit. Delete an old conversation first.",
    };
  }
  const conversation = await db.zeliConversation.create({
    data: {
      tenantId: identity.tenantId,
      userId: identity.userId,
      userType: identity.role === "customer" ? "customer" : "user",
      title: "New conversation",
    },
  });
  return { success: true, data: { id: conversation.id, title: conversation.title } };
}

export async function listZeliConversations(): Promise<
  ZeliActionResponse<Array<{ id: string; title: string; updatedAt: string }>>
> {
  const identity = await requireIdentity();
  const rows = await db.zeliConversation.findMany({
    where: { tenantId: identity.tenantId, userId: identity.userId, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, updatedAt: true },
  });
  return {
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function getZeliConversation(conversationId: string) {
  const identity = await requireIdentity();
  const conversation = await assertConversationOwner(conversationId, identity).catch(
    () => null
  );
  if (!conversation) return { success: false as const, error: "Conversation not found" };
  const messages = await db.zeliMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return {
    success: true as const,
    data: {
      id: conversation.id,
      title: conversation.title,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        sources: message.sources ? JSON.parse(message.sources) : [],
        feedback: message.feedback,
        createdAt: message.createdAt.toISOString(),
      })),
    },
  };
}

export async function renameZeliConversation(
  conversationId: string,
  title: string
): Promise<ZeliActionResponse> {
  const identity = await requireIdentity();
  const clean = title.trim().slice(0, 80);
  if (clean.length < 1) return { success: false, error: "Enter a title." };
  const conversation = await assertConversationOwner(conversationId, identity).catch(
    () => null
  );
  if (!conversation) return { success: false, error: "Conversation not found" };
  await db.zeliConversation.update({
    where: { id: conversation.id },
    data: { title: clean },
  });
  return { success: true };
}

export async function deleteZeliConversation(
  conversationId: string
): Promise<ZeliActionResponse> {
  const identity = await requireIdentity();
  const conversation = await assertConversationOwner(conversationId, identity).catch(
    () => null
  );
  if (!conversation) return { success: false, error: "Conversation not found" };
  await db.zeliConversation.delete({ where: { id: conversation.id } });
  return { success: true };
}

export async function sendZeliMessage(params: {
  conversationId: string;
  message: string;
}): Promise<ZeliActionResponse<{ text: string; sources: unknown[] }>> {
  const identity = await resolveIdentity();
  if (!identity) return { success: false, error: "Not authenticated" };
  try {
    const result = await runZeliTurn({
      identity,
      conversationId: params.conversationId,
      question: params.message,
    });
    return { success: true, data: { text: result.text, sources: result.sources } };
  } catch (error) {
    if (error instanceof ZeliUsageError) {
      return { success: false, error: error.message };
    }
    return {
      success: false,
      error: "Zeli could not complete that request. No data was changed.",
    };
  }
}

export async function setZeliFeedback(
  messageId: string,
  feedback: "helpful" | "unhelpful" | null
): Promise<ZeliActionResponse> {
  const identity = await requireIdentity();
  const message = await db.zeliMessage.findFirst({
    where: {
      id: messageId,
      conversation: {
        userId: identity.userId,
        tenantId: identity.tenantId,
        deletedAt: null,
      },
    },
  });
  if (!message) return { success: false, error: "Message not found" };
  await db.zeliMessage.update({
    where: { id: message.id },
    data: { feedback },
  });
  return { success: true };
}
