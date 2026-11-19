"use server";

import { db } from "@/lib/db";
import { getTenantContext } from "@/lib/tenant";

import { suggestedQuestionsForRole } from "@/lib/zeli/intelligence/intents";
import {
  evaluateZeliAccess,
  getZeliEntitlement,
} from "@/lib/zeli/entitlements";
import { zeliUsageSummary } from "@/lib/zeli/usage";
import {
  assertConversationOwner,
  runZeliTurn,
  ZeliUsageError,
} from "@/lib/zeli/service";
import type { ZeliIdentity } from "@/lib/zeli/types";
import {
  getTenantZeliAccess,
  getZeliAvailability,
  TENANT_DISABLED_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from "@/lib/zeli/availability";

export interface ZeliActionResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

async function resolveIdentity(): Promise<ZeliIdentity | null> {
  if (!(await getZeliAvailability()).enabled) return null;
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

export async function getZeliBootstrap(): Promise<
  ZeliActionResponse<{
    /** Sanitized: never carries a provider or model name to the browser. */
    status: { available: boolean };
    suggestions: string[];
    role: string;
    analyticsAccess: boolean;
    usage: Awaited<ReturnType<typeof zeliUsageSummary>> | null;
  }>
> {
  const availability = await getZeliAvailability();
  if (!availability.enabled) {
    return { success: false, error: UNAVAILABLE_MESSAGE };
  }
  const identity = await resolveIdentity();
  if (!identity) return { success: false, error: "Not authenticated" };

  const tenantAccess = await getTenantZeliAccess(identity.tenantId);
  if (!tenantAccess.enabled) {
    return { success: false, error: TENANT_DISABLED_MESSAGE };
  }

  const entitlement = identity.tenantId
    ? await getZeliEntitlement(identity.tenantId)
    : null;
  const analyticsAccess = evaluateZeliAccess({
    role: identity.role,
    entitlement,
  }).allowed;
  const usage = identity.tenantId ? await zeliUsageSummary(identity.tenantId) : null;
  return {
    success: true,
    data: {
      status: { available: true },
      suggestions: suggestedQuestionsForRole(identity.role, {
        analyticsAvailable: analyticsAccess,
      }),
      role: identity.role,
      analyticsAccess,
      usage,
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
        provider: message.provider,
        model: message.model,
        deterministic: message.provider === "internal",
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
    data: { title: clean, titleSource: "manual" },
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
}): Promise<
  ZeliActionResponse<{
    text: string;
    sources: unknown[];
    intent: string;
    deterministic: boolean;
  }>
> {
  const identity = await resolveIdentity();
  if (!identity) return { success: false, error: "Not authenticated" };
  try {
    const result = await runZeliTurn({
      identity,
      conversationId: params.conversationId,
      question: params.message,
    });
    return {
      success: true,
      data: {
        text: result.text,
        sources: result.sources,
        intent: result.intent,
        deterministic: result.deterministic,
      },
    };
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
