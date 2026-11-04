import { z } from "zod";
import { db } from "@/lib/db";
import type { ZeliIdentity, ZeliSource, ZeliToolOutcome } from "./types";
import {
  buildAnalyticsSnapshot,
  type AnalyticsSnapshot,
} from "./intelligence/metrics";
import {
  composeBranches,
  composeContributions,
  composeExceptions,
  composeIncomeExpenses,
  composeOverview,
  composeRemittances,
  explainMetricDefinition,
  type ComposedAnswer,
} from "./intelligence/compose";
import { PERIOD_PRESETS, type PeriodPreset } from "./intelligence/period";
import {
  customerLookup,
  collectorSummary,
  dailyAccountSummary,
  customerAccountSummary,
} from "./tools";

/**
 * Read-only business tools exposed to the external conversational model.
 *
 * The model may choose a tool name and arguments. The server validates both,
 * resolves the tenant and role from the authenticated identity, and runs the
 * existing domain services. The model never receives database access, arbitrary
 * query capability or any write operation.
 */

export const BUSINESS_TOOL_NAMES = [
  "business_summary",
  "contributions_withdrawals",
  "income_expenses",
  "remittances",
  "exceptions",
  "branch_comparison",
  "period_comparison",
  "metric_definition",
  "customer_lookup",
  "daily_accounts",
  "customer_account_summary",
] as const;

export type BusinessToolName = (typeof BUSINESS_TOOL_NAMES)[number];

const PERIOD_VALUES = PERIOD_PRESETS.filter((preset) => preset !== "custom") as Exclude<
  PeriodPreset,
  "custom"
>[];

const periodArgs = z
  .object({
    period: z.enum(PERIOD_VALUES as [string, ...string[]]).optional(),
    branch: z.string().min(1).max(80).optional(),
  })
  .strict();

const lookupArgs = z.object({ query: z.string().min(1).max(80) }).strict();
const metricArgs = z.object({ metric: z.string().min(1).max(80) }).strict();

export interface BusinessToolDefinition {
  name: BusinessToolName;
  description: string;
  parameters: Record<string, unknown>;
  roles: ZeliIdentity["role"][];
}

const PERIOD_SCHEMA = {
  type: "string",
  enum: PERIOD_VALUES,
  description:
    "Reporting period. Use previous_month for last month, this_month for month-to-date, previous_week for last week.",
};

const BRANCH_SCHEMA = {
  type: "string",
  description: "Optional branch name or code exactly as it appears in the business records.",
};

const PERIOD_TOOL_PARAMETERS = {
  type: "object",
  properties: { period: PERIOD_SCHEMA, branch: BRANCH_SCHEMA },
  additionalProperties: false,
};

export const BUSINESS_TOOLS: BusinessToolDefinition[] = [
  {
    name: "business_summary",
    description:
      "Business overview for a period: contributions, withdrawals, remittances, expenses, net cash flow and comparison with the previous period.",
    parameters: PERIOD_TOOL_PARAMETERS,
    roles: ["admin"],
  },
  {
    name: "contributions_withdrawals",
    description:
      "Contributions and withdrawals for a period, with previous-period comparison and contributing accounts.",
    parameters: PERIOD_TOOL_PARAMETERS,
    roles: ["admin"],
  },
  {
    name: "income_expenses",
    description:
      "Recorded cash income and expenses for a period, with net cash flow and previous-period comparison.",
    parameters: PERIOD_TOOL_PARAMETERS,
    roles: ["admin"],
  },
  {
    name: "remittances",
    description:
      "Remittances, expected versus remitted amounts and variance for a period.",
    parameters: PERIOD_TOOL_PARAMETERS,
    roles: ["admin"],
  },
  {
    name: "exceptions",
    description:
      "Outstanding operational exceptions: pending withdrawals, remittance discrepancies, daily accounts awaiting review and collectors without remittance.",
    parameters: PERIOD_TOOL_PARAMETERS,
    roles: ["admin"],
  },
  {
    name: "branch_comparison",
    description: "Contribution, withdrawal, net cash flow and activity by branch for a period.",
    parameters: PERIOD_TOOL_PARAMETERS,
    roles: ["admin"],
  },
  {
    name: "period_comparison",
    description:
      "Compare the selected period with the previous period across contributions, withdrawals, expenses, net cash flow and transaction volume.",
    parameters: PERIOD_TOOL_PARAMETERS,
    roles: ["admin"],
  },
  {
    name: "metric_definition",
    description:
      "Explain how a BloomCore One metric is calculated. Use for questions about definitions or calculations.",
    parameters: {
      type: "object",
      properties: { metric: { type: "string", description: "Metric name, for example net cash flow." } },
      required: ["metric"],
      additionalProperties: false,
    },
    roles: ["admin", "worker", "collector", "customer"],
  },
  {
    name: "customer_lookup",
    description:
      "Find authorized customers or accounts by name, customer id, account id or phone.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Name, id or phone fragment." } },
      required: ["query"],
      additionalProperties: false,
    },
    roles: ["admin", "collector", "worker"],
  },
  {
    name: "daily_accounts",
    description:
      "Daily account status and MoMo/cash variance for today, scoped to the signed-in worker or the tenant.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    roles: ["admin", "worker"],
  },
  {
    name: "customer_account_summary",
    description: "The signed-in customer's own accounts, active cycle and contribution totals.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    roles: ["customer"],
  },
];

export function toolsForRole(role: ZeliIdentity["role"]): BusinessToolDefinition[] {
  return BUSINESS_TOOLS.filter((tool) => tool.roles.includes(role));
}

export function toolDefinitionsPayload(role: ZeliIdentity["role"]) {
  return toolsForRole(role).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export interface BusinessToolResult {
  tool: BusinessToolName;
  ok: boolean;
  /** Structured facts returned to the model. Never raw database rows. */
  facts: Record<string, unknown>;
  /** Authoritative local text, appended to the final answer. */
  authoritativeText: string;
  sources: ZeliSource[];
  outcome: ZeliToolOutcome;
  error?: string;
}

function snapshotFacts(snapshot: AnalyticsSnapshot) {
  return {
    period: snapshot.period.label,
    previousPeriod: snapshot.previousPeriod.label,
    source: snapshot.freshness.source,
    freshness: snapshot.freshness.refreshedAt,
    totals: snapshot.totals,
    previousTotals: snapshot.previousTotals,
    comparison: snapshot.comparison,
    changes: {
      contributions: roundDiff(
        snapshot.totals.contributions,
        snapshot.previousTotals.contributions
      ),
      withdrawals: roundDiff(snapshot.totals.withdrawals, snapshot.previousTotals.withdrawals),
      remittances: roundDiff(snapshot.totals.remittances, snapshot.previousTotals.remittances),
      expenses: roundDiff(snapshot.totals.expenses, snapshot.previousTotals.expenses),
      cashIncome: roundDiff(snapshot.totals.cashIncome, snapshot.previousTotals.cashIncome),
      netCashFlow: roundDiff(snapshot.totals.netCashFlow, snapshot.previousTotals.netCashFlow),
      transactionCount: snapshot.totals.transactionCount - snapshot.previousTotals.transactionCount,
    },
    exceptions: snapshot.exceptions,
  };
}

function roundDiff(current: number, previous: number): number {
  return Math.round((current - previous) * 100) / 100;
}

function composedResult(
  name: BusinessToolName,
  composed: ComposedAnswer,
  facts: Record<string, unknown>,
  sources: ZeliSource[]
): BusinessToolResult {
  const summary: ZeliToolOutcome = {
    tool: name,
    ok: true,
    summary: JSON.stringify(facts),
    sources,
    durationMs: 0,
  };
  return {
    tool: name,
    ok: true,
    facts,
    authoritativeText: composed.text,
    sources,
    outcome: summary,
  };
}

function failure(
  name: BusinessToolName,
  error: string,
  facts: Record<string, unknown> = {}
): BusinessToolResult {
  return {
    tool: name,
    ok: false,
    facts,
    authoritativeText: "",
    sources: [],
    error,
    outcome: {
      tool: name,
      ok: false,
      summary: JSON.stringify({ error }),
      sources: [],
      durationMs: 0,
    },
  };
}

async function resolveTenant(identity: ZeliIdentity) {
  if (!identity.tenantId) return null;
  return db.businessTenant.findUnique({
    where: { id: identity.tenantId },
    select: { id: true, name: true, code: true, status: true },
  });
}

async function resolveBranch(tenantId: string, branch?: string) {
  if (!branch) return { locationId: null as string | null };
  const locations = await db.location.findMany({
    where: { tenantId, status: "active" },
    select: { id: true, name: true, code: true },
    take: 100,
  });
  const needle = branch.trim().toLowerCase();
  const match = locations.find(
    (location) =>
      location.name.toLowerCase() === needle || location.code.toLowerCase() === needle
  );
  if (!match) {
    return {
      locationId: null,
      error: `Unknown branch. Available branches: ${locations.map((l) => l.name).join(", ")}`,
    };
  }
  return { locationId: match.id };
}

async function analyticsTool(
  identity: ZeliIdentity,
  name: BusinessToolName,
  args: z.infer<typeof periodArgs>
): Promise<BusinessToolResult> {
  if (identity.role !== "admin") return failure(name, "not_permitted");
  const tenant = await resolveTenant(identity);
  if (!tenant || tenant.status !== "ACTIVE") {
    return failure(name, "business_unavailable");
  }
  const branch = await resolveBranch(tenant.id, args.branch);
  if (branch.error) return failure(name, branch.error, { availableBranches: branch.error });

  const period = (args.period ?? "this_month") as PeriodPreset;
  let snapshot: AnalyticsSnapshot;
  try {
    snapshot = await buildAnalyticsSnapshot({
      tenant: { id: tenant.id, name: tenant.name, code: tenant.code },
      filters: { period, locationId: branch.locationId ?? undefined },
    });
  } catch {
    return failure(name, "records_unavailable");
  }

  const analyticsHref = `/admin/zeli-analytics?period=${period}${
    branch.locationId ? `&location=${branch.locationId}` : ""
  }`;
  const baseSources: ZeliSource[] = [
    { label: "Zeli Business Intelligence", href: analyticsHref },
  ];

  switch (name) {
    case "business_summary":
      return composedResult(
        name,
        composeOverview(snapshot),
        snapshotFacts(snapshot),
        [{ label: "Business dashboard", href: "/admin/dashboard" }, ...baseSources]
      );
    case "contributions_withdrawals":
      return composedResult(
        name,
        composeContributions(snapshot),
        {
          period: snapshot.period.label,
          contributions: snapshot.totals.contributions,
          contributionCount: snapshot.totals.contributionCount,
          withdrawals: snapshot.totals.withdrawals,
          withdrawalCount: snapshot.totals.withdrawalCount,
          previousContributions: snapshot.previousTotals.contributions,
          previousWithdrawals: snapshot.previousTotals.withdrawals,
          changes: {
            contributions: roundDiff(
              snapshot.totals.contributions,
              snapshot.previousTotals.contributions
            ),
            withdrawals: roundDiff(
              snapshot.totals.withdrawals,
              snapshot.previousTotals.withdrawals
            ),
          },
          comparison: snapshot.comparison,
          contributingAccounts: snapshot.totals.activeAccounts,
          source: snapshot.freshness.source,
          freshness: snapshot.freshness.refreshedAt,
        },
        [
          { label: "Contributions report", href: "/susu/admin/contributions" },
          { label: "Withdrawals report", href: "/susu/admin/withdrawals" },
          ...baseSources,
        ]
      );
    case "income_expenses":
      return composedResult(
        name,
        composeIncomeExpenses(snapshot),
        {
          period: snapshot.period.label,
          cashIncome: snapshot.totals.cashIncome,
          previousCashIncome: snapshot.previousTotals.cashIncome,
          expenses: snapshot.totals.expenses,
          expenseCount: snapshot.totals.expenseCount,
          previousExpenses: snapshot.previousTotals.expenses,
          netCashFlow: snapshot.totals.netCashFlow,
          changes: {
            cashIncome: roundDiff(
              snapshot.totals.cashIncome,
              snapshot.previousTotals.cashIncome
            ),
            expenses: roundDiff(snapshot.totals.expenses, snapshot.previousTotals.expenses),
            netCashFlow: roundDiff(
              snapshot.totals.netCashFlow,
              snapshot.previousTotals.netCashFlow
            ),
          },
          comparison: snapshot.comparison,
          source: snapshot.freshness.source,
          freshness: snapshot.freshness.refreshedAt,
        },
        [{ label: "Money & History", href: "/admin/history" }, ...baseSources]
      );
    case "remittances":
      return composedResult(
        name,
        composeRemittances(snapshot),
        {
          period: snapshot.period.label,
          remittances: snapshot.totals.remittances,
          remittanceVariance: snapshot.totals.remittanceVariance,
          remittanceCount: snapshot.totals.remittanceCount,
          previousRemittances: snapshot.previousTotals.remittances,
          previousRemittanceVariance: snapshot.previousTotals.remittanceVariance,
          changes: {
            remittances: roundDiff(
              snapshot.totals.remittances,
              snapshot.previousTotals.remittances
            ),
            variance: roundDiff(
              snapshot.totals.remittanceVariance,
              snapshot.previousTotals.remittanceVariance
            ),
          },
          source: snapshot.freshness.source,
          freshness: snapshot.freshness.refreshedAt,
        },
        [
          { label: "Money Handed In", href: "/susu/admin/remittances" },
          ...baseSources,
        ]
      );
    case "exceptions":
      return composedResult(
        name,
        composeExceptions(snapshot),
        {
          period: snapshot.period.label,
          exceptions: snapshot.exceptions,
          source: snapshot.freshness.source,
          freshness: snapshot.freshness.refreshedAt,
        },
        [
          { label: "Withdrawals", href: "/susu/admin/withdrawals" },
          { label: "Money & History", href: "/admin/history" },
          ...baseSources,
        ]
      );
    case "branch_comparison":
      return composedResult(
        name,
        composeBranches(snapshot),
        {
          period: snapshot.period.label,
          branches: snapshot.branchPerformance.slice(0, 20),
          source: snapshot.freshness.source,
          freshness: snapshot.freshness.refreshedAt,
        },
        [{ label: "Susu reports", href: "/susu/admin/reports" }, ...baseSources]
      );
    case "period_comparison":
      return composedResult(
        name,
        composeOverview(snapshot),
        {
          period: snapshot.period.label,
          previousPeriod: snapshot.previousPeriod.label,
          totals: snapshot.totals,
          previousTotals: snapshot.previousTotals,
          changes: {
            contributions: roundDiff(
              snapshot.totals.contributions,
              snapshot.previousTotals.contributions
            ),
            withdrawals: roundDiff(
              snapshot.totals.withdrawals,
              snapshot.previousTotals.withdrawals
            ),
            expenses: roundDiff(snapshot.totals.expenses, snapshot.previousTotals.expenses),
            netCashFlow: roundDiff(
              snapshot.totals.netCashFlow,
              snapshot.previousTotals.netCashFlow
            ),
          },
          comparison: snapshot.comparison,
          source: snapshot.freshness.source,
          freshness: snapshot.freshness.refreshedAt,
        },
        baseSources
      );
    default:
      return failure(name, "unsupported_tool");
  }
}

export async function executeBusinessTool(params: {
  identity: ZeliIdentity;
  name: string;
  rawArgs: unknown;
}): Promise<BusinessToolResult> {
  const definition = BUSINESS_TOOLS.find((tool) => tool.name === params.name);
  if (!definition) {
    return failure(params.name as BusinessToolName, "unknown_tool");
  }
  if (!definition.roles.includes(params.identity.role)) {
    return failure(definition.name, "not_permitted", { role: params.identity.role });
  }

  switch (definition.name) {
    case "metric_definition": {
      const parsed = metricArgs.safeParse(params.rawArgs ?? {});
      if (!parsed.success) return failure(definition.name, "invalid_arguments");
      const answer = explainMetricDefinition(parsed.data.metric);
      if (!answer) return failure(definition.name, "metric_unknown");
      return composedResult(
        definition.name,
        answer,
        { focus: answer.focus, period: answer.period, definition: answer.text },
        [{ label: "Zeli Business Intelligence", href: "/admin/zeli-analytics" }]
      );
    }
    case "customer_lookup": {
      const parsed = lookupArgs.safeParse(params.rawArgs ?? {});
      if (!parsed.success) return failure(definition.name, "invalid_arguments");
      const outcome = await customerLookup(params.identity, parsed.data.query);
      if (!outcome) return failure(definition.name, "no_match");
      return {
        tool: definition.name,
        ok: true,
        facts: { customers: JSON.parse(outcome.summary) },
        authoritativeText: "",
        sources: outcome.sources,
        outcome,
      };
    }
    case "daily_accounts": {
      const outcome = await dailyAccountSummary(params.identity);
      if (!outcome) return failure(definition.name, "no_records");
      return {
        tool: definition.name,
        ok: true,
        facts: { dailyAccounts: JSON.parse(outcome.summary) },
        authoritativeText: "",
        sources: outcome.sources,
        outcome,
      };
    }
    case "customer_account_summary": {
      const outcome = await customerAccountSummary(params.identity);
      if (!outcome) return failure(definition.name, "no_records");
      return {
        tool: definition.name,
        ok: true,
        facts: { accounts: JSON.parse(outcome.summary) },
        authoritativeText: "",
        sources: outcome.sources,
        outcome,
      };
    }
    default: {
      const parsed = periodArgs.safeParse(params.rawArgs ?? {});
      if (!parsed.success) return failure(definition.name, "invalid_arguments");
      return analyticsTool(params.identity, definition.name, parsed.data);
    }
  }
}

export function sourcesFromToolResults(results: BusinessToolResult[]): ZeliSource[] {
  const seen = new Set<string>();
  const sources: ZeliSource[] = [];
  for (const result of results) {
    for (const source of result.sources) {
      const key = `${source.label}|${source.href ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}
