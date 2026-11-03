import { db } from "@/lib/db";
import { getZeliProvider } from "./provider";
import { buildZeliContext, sourcesFor } from "./tools";
import type { ZeliIdentity, ZeliSource, ZeliToolOutcome } from "./types";
import { ProviderUnavailableError } from "./mock-provider";

const DAILY_REQUEST_LIMIT = 40;

export class ZeliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZeliUsageError";
  }
}

export interface ZeliTurnResult {
  conversationId: string;
  text: string;
  sources: ZeliSource[];
  tools: ZeliToolOutcome[];
  provider: string;
  model: string;
  providerAvailable: boolean;
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function consumeUsage(identity: ZeliIdentity): Promise<void> {
  const day = dayKey();
  const where = {
    tenantId: identity.tenantId,
    userId: identity.userId,
    day,
  };
  try {
    await db.zeliUsage.create({
      data: { ...where, requests: 1 },
    });
    return;
  } catch {
    // Existing row: increment only while below the limit.
  }
  const updated = await db.zeliUsage.updateMany({
    where: { ...where, requests: { lt: DAILY_REQUEST_LIMIT } },
    data: { requests: { increment: 1 } },
  });
  if (updated.count === 0) {
    throw new ZeliUsageError(
      "You have reached today's Zeli request limit. The limit resets at 00:00 UTC."
    );
  }
}

export async function assertConversationOwner(
  conversationId: string,
  identity: ZeliIdentity
) {
  const conversation = await db.zeliConversation.findFirst({
    where: {
      id: conversationId,
      userId: identity.userId,
      tenantId: identity.tenantId,
      deletedAt: null,
    },
  });
  if (!conversation) throw new Error("Conversation not found");
  return conversation;
}

/** Run one user turn. Every query is scoped by the server-resolved identity. */
export async function runZeliTurn(params: {
  identity: ZeliIdentity;
  conversationId: string;
  question: string;
}): Promise<ZeliTurnResult> {
  const question = params.question.trim();
  if (question.length < 1 || question.length > 4000) {
    throw new ZeliUsageError("Enter a question between 1 and 4000 characters.");
  }

  const conversation = await assertConversationOwner(
    params.conversationId,
    params.identity
  );
  await consumeUsage(params.identity);

  const previous = await db.zeliMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { role: true, content: true },
  });

  await db.zeliMessage.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: question,
    },
  });

  const context = await buildZeliContext(params.identity, question);
  const provider = getZeliProvider();
  const availability = provider.available();

  let text: string;
  let providerName = provider.name;
  let model = provider.model;
  let providerAvailable = availability.ok;

  if (!availability.ok) {
    text =
      "Zeli is not connected to an external AI provider right now. " +
      availability.reason +
      "\n\nYou can still use the normal BloomCore One screens, or ask again when the provider is enabled. No data was sent.";
  } else {
    try {
      const response = await provider.generate({
        system: "server-controlled",
        question,
        history: previous.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
        })),
        context: context.blocks,
        identity: params.identity,
      });
      text = response.text;
      providerName = response.provider;
      model = response.model;
    } catch (error) {
      providerAvailable = false;
      text =
        error instanceof ProviderUnavailableError
          ? error.message
          : "Zeli could not complete that request. No business data was changed. Please try again.";
    }
  }

  const sources = sourcesFor(context.tools);
  await db.zeliMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: text,
      sources: sources.length ? JSON.stringify(sources) : null,
      toolCalls: JSON.stringify(
        context.tools.map((tool) => ({
          tool: tool.tool,
          ok: tool.ok,
          durationMs: tool.durationMs,
        }))
      ),
      provider: providerName,
      model,
    },
  });

  await db.zeliConversation.update({
    where: { id: conversation.id },
    data: {
      updatedAt: new Date(),
      ...(conversation.title === "New conversation"
        ? { title: question.slice(0, 70) }
        : {}),
    },
  });

  return {
    conversationId: conversation.id,
    text,
    sources,
    tools: context.tools,
    provider: providerName,
    model,
    providerAvailable,
  };
}
