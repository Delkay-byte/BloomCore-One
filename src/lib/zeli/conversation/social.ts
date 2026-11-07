import type { ZeliIdentity, ZeliSource } from "../types";
import type { ZeliConversationAct } from "./acts";

/**
 * Local answers for conversational acts.
 *
 * These are hand-written deterministic responses, not model output. The text
 * says so plainly and never claims access to records it did not read.
 */

export interface ConversationActAnswer {
  text: string;
  sources: ZeliSource[];
  intent: string;
  askedFor: string | null;
}

const ADMIN_CAPABILITIES = [
  "summarise business activity for a period",
  "compare one period with another",
  "report contributions, withdrawals, income and expenses",
  "report remittances and handover variance",
  "list outstanding operational exceptions",
  "compare branch performance",
  "explain how a reported metric is calculated",
  "find a customer or account you are authorized to see",
  "describe today's daily-account status",
];

function capabilitiesFor(role: ZeliIdentity["role"]): string[] {
  switch (role) {
    case "worker":
      return [
        "describe today's daily account and its submission status",
        "explain the MoMo and cash variance on your latest account",
        "find a customer or account id you need to reference",
        "show what your role is allowed to see",
      ];
    case "collector":
      return [
        "count the customers assigned to you",
        "summarise what you collected and handed in today",
        "show the variance on your handover",
        "find a customer by name or account id",
      ];
    case "customer":
      return [
        "summarise your own savings account and active cycle",
        "show how much you have contributed in this cycle",
        "explain how to request a withdrawal through the app",
        "show the status of your account",
      ];
    default:
      return ADMIN_CAPABILITIES;
  }
}

function bulletList(items: string[]): string {
  return items.map((item) => `• ${item}`).join("\n");
}

const SOURCES_BY_ROLE: Record<ZeliIdentity["role"], ZeliSource[]> = {
  admin: [
    { label: "Business dashboard", href: "/admin/dashboard" },
    { label: "Susu reports", href: "/susu/admin/reports" },
  ],
  worker: [{ label: "Worker dashboard", href: "/worker/dashboard" }],
  collector: [{ label: "Collector dashboard", href: "/collector/dashboard" }],
  customer: [{ label: "Your dashboard", href: "/customer/dashboard" }],
};

const ACTION_SOURCE: Record<ZeliIdentity["role"], ZeliSource> = {
  admin: { label: "Money & History", href: "/admin/history" },
  worker: { label: "Worker dashboard", href: "/worker/dashboard" },
  collector: { label: "Collector dashboard", href: "/collector/dashboard" },
  customer: { label: "Your dashboard", href: "/customer/dashboard" },
};

const ENGINE_NOTE =
  "I run on MaaCash's internal rule-based engine, not an external language model.";

function greeting(identity: ZeliIdentity): ConversationActAnswer {
  const capabilities = capabilitiesFor(identity.role);
  return {
    text: [
      "Hello. I'm Zeli, MaaCash's business assistant.",
      "",
      ENGINE_NOTE +
        " I read only the records your role is authorized to see, and every figure I report is calculated from those records.",
      "",
      "I can help you:",
      bulletList(capabilities),
      "",
      "Ask in your own words, or tap one of the suggested questions to start.",
    ].join("\n"),
    sources: SOURCES_BY_ROLE[identity.role],
    intent: "greeting",
    askedFor: null,
  };
}

function help(identity: ZeliIdentity): ConversationActAnswer {
  return {
    text: [
      "Here is what I can do in this workspace.",
      "",
      bulletList(capabilitiesFor(identity.role)),
      "",
      "How I work:",
      "• I answer from your authorized MaaCash records using the internal rule-based engine.",
      "• I always state the period and source for financial answers.",
      "• I am read-only. I cannot post, reverse, approve or refund anything.",
      "• If a question is outside my supported set, I say so instead of guessing.",
      "",
      "Try: “Summarise this month's contributions and withdrawals.” Then follow up with “And last month?”",
    ].join("\n"),
    sources: SOURCES_BY_ROLE[identity.role],
    intent: "help",
    askedFor: null,
  };
}

export function conversationActAnswer(
  act: ZeliConversationAct,
  identity: ZeliIdentity,
  options: { externalAiAllowed: boolean } = { externalAiAllowed: false }
): ConversationActAnswer {
  switch (act) {
    case "greeting":
      return greeting(identity);
    case "help":
      return help(identity);
    case "thanks":
      return {
        text: "You're welcome. Ask another question whenever you need it.",
        sources: SOURCES_BY_ROLE[identity.role],
        intent: "thanks",
        askedFor: null,
      };
    case "farewell":
      return {
        text: "Goodbye. This conversation stays saved in your workspace until you delete it.",
        sources: [],
        intent: "farewell",
        askedFor: null,
      };
    case "identity":
      return {
        text: [
          "I'm Zeli, the assistant built into MaaCash.",
          "",
          ENGINE_NOTE +
            " I don't browse the web, and I don't send your messages to an external AI unless an approved external mode is enabled for your business.",
          "",
          "I can answer questions about your authorized business records, explain how figures are calculated, and point you to the right screen for an action.",
        ].join("\n"),
        sources: SOURCES_BY_ROLE[identity.role],
        intent: "identity",
        askedFor: null,
      };
    case "smalltalk":
      return {
        text: "I'm here and ready. Ask me about your business records whenever you like — for example, “Summarise today's activity.”",
        sources: SOURCES_BY_ROLE[identity.role],
        intent: "smalltalk",
        askedFor: null,
      };
    case "instruction":
      return {
        text: [
          "I can't do that. Zeli is read-only and cannot post, approve, reverse, refund or change financial records.",
          "",
          "No data was changed by this message.",
          "",
          "Use the authorized screen to carry out the action, where your normal permissions and audit trail apply:",
          `• ${ACTION_SOURCE[identity.role].label}: ${ACTION_SOURCE[identity.role].href}`,
          "",
          "If you want to understand a figure first, ask me to summarise it.",
        ].join("\n"),
        sources: [ACTION_SOURCE[identity.role]],
        intent: "instruction",
        askedFor: null,
      };
    case "general_knowledge":
      return {
        text: [
          options.externalAiAllowed
            ? "I could not use the external conversational provider for that question, so I am answering in local mode."
            : "I can't answer general knowledge questions in local mode. External AI processing is not enabled for this workspace, so I won't send your message to an external provider.",
          "",
          "I can still answer questions about your authorized business records:",
          bulletList(capabilitiesFor(identity.role)),
          "",
          "If you need general research, use an approved external tool. Nothing from this conversation was sent anywhere.",
        ].join("\n"),
        sources: SOURCES_BY_ROLE[identity.role],
        intent: "general_knowledge",
        askedFor: null,
      };
    default:
      return help(identity);
  }
}

export function clarificationAnswer(
  identity: ZeliIdentity,
  reason: string
): ConversationActAnswer {
  return {
    text: [
      `I can help with that, but I need one more detail. ${reason}`,
      "",
      "Choose one:",
      "• contributions and withdrawals",
      "• remittances and handover variance",
      "• outstanding operational exceptions",
      "• a branch comparison",
      "• a period comparison (for example, this month versus last month)",
      "",
      "You can also name a customer, an account id or a daily account.",
    ].join("\n"),
    sources: SOURCES_BY_ROLE[identity.role],
    intent: "clarification",
    askedFor: "business_topic",
  };
}

export function engineDisclosure(external: boolean): string {
  return external
    ? "This answer was produced by an approved external AI provider. It contains no business figures. Business facts are only ever answered locally from your records."
    : ENGINE_NOTE + " No external AI provider was called.";
}
