import { db } from "@/lib/db";
import type { ZeliIdentity } from "../types";
import {
  buildAnalyticsSnapshot,
  type AnalyticsFilters,
  type AnalyticsSnapshot,
} from "./metrics";
import {
  composeBranches,
  composeContributions,
  composeExceptions,
  composeOverview,
  composeRemittances,
  explainChart,
  explainMetricDefinition,
  isExplainableChart,
  type ComposedAnswer,
} from "./compose";
import { classifyIntent, type ClassifiedIntent } from "./intents";
import { enhanceWithProvider } from "../provider-reasoning";

/**
 * Providerless responder for the business-administrator Zeli workspace.
 *
 * The answer is composed from a server-computed snapshot. No network call is
 * made and no provider is selected. Unsupported questions receive a limitation
 * message instead of a fabricated answer.
 */

export interface ZeliAnswerSource {
  label: string;
  href?: string;
  detail?: string;
}

export interface ZeliStructuredAnswer {
  text: string;
  sources: ZeliAnswerSource[];
  intent: ClassifiedIntent["intent"];
  focus: string | null;
  period: string | null;
  freshness: string | null;
  deterministic: true;
  provider: "internal";
  model: "rule-based";
  statements: ComposedAnswer["statements"] | null;
  limitations: string[];
}

export const SUPPORTED_QUESTIONS = [
  "Summarise today's activity.",
  "Compare this month with last month.",
  "Summarise contributions and withdrawals.",
  "Summarise remittance activity.",
  "Show outstanding operational exceptions.",
  "Compare branch performance.",
  "Explain why a figure changed.",
  "Explain how a reported metric is calculated.",
  "Find an authorized customer or account.",
];

export function unsupportedAnswer(analyticsAvailable: boolean): ZeliStructuredAnswer {
  const text = [
    "[AUTOMATED INTERPRETATION] This request is outside the set of business questions that Zeli can answer from your authorized records without an external AI provider.",
    "",
    "Zeli can currently answer:",
    ...SUPPORTED_QUESTIONS.map((question) => `• ${question}`),
    "",
    analyticsAvailable
      ? "Open Zeli Business Intelligence to choose a report, period and branch filter. Zeli will not invent an answer for an unsupported question."
      : "Choose one of the supported questions, or open the matching report. Zeli will not invent an answer for an unsupported question.",
  ].join("\n");
  return {
    text,
    sources: [
      { label: "Susu reports", href: "/susu/admin/reports" },
      { label: "Money & History", href: "/admin/history" },
    ],
    intent: "unsupported",
    focus: null,
    period: null,
    freshness: null,
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    statements: null,
    limitations: [
      "Only the listed intents are supported. Free-form reasoning requires an approved external provider, which is disabled.",
    ],
  };
}

function filtersFor(
  intent: ClassifiedIntent,
  locations: Array<{ id: string; name: string; code: string }>,
  question: string
): AnalyticsFilters {
  const text = question.toLowerCase();
  const matched = locations.find((location) => {
    const name = location.name.toLowerCase();
    if (name.length >= 3 && text.includes(name)) return true;
    const code = location.code.toLowerCase();
    return code.length >= 2 && new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  });
  return {
    period: intent.period ?? "this_month",
    locationId: matched?.id,
  };
}

function sourcesForIntent(intent: ClassifiedIntent["intent"], snapshot: AnalyticsSnapshot | null): ZeliAnswerSource[] {
  const analytics = snapshot
    ? `/admin/zeli-analytics?period=${snapshot.filters.period}${
        snapshot.filters.locationId ? `&location=${snapshot.filters.locationId}` : ""
      }`
    : "/admin/zeli-analytics";
  switch (intent) {
    case "contributions_withdrawals":
      return [
        { label: "Contributions report", href: "/susu/admin/contributions" },
        { label: "Withdrawals report", href: "/susu/admin/withdrawals" },
        { label: "Zeli Business Intelligence", href: analytics },
      ];
    case "remittances":
      return [
        { label: "Money Handed In", href: "/susu/admin/remittances" },
        { label: "Zeli Business Intelligence", href: analytics },
      ];
    case "exceptions":
      return [
        { label: "Money & History", href: "/admin/history" },
        { label: "Withdrawals", href: "/susu/admin/withdrawals" },
        { label: "Zeli Business Intelligence", href: analytics },
      ];
    case "branches":
      return [
        { label: "Susu reports", href: "/susu/admin/reports" },
        { label: "Zeli Business Intelligence", href: analytics },
      ];
    default:
      return [
        { label: "Business dashboard", href: "/admin/dashboard" },
        { label: "Susu reports", href: "/susu/admin/reports" },
        { label: "Zeli Business Intelligence", href: analytics },
      ];
  }
}

/**
 * Answer a supported administrator question. Returns null when the intent
 * needs the normal tool-based path (customer lookup, daily accounts) or is not
 * supported at all; the caller handles those cases.
 */
export async function answerAdminBusinessQuestion(params: {
  identity: ZeliIdentity;
  question: string;
  analyticsAvailable: boolean;
}): Promise<ZeliStructuredAnswer | null> {
  if (params.identity.role !== "admin" || !params.identity.tenantId) return null;
  const classified = classifyIntent(params.question);
  if (
    classified.intent === "unsupported" ||
    classified.intent === "customer_lookup" ||
    classified.intent === "daily_accounts"
  ) {
    return null;
  }

  if (classified.intent === "metric_definition") {
    const answer = explainMetricDefinition(params.question);
    if (!answer) return unsupportedAnswer(params.analyticsAvailable);
    return {
      text: answer.text,
      sources: [
        { label: "Susu reports", href: "/susu/admin/reports" },
        { label: "Zeli Business Intelligence", href: "/admin/zeli-analytics" },
      ],
      intent: classified.intent,
      focus: answer.focus,
      period: answer.period,
      freshness: answer.freshness,
      deterministic: true,
      provider: "internal",
      model: "rule-based",
      statements: answer.statements,
      limitations: answer.limitations,
    };
  }

  const tenant = await db.businessTenant.findUnique({
    where: { id: params.identity.tenantId },
    select: { id: true, name: true, code: true, status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    return {
      text:
        "[AUTOMATED INTERPRETATION] The business record is not currently available, so Zeli cannot read financial records. No data was changed.",
      sources: [],
      intent: classified.intent,
      focus: null,
      period: null,
      freshness: null,
      deterministic: true,
      provider: "internal",
      model: "rule-based",
      statements: null,
      limitations: ["The tenant must be ACTIVE."],
    };
  }

  const locations = await db.location.findMany({
    where: { tenantId: tenant.id, status: "active" },
    select: { id: true, name: true, code: true },
    take: 100,
  });

  let snapshot: AnalyticsSnapshot;
  try {
    snapshot = await buildAnalyticsSnapshot({
      tenant: { id: tenant.id, name: tenant.name, code: tenant.code },
      filters: filtersFor(classified, locations, params.question),
    });
  } catch (error) {
    return {
      text:
        "[AUTOMATED INTERPRETATION] Zeli could not read the financial records for that request. No business data was changed. Open the matching report or try a narrower question.",
      sources: [{ label: "Susu reports", href: "/susu/admin/reports" }],
      intent: classified.intent,
      focus: null,
      period: null,
      freshness: null,
      deterministic: true,
      provider: "internal",
      model: "rule-based",
      statements: null,
      limitations: [
        error instanceof Error ? error.message : "The analytics query failed.",
      ],
    };
  }

  let answer: ComposedAnswer;
  switch (classified.intent) {
    case "contributions_withdrawals":
      answer = composeContributions(snapshot);
      break;
    case "remittances":
      answer = composeRemittances(snapshot);
      break;
    case "exceptions":
      answer = composeExceptions(snapshot);
      break;
    case "branches":
      answer = composeBranches(snapshot);
      break;
    case "chart_explanation":
      answer = explainChart(
        snapshot,
        classified.chartId && isExplainableChart(classified.chartId)
          ? classified.chartId
          : "contributions_vs_withdrawals"
      );
      break;
    case "why_changed":
      answer = composeOverview(snapshot);
      break;
    case "compare_periods":
    case "business_summary":
    default:
      answer = composeOverview(snapshot);
      break;
  }

  const enhancement = await enhanceWithProvider({
    identity: params.identity,
    intent: classified.intent,
    snapshot,
    localAnswer: answer,
  });
  const externalText = enhancement.used ? `

${enhancement.text}` : "";
  const sources = sourcesForIntent(classified.intent, snapshot);
  return {
    text: `${answer.text}${externalText}\n\n[PERIOD] ${answer.period} · [SOURCE] ${answer.source} · [FRESHNESS] ${answer.freshness}\n\n[LIMITATIONS] ${answer.limitations.join(" ")}`,
    sources,
    intent: classified.intent,
    focus: answer.focus,
    period: answer.period,
    freshness: answer.freshness,
    deterministic: true,
    provider: "internal",
    model: "rule-based",
    statements: answer.statements,
    limitations: answer.limitations,
  };
}
