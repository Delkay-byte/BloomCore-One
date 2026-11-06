import { classifyIntent, type ZeliIntent } from "../intelligence/intents";
import type { PeriodPreset } from "../intelligence/period";

/**
 * Conversation-context resolution for follow-up questions.
 *
 * The local engine is stateless per turn. To understand "And last month?" it
 * reads the previous assistant turn's stored context (intent, period and any
 * clarification the assistant asked for) and rewrites the follow-up into a
 * complete, classifiable question.
 *
 * Only business context is inherited. Social turns, refusals and clarification
 * answers are not silently reused as financial context.
 */

export interface ZeliPreviousTurn {
  intent: string;
  period: string | null;
  askedFor: string | null;
}

export function parsePreviousTurn(raw: string | null): ZeliPreviousTurn | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.intent !== "string") return null;
    return {
      intent: parsed.intent,
      period: typeof parsed.period === "string" ? parsed.period : null,
      askedFor: typeof parsed.askedFor === "string" ? parsed.askedFor : null,
    };
  } catch {
    return null;
  }
}

const BUSINESS_INTENTS = new Set<string>([
  "business_summary",
  "compare_periods",
  "contributions_withdrawals",
  "income_expenses",
  "remittances",
  "exceptions",
  "branches",
  "chart_explanation",
  "metric_definition",
  "why_changed",
  "customer_lookup",
  "daily_accounts",
]);

export function isBusinessIntent(intent: string): boolean {
  return BUSINESS_INTENTS.has(intent);
}

const PERIOD_PHRASE: Record<PeriodPreset, string | null> = {
  today: "today",
  yesterday: "yesterday",
  this_week: "this week",
  previous_week: "last week",
  this_month: "this month",
  previous_month: "last month",
  this_quarter: "this quarter",
  custom: null,
};

const VERB_PHRASE: Record<string, string> = {
  business_summary: "summarise business activity",
  compare_periods: "compare this month with last month",
  contributions_withdrawals: "summarise contributions and withdrawals",
  income_expenses: "summarise income and expenses",
  remittances: "summarise remittance variance",
  exceptions: "show operational exceptions",
  branches: "compare branch performance",
  chart_explanation: "explain the contributions and withdrawals chart",
  metric_definition: "explain how net cash flow is calculated",
  why_changed: "explain why contributions changed",
  customer_lookup: "find customer",
  daily_accounts: "show daily account status",
};

const NOUN_PHRASE: Record<string, string> = {
  business_summary: "business activity",
  compare_periods: "this period versus the previous period",
  contributions_withdrawals: "contributions and withdrawals",
  income_expenses: "income and expenses",
  remittances: "remittance variance",
  exceptions: "operational exceptions",
  branches: "branch performance",
  chart_explanation: "the contributions and withdrawals chart",
  metric_definition: "the net cash flow calculation",
  why_changed: "the contribution change",
  daily_accounts: "daily account status",
};

function periodPhrase(period: string | null): string | null {
  if (!period) return null;
  if (period in PERIOD_PHRASE) return PERIOD_PHRASE[period as PeriodPreset];
  return null;
}

/** Map any business topic mentioned in the follow-up to a full question. */
function topicPhrase(text: string): string | null {
  if (/\bbranch(es)?\b/.test(text)) return "compare branch performance";
  if (/\b(income|expenses?|spending|profit|loss|p&l)\b/.test(text)) {
    return "summarise income and expenses";
  }
  if (/\b(remit|remittance|handed in|handover|variance)\b/.test(text)) {
    return "summarise remittance variance";
  }
  if (/\b(exception|outstanding|needs? attention|pending withdrawal|overdue|discrepanc)\b/.test(text)) {
    return "show operational exceptions";
  }
  if (/\b(daily account|cash variance|momo variance)\b/.test(text)) {
    return "show daily account status";
  }
  if (/\b(contribut|saving|paid in|collection|deposit|withdraw|payout)\b/.test(text)) {
    return "summarise contributions and withdrawals";
  }
  if (/\b(customer|account id|account number)\b/.test(text)) return "find customer";
  if (/\b(summary|summarise|summarize|overview|activity|business)\b/.test(text)) {
    return "summarise business activity";
  }
  return null;
}

const CLARIFICATION_TOPICS: Array<[RegExp, string]> = [
  [/^(both|contributions? and withdrawals?|contributions?|withdrawals?|savings?)$/, "summarise contributions and withdrawals"],
  [/^(income and expenses?|income|expenses?|p&l|profit and loss)$/, "summarise income and expenses"],
  [/^(remittances?|variance|handover|handed in)$/, "summarise remittance variance"],
  [/^(exceptions?|problems?|issues?|outstanding|pending)$/, "show operational exceptions"],
  [/^(branches?|branch|branch comparison)$/, "compare branch performance"],
  [/^(period|comparison|compare|period comparison)$/, "compare this month with last month"],
  [/^(summary|overview|business|activity)$/, "summarise business activity"],
];

function clarificationTopic(text: string): string | null {
  const cleaned = text.replace(/[.?!]/g, "").trim();
  for (const [pattern, phrase] of CLARIFICATION_TOPICS) {
    if (pattern.test(cleaned)) return phrase;
  }
  return null;
}

export interface FollowUpResolution {
  question: string;
  usedContext: boolean;
  inheritedIntent: string | null;
}

const FOLLOW_UP_OPENER =
  /^(and|what about|how about|same for|now|then|also|why|how come|tell me more|more detail|go deeper|explain|compare that|compare it|compare this)\b/;

const PERIOD_STRIP =
  /\b(today|yesterday|this week|last week|previous week|past week|this month|last month|previous month|past month|this quarter|last quarter|previous quarter)\b/g;

/** True when the message contains nothing but an opener and a period. */
function isPeriodOnly(text: string): boolean {
  const remainder = text
    .replace(FOLLOW_UP_OPENER, "")
    .replace(PERIOD_STRIP, "")
    .replace(/[?.!,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return remainder.length === 0;
}

/**
 * Rewrite a follow-up into a complete question when the previous turn supplies
 * the missing subject or period. Returns the original text untouched when the
 * message already stands alone.
 */
export function resolveConversationContext(params: {
  question: string;
  previous: ZeliPreviousTurn | null;
}): FollowUpResolution {
  const question = params.question.trim();
  const text = question
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
  const unchanged: FollowUpResolution = {
    question,
    usedContext: false,
    inheritedIntent: null,
  };

  const previous = params.previous;
  if (!previous) return unchanged;

  const current = classifyIntent(question);
  const hasOpener = FOLLOW_UP_OPENER.test(text);

  // A pending clarification takes priority: the user is answering our question.
  // A full, explicit business question is never overridden.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (
    previous.askedFor === "business_topic" &&
    (current.intent === "unsupported" || wordCount <= 4)
  ) {
    const topic = clarificationTopic(text) ?? topicPhrase(text);
    if (topic) {
      const period = periodPhrase(current.period) ?? periodPhrase(previous.period);
      return {
        question: period ? `${topic} ${period}` : topic,
        usedContext: true,
        inheritedIntent: previous.intent,
      };
    }
    return unchanged;
  }

  if (current.intent !== "unsupported" && !hasOpener) return unchanged;

  if (!isBusinessIntent(previous.intent)) return unchanged;

  const period = periodPhrase(current.period) ?? periodPhrase(previous.period);
  const topic = topicPhrase(text);

  if (topic) {
    return {
      question: period ? `${topic} ${period}` : topic,
      usedContext: true,
      inheritedIntent: previous.intent,
    };
  }

  if (/^(why|how come)(\s+(did|does|has|have|is|are|was|were)\s+(that|this|it|they|those))?\s*\??$/.test(text)) {
    const noun = NOUN_PHRASE[previous.intent] ?? "the figure";
    return {
      question: `explain why ${noun} changed ${period ?? ""}`.trim(),
      usedContext: true,
      inheritedIntent: previous.intent,
    };
  }

  if (
    /^(compare|now compare)(\s+(that|it|this|them|those))?(\s+(to|with)\s+(last|this|the previous)\s+(week|month|quarter))?\s*\??$/.test(
      text
    )
  ) {
    return {
      question: `compare this month with last month ${period && period !== "this month" ? period : ""}`.trim(),
      usedContext: true,
      inheritedIntent: previous.intent,
    };
  }

  if (
    /^(can you )?(put|say|explain|rephrase) (that|this|it)( in)? (simpler|simple|plain)( terms| language)?\s*\??$/.test(
      text
    ) ||
    /^(rephrase|simplify)( that| this| it)?\s*\??$/.test(text)
  ) {
    const verb = VERB_PHRASE[previous.intent] ?? "summarise business activity";
    return {
      question: `${verb} in simple terms ${period ?? ""}`.trim(),
      usedContext: true,
      inheritedIntent: previous.intent,
    };
  }

  if (
    /^(tell me more|more details?|go deeper|explain|explain that|explain this|summari[sz]e (that|this|it)|sum (that|it) up)\s*\??$/.test(
      text
    )
  ) {
    const verb = VERB_PHRASE[previous.intent] ?? "summarise business activity";
    return {
      question: `${verb} with more detail ${period ?? ""}`.trim(),
      usedContext: true,
      inheritedIntent: previous.intent,
    };
  }

  // Period-only follow-up ("and last month?", "this week?").
  if (period && isPeriodOnly(text)) {
    const verb = VERB_PHRASE[previous.intent] ?? "summarise business activity";
    return {
      question: `${verb} ${period}`.trim(),
      usedContext: true,
      inheritedIntent: previous.intent,
    };
  }

  // "And the withdrawals?" or "what about customers?" with no explicit topic
  // phrase falls back to the previous subject with the current period.
  if (hasOpener) {
    const remainder = text.replace(
      /^(and|what about|how about|same for|now|then|also)\b/,
      ""
    ).trim();
    const remainderTopic = topicPhrase(remainder) ?? clarificationTopic(remainder);
    if (remainderTopic) {
      return {
        question: period ? `${remainderTopic} ${period}` : remainderTopic,
        usedContext: true,
        inheritedIntent: previous.intent,
      };
    }
  }

  return unchanged;
}

export type { ZeliIntent };
