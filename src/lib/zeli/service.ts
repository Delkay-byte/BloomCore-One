import { db } from "@/lib/db";
import { getZeliProvider } from "./provider";
import { buildZeliContext, sourcesFor } from "./tools";
import type { ZeliIdentity, ZeliSource, ZeliToolOutcome } from "./types";
import { ProviderUnavailableError } from "./mock-provider";
import {
  answerAdminBusinessQuestion,
  unsupportedAnswer,
} from "./intelligence/responder";
import { classifyIntent, isSupportedForRole } from "./intelligence/intents";
import {
  evaluateZeliAccess,
  getZeliEntitlement,
} from "./entitlements";

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
  intent: string;
  deterministic: boolean;
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

async function hasAnalyticsAccess(identity: ZeliIdentity): Promise<boolean> {
  if (!identity.tenantId || identity.role !== "admin") return false;
  const entitlement = await getZeliEntitlement(identity.tenantId);
  return evaluateZeliAccess({ role: identity.role, entitlement }).allowed;
}

/**
 * Run one user turn. Every query is scoped by the server-resolved identity.
 *
 * Providerless path:
 *  - business administrators get a deterministic answer composed from the
 *    server-computed business snapshot;
 *  - customer/worker/collector turns use the existing authorized read-only
 *    tools and the internal deterministic formatter;
 *  - unsupported questions receive an honest limitation, never a fabricated
 *    answer.
 *
 * No external provider is selected and no outbound request is made.
 */
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

  const analyticsAvailable = await hasAnalyticsAccess(params.identity);
  const classified = classifyIntent(question);
  let text: string;
  let sources: ZeliSource[] = [];
  let tools: ZeliToolOutcome[] = [];
  let providerName = "internal";
  let model = "rule-based";
  let intent = classified.intent;
  let deterministic = true;

  const analyticAnswer =
    params.identity.role === "admin"
      ? await answerAdminBusinessQuestion({
          identity: params.identity,
          question,
          analyticsAvailable,
        })
      : null;

  if (analyticAnswer) {
    text = analyticAnswer.text;
    sources = analyticAnswer.sources;
    intent = analyticAnswer.intent;
    deterministic = true;
  } else if (
    params.identity.role === "admin" &&
    (classified.intent === "unsupported" ||
      classified.intent === "customer_lookup" ||
      classified.intent === "daily_accounts")
  ) {
    if (classified.intent !== "unsupported") {
      // Customer lookup and daily-account status are supported read-only tools.
      const context = await buildZeliContext(params.identity, question);
      tools = context.tools;
      sources = sourcesFor(context.tools);
      const provider = getZeliProvider();
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
        text =
          error instanceof ProviderUnavailableError
            ? error.message
            : "Zeli could not complete that request. No business data was changed.";
      }
    } else {
      const unsupported = unsupportedAnswer(analyticsAvailable);
      text = unsupported.text;
      sources = unsupported.sources;
      intent = unsupported.intent;
    }
  } else if (
    params.identity.role !== "admin" &&
    !isSupportedForRole(params.identity.role, question)
  ) {
    const unsupported = unsupportedAnswer(analyticsAvailable);
    text = unsupported.text;
    sources = unsupported.sources;
    intent = unsupported.intent;
  } else {
    const context = await buildZeliContext(params.identity, question);
    tools = context.tools;
    sources = sourcesFor(context.tools);
    const provider = getZeliProvider();
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
      text =
        error instanceof ProviderUnavailableError
          ? error.message
          : "Zeli could not complete that request. No business data was changed.";
    }
  }

  await db.zeliMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: text,
      sources: sources.length ? JSON.stringify(sources) : null,
      toolCalls: JSON.stringify({
        intent,
        deterministic,
        category: "server_computed",
        tools: tools.map((tool) => ({
          tool: tool.tool,
          ok: tool.ok,
          durationMs: tool.durationMs,
        })),
      }),
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
    tools,
    provider: providerName,
    model,
    providerAvailable: true,
    intent,
    deterministic,
  };
}
