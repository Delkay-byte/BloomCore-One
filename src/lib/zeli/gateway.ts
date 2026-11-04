import { z } from "zod";
import { db } from "@/lib/db";
import {
  EXTERNAL_AI_PHASE,
  PROVIDER_DISABLED_MESSAGE,
  PROVIDER_POLICY_VERSION,
} from "./provider-policy";

/**
 * Outbound privacy gateway for any future external AI provider.
 *
 * Nothing in this release sends a request. This module exists so that a future
 * approved integration has a single, typed, fail-closed choke point:
 *
 *  - payloads are constructed from an allow-listed schema, never by
 *    serialising a database record and then deleting fields;
 *  - unknown keys, nested unknowns, identifier-like strings, free text and
 *    exact timestamps are rejected;
 *  - a payload can belong to exactly one tenant; a tenant id inside the
 *    payload is an unknown field and is rejected;
 *  - small groups are suppressed below a configurable minimum;
 *  - decisions are audited without storing payload values.
 *
 * Pseudonymisation is not anonymisation. Even a fully valid aggregate payload
 * stays inside BloomCore One while external processing is disabled.
 */

export const GATEWAY_METRICS = [
  "contributions",
  "withdrawals",
  "remittances",
  "net_cash_flow",
  "transaction_count",
  "active_accounts",
  "expenses",
  "income",
] as const;

export const GATEWAY_CATEGORIES = [
  "period_trend",
  "branch_trend",
  "customer_activity",
  "operational_exception",
  "remittance_activity",
] as const;

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be date-only (YYYY-MM-DD)")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Invalid calendar date");

const aggregateSchema = z
  .object({
    metric: z.enum(GATEWAY_METRICS),
    value: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
    unit: z.enum(["GHS", "count", "percent"]),
    direction: z.enum(["up", "down", "flat", "unknown"]).optional(),
  })
  .strict();

const payloadSchema = z
  .object({
    purpose: z.enum([
      "trend_explanation",
      "operational_summary",
      "anomaly_explanation",
    ]),
    reportingPeriod: z
      .object({
        start: dateOnly,
        end: dateOnly,
        granularity: z.enum(["day", "week", "month"]),
      })
      .strict()
      .refine(
        (period) => period.start <= period.end,
        "Reporting period start must not be after its end"
      ),
    aggregates: z.array(aggregateSchema).min(1).max(20),
    cohortSize: z.number().int().min(1).max(10_000_000),
    categories: z.array(z.enum(GATEWAY_CATEGORIES)).max(5).optional(),
  })
  .strict();

export type GatewayPayload = z.infer<typeof payloadSchema>;

export interface GatewayEvaluation {
  ok: boolean;
  reason: string;
  normalized: GatewayPayload | null;
  categories: string[];
  observationCount: number;
  suppressedGroupCount: number;
}

/** Minimum configured cohort. It can be raised, never lowered below five. */
export function minimumCohortSize(): number {
  const configured = Number(process.env.ZELI_GATEWAY_MIN_COHORT ?? "5");
  if (!Number.isFinite(configured)) return 5;
  return Math.max(5, Math.min(100, Math.floor(configured)));
}

const FORBIDDEN_KEY_PATTERN =
  /(name|phone|email|account|staff|customer|payment|transaction|reference|location|address|timestamp|time|note|document|token|password|secret|mfa|conversation|message|history|tenant|user|id)$/i;

const IDENTIFIER_VALUE_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // email
  /\+?\d[\d\s()-]{6,}\d/, // phone-like
  /\b[A-Z]{2,}-[A-Z0-9-]{3,}\b/, // reference / account / staff ids
  /\b[A-Za-z0-9_-]{20,}\b/, // long opaque identifiers or hashes
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, // exact timestamp
];

function findForbiddenKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY_PATTERN.test(key) && key !== "reportingPeriod") {
        return keyPath;
      }
      const found = findForbiddenKey(child, keyPath);
      if (found) return found;
    }
  }
  return null;
}

function findIdentifierValue(value: unknown, path = ""): string | null {
  if (typeof value === "string") {
    // Date-only report boundaries are allow-listed and are not phone numbers.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    for (const pattern of IDENTIFIER_VALUE_PATTERNS) {
      if (pattern.test(value)) return path || "value";
    }
    // Free text is not allowed at all: every string field is an enum or date.
    if (/\s/.test(value.trim())) {
      return path || "value";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findIdentifierValue(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const found = findIdentifierValue(child, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Evaluate a proposed outbound payload. Validation failure is fail-closed:
 * the caller must not send anything unless `ok` is true.
 */
export function evaluateOutboundPayload(input: unknown): GatewayEvaluation {
  const minimum = minimumCohortSize();
  const forbidden = findForbiddenKey(input);
  if (forbidden) {
    return {
      ok: false,
      reason: `Forbidden field rejected: ${forbidden}`,
      normalized: null,
      categories: [],
      observationCount: 0,
      suppressedGroupCount: 0,
    };
  }
  const identifier = findIdentifierValue(input);
  if (identifier) {
    return {
      ok: false,
      reason: `Identifier-like or free-text value rejected: ${identifier}`,
      normalized: null,
      categories: [],
      observationCount: 0,
      suppressedGroupCount: 0,
    };
  }
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Payload rejected: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
      normalized: null,
      categories: [],
      observationCount: 0,
      suppressedGroupCount: 0,
    };
  }
  const payload = parsed.data;
  const categories = Array.from(
    new Set([
      ...(payload.categories ?? []),
      ...payload.aggregates.map((aggregate) => aggregate.metric),
    ])
  );
  if (payload.cohortSize < minimum) {
    return {
      ok: false,
      reason: `Small group suppressed: cohort ${payload.cohortSize} is below the minimum of ${minimum}`,
      normalized: null,
      categories,
      observationCount: payload.cohortSize,
      suppressedGroupCount: 1,
    };
  }
  return {
    ok: true,
    reason: "Payload satisfies the outbound allow-list",
    normalized: payload,
    categories,
    observationCount: payload.cohortSize,
    suppressedGroupCount: 0,
  };
}

export interface GatewaySubmission {
  allowed: boolean;
  reason: string;
  policyVersion: string;
  categories: string[];
}

/**
 * Submit a payload to the gateway. This is the only outbound path, and it is
 * hard-denied while external AI processing is disabled. The decision is
 * audited with category names and counts only.
 */
export async function submitOutboundPayload(params: {
  tenantId: string;
  provider: string;
  payload: unknown;
}): Promise<GatewaySubmission> {
  const evaluation = evaluateOutboundPayload(params.payload);
  const allowed = false;
  const reason = !evaluation.ok
    ? evaluation.reason
    : EXTERNAL_AI_PHASE === "disabled"
      ? `External AI processing is disabled. ${PROVIDER_DISABLED_MESSAGE}`
      : "External provider delivery is not implemented in this release.";

  await recordGatewayDecision({
    tenantId: params.tenantId,
    provider: params.provider,
    allowed,
    reason,
    categories: evaluation.categories,
    observationCount: evaluation.observationCount,
    suppressedGroupCount: evaluation.suppressedGroupCount,
  });

  return {
    allowed,
    reason,
    policyVersion: PROVIDER_POLICY_VERSION,
    categories: evaluation.categories,
  };
}

/** Persist a decision without payload values or prompts. Never throws. */
export async function recordGatewayDecision(params: {
  tenantId: string | null;
  provider: string;
  allowed: boolean;
  reason: string;
  categories: string[];
  observationCount: number;
  suppressedGroupCount: number;
}): Promise<void> {
  try {
    await db.zeliProviderGatewayEvent.create({
      data: {
        tenantId: params.tenantId,
        provider: params.provider,
        decision: params.allowed ? "allowed" : "denied",
        reason: params.reason.slice(0, 300),
        policyVersion: PROVIDER_POLICY_VERSION,
        payloadCategories: params.categories.length
          ? JSON.stringify(params.categories.slice(0, 30))
          : null,
        observationCount: params.observationCount,
        suppressedGroupCount: params.suppressedGroupCount,
      },
    });
  } catch (error) {
    console.error("[ZELI GATEWAY] decision audit failed", error);
  }
}

// ---------------------------------------------------------------------------
// Aggregate insight package (the only payload an external provider may see)
// ---------------------------------------------------------------------------

export const INSIGHT_SCHEMA_VERSION = "zeli-insight-v1";

export const INSIGHT_PURPOSES = [
  "period_comparison",
  "trend_explanation",
  "chart_explanation",
  "operational_summary",
  "branch_comparison",
  "remittance_pattern",
  "exception_explanation",
] as const;

export const INSIGHT_METRICS = [
  "contributions",
  "withdrawals",
  "net_cash_flow",
  "remittances",
  "expenses",
  "transaction_volume",
  "active_accounts",
  "exceptions",
] as const;

const direction = z.enum(["up", "down", "flat", "unknown"]);
const changeBand = z.enum(["lt_5", "5_10", "10_25", "25_50", "gt_50", "unknown"]);
const cohortBand = z.enum(["5_24", "25_99", "100_plus"]);

const insightPackageSchema = z
  .object({
    schemaVersion: z.literal(INSIGHT_SCHEMA_VERSION),
    purpose: z.enum(INSIGHT_PURPOSES),
    reportingPeriod: z
      .object({
        granularity: z.enum(["day", "week", "month", "quarter"]),
        comparison: z.enum(["previous_period", "none"]),
      })
      .strict(),
    metrics: z
      .array(
        z
          .object({
            metric: z.enum(INSIGHT_METRICS),
            direction,
            changeBand,
          })
          .strict()
      )
      .min(1)
      .max(8),
    cohortBand,
    categories: z
      .array(z.enum(GATEWAY_CATEGORIES))
      .max(4)
      .optional(),
    synthetic: z.literal(true).optional(),
    syntheticScenario: z
      .enum(["integration_probe", "trend_fixture", "exception_fixture"])
      .optional(),
  })
  .strict();

export type InsightPackage = z.infer<typeof insightPackageSchema>;

export interface InsightEvaluation {
  ok: boolean;
  reason: string;
  package: InsightPackage | null;
  categories: string[];
}

/**
 * Validate an insight package. `cohortSize` is supplied out-of-band from the
 * server snapshot and is never part of the outbound payload. Synthetic mode
 * requires the explicit synthetic marker; production mode rejects it.
 */
export function evaluateInsightPackage(
  input: unknown,
  options: { cohortSize: number; synthetic: boolean }
): InsightEvaluation {
  const forbidden = findForbiddenKey(input);
  if (forbidden) {
    return { ok: false, reason: `Forbidden field rejected: ${forbidden}`, package: null, categories: [] };
  }
  const identifier = findIdentifierValue(input);
  if (identifier) {
    return {
      ok: false,
      reason: `Identifier-like or free-text value rejected: ${identifier}`,
      package: null,
      categories: [],
    };
  }
  const parsed = insightPackageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Insight package rejected: ${parsed.error.issues[0]?.message ?? "schema error"}`,
      package: null,
      categories: [],
    };
  }
  const value = parsed.data;
  if (value.synthetic === true) {
    if (!options.synthetic) {
      return {
        ok: false,
        reason: "Synthetic package rejected outside synthetic mode",
        package: null,
        categories: [],
      };
    }
  } else if (options.synthetic) {
    return {
      ok: false,
      reason: "Synthetic mode accepts only explicitly marked synthetic packages",
      package: null,
      categories: [],
    };
  }
  if (options.cohortSize < minimumCohortSize()) {
    return {
      ok: false,
      reason: `Small group suppressed: cohort ${options.cohortSize} is below ${minimumCohortSize()}`,
      package: null,
      categories: value.categories ?? [],
    };
  }
  return {
    ok: true,
    reason: "Insight package satisfies the outbound allow-list",
    package: value,
    categories: value.categories ?? value.metrics.map((metric) => metric.metric),
  };
}
