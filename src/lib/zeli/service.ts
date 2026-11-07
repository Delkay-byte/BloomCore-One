import { db } from "@/lib/db";
import { getZeliProvider } from "./provider";
import { buildZeliContext, sourcesFor } from "./tools";
import type { ZeliIdentity, ZeliSource, ZeliToolOutcome } from "./types";
import { ProviderUnavailableError } from "./mock-provider";
import { assertZeliAvailable } from "./availability";
import {
  answerAdminBusinessQuestion,
  unsupportedAnswer,
} from "./intelligence/responder";
import { classifyIntent, isSupportedForRole } from "./intelligence/intents";
import {
  evaluateZeliAccess,
  getZeliEntitlement,
} from "./entitlements";
import {
  classifyConversationAct,
  isFinancialInstruction,
  type ZeliConversationAct,
} from "./conversation/acts";
import {
  parsePreviousTurn,
  resolveConversationContext,
} from "./conversation/context";
import {
  clarificationAnswer,
  conversationActAnswer,
} from "./conversation/social";
import { detectAmbiguity } from "./conversation/clarify";
import {
  generateExternalConversation,
  generateTeamConversation,
} from "./providers/conversation-provider";
import { getConversationPolicy } from "./providers/conversation-policy";
import { runToolConversation } from "./providers/tool-orchestrator";

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
  conversationMode: "local" | "external";
  externalAi: boolean;
  contextUsed: boolean;
  period: string | null;
  periodLabel: string | null;
  askedFor: string | null;
  numericIntegrity: "verified" | "no_figures" | null;
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

const EXTERNAL_ELIGIBLE_ACTS = new Set<ZeliConversationAct>([
  "greeting",
  "help",
  "thanks",
  "farewell",
  "identity",
  "smalltalk",
  "general_knowledge",
]);

/**
 * Run one user turn. Every query is scoped by the server-resolved identity.
 *
 * Layers:
 *  1. conversation — social acts, clarification and follow-up resolution;
 *  2. business — external tool orchestration when staging/approved policy
 *     allows it, otherwise the local deterministic responder and tools;
 *  3. optional external conversation for non-business acts.
 *
 * The local assistant is always the fallback. When external AI is disabled the
 * whole turn runs inside MaaCash.
 */
export async function runZeliTurn(params: {
  identity: ZeliIdentity;
  conversationId: string;
  question: string;
}): Promise<ZeliTurnResult> {
  await assertZeliAvailable();
  const question = params.question.trim();
  if (question.length < 1 || question.length > 4000) {
    throw new ZeliUsageError("Enter a question between 1 and 4000 characters.");
  }

  const conversation = await assertConversationOwner(
    params.conversationId,
    params.identity
  );
  await consumeUsage(params.identity);

  const previousMessages = await db.zeliMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { role: true, content: true, toolCalls: true },
  });
  const previousAssistant = [...previousMessages]
    .reverse()
    .find((message) => message.role === "assistant");
  const previousTurn = parsePreviousTurn(previousAssistant?.toolCalls ?? null);

  const resolved = resolveConversationContext({ question, previous: previousTurn });
  const effectiveQuestion = resolved.question;

  await db.zeliMessage.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: question,
    },
  });

  const analyticsAvailable = await hasAnalyticsAccess(params.identity);
  const originalClassified = classifyIntent(question);
  const classified = resolved.usedContext
    ? classifyIntent(effectiveQuestion)
    : originalClassified;

  const instruction = isFinancialInstruction(question);
  const act: ZeliConversationAct | null = instruction
    ? "instruction"
    : resolved.usedContext || classified.intent !== "unsupported"
      ? null
      : classifyConversationAct(question, params.identity.role);

  const conversationPolicy = await getConversationPolicy(
    params.identity.tenantId,
    params.identity.userId
  );
  const teamTesting = conversationPolicy.state === "team_testing";
  const externalAllowed =
    conversationPolicy.state === "approved" ||
    conversationPolicy.state === "synthetic";

  const history = previousMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: message.content,
    }));

  let text = "";
  let sources: ZeliSource[] = [];
  let tools: ZeliToolOutcome[] = [];
  let providerName = "internal";
  let model = "rule-based";
  let intent: string = classified.intent;
  let deterministic = true;
  let conversationMode: "local" | "external" = "local";
  let externalAi = false;
  let period: string | null = classified.period ?? null;
  let periodLabel: string | null = null;
  let askedFor: string | null = null;
  let numericIntegrity: "verified" | "no_figures" | null = null;

  let teamHandled = false;

  if (teamTesting) {
    teamHandled = true;
    intent = "team_testing";
    if (act === "instruction") {
      const local = conversationActAnswer(act, params.identity, {
        externalAiAllowed: true,
      });
      text = local.text;
      sources = local.sources;
      askedFor = local.askedFor;
    } else {
      const external = await generateTeamConversation({
        identity: params.identity,
        message: question,
        history,
      });
      if (external) {
        text = external.text;
        providerName = "deepseek-team-testing";
        model = external.model;
        deterministic = false;
        externalAi = true;
        conversationMode = "external";
      } else {
        text =
          "Team Testing could not reach the DeepSeek API for this turn. No deterministic answer was substituted. Check the provider status and try again.";
        providerName = "team-testing-unavailable";
        model = conversationPolicy.model;
        deterministic = true;
        conversationMode = "local";
        intent = "team_testing_unavailable";
      }
    }
  }

  if (!teamHandled) {
    if (act) {
      intent = act;

    if (act !== "instruction" && EXTERNAL_ELIGIBLE_ACTS.has(act)) {
      const external = await generateExternalConversation({
        identity: params.identity,
        message: question,
        act,
      });
      if (external) {
        text = external.text;
        providerName = external.provider;
        model = external.model;
        deterministic = false;
        externalAi = true;
        conversationMode = "external";
      }
    }

    if (!text) {
      const local = conversationActAnswer(act, params.identity, {
        externalAiAllowed: externalAllowed,
      });
      text = local.text;
      sources = local.sources;
      askedFor = local.askedFor;
      intent = local.intent;
    }
  } else {
    const orchestrated = externalAllowed
      ? await runToolConversation({
          identity: params.identity,
          question: effectiveQuestion,
          history,
          policy: conversationPolicy,
          forceTool: classified.intent !== "unsupported",
        })
      : null;

    if (orchestrated) {
      text = orchestrated.text;
      tools = orchestrated.tools;
      sources = orchestrated.sources;
      providerName = orchestrated.provider;
      model = orchestrated.model;
      deterministic = false;
      externalAi = true;
      conversationMode = "external";
      periodLabel = orchestrated.periodLabel;
      numericIntegrity = orchestrated.numericIntegrity;
      if (classified.intent !== "unsupported") {
        period = classified.period ?? "this_month";
      }
    } else {
      const analyticAnswer =
        params.identity.role === "admin"
          ? await answerAdminBusinessQuestion({
              identity: params.identity,
              question: effectiveQuestion,
              analyticsAvailable,
            })
          : null;

      if (analyticAnswer) {
        text = analyticAnswer.text;
        sources = analyticAnswer.sources;
        intent = analyticAnswer.intent;
        period = classified.period ?? "this_month";
        periodLabel = analyticAnswer.period ?? null;
        deterministic = true;
      } else if (
        params.identity.role === "admin" &&
        (classified.intent === "unsupported" ||
          classified.intent === "customer_lookup" ||
          classified.intent === "daily_accounts")
      ) {
        if (classified.intent !== "unsupported") {
          const context = await buildZeliContext(params.identity, effectiveQuestion);
          tools = context.tools;
          sources = sourcesFor(context.tools);
          const provider = getZeliProvider();
          try {
            const response = await provider.generate({
              system: "server-controlled",
              question: effectiveQuestion,
              history,
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
          const ambiguity = detectAmbiguity(effectiveQuestion);
          if (ambiguity) {
            const clarification = clarificationAnswer(params.identity, ambiguity.reason);
            text = clarification.text;
            sources = clarification.sources;
            intent = clarification.intent;
            askedFor = clarification.askedFor;
          } else {
            const unsupported = unsupportedAnswer(analyticsAvailable);
            text = unsupported.text;
            sources = unsupported.sources;
            intent = unsupported.intent;
          }
        }
      } else if (
        params.identity.role !== "admin" &&
        !isSupportedForRole(params.identity.role, effectiveQuestion)
      ) {
        const ambiguity = detectAmbiguity(effectiveQuestion);
        if (ambiguity) {
          const clarification = clarificationAnswer(params.identity, ambiguity.reason);
          text = clarification.text;
          sources = clarification.sources;
          intent = clarification.intent;
          askedFor = clarification.askedFor;
        } else {
          const unsupported = unsupportedAnswer(analyticsAvailable);
          text = unsupported.text;
          sources = unsupported.sources;
          intent = unsupported.intent;
        }
      } else {
        const context = await buildZeliContext(params.identity, effectiveQuestion);
        tools = context.tools;
        sources = sourcesFor(context.tools);
        const provider = getZeliProvider();
        try {
          const response = await provider.generate({
            system: "server-controlled",
            question: effectiveQuestion,
            history,
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
    }
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
        category: externalAi ? "external_conversational" : "server_computed",
        conversationMode,
        period,
        periodLabel,
        askedFor,
        numericIntegrity,
        contextUsed: resolved.usedContext,
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
    conversationMode,
    externalAi,
    contextUsed: resolved.usedContext,
    period,
    periodLabel,
    askedFor,
    numericIntegrity,
  };
}
