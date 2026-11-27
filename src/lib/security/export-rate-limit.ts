import { RATE_LIMITS } from "./config";
import { consumeRateLimit, type RateLimitPolicy } from "./rate-limit";

/**
 * Endpoint-specific export throttles.
 *
 * Buckets are keyed by the authenticated actor id AND the server-resolved
 * business scope, never by a client-supplied identifier or IP header. The
 * underlying counters are database-backed and keyed HMAC values, so they work
 * across instances and never store a raw token, email or IP address.
 *
 * Each export has a sustained ceiling and a short burst ceiling. The burst
 * bucket bounds concurrent expensive work without relying on process-local
 * state; the sustained bucket bounds total volume for legitimate use.
 */

export type ExportKind = "zeliAnalytics" | "association" | "audit" | "susuReport";

const POLICIES: Record<
  ExportKind,
  { scope: string; sustained: RateLimitPolicy; burst: RateLimitPolicy }
> = {
  zeliAnalytics: {
    scope: "export_zeli_analytics",
    sustained: RATE_LIMITS.zeliExportSustained,
    burst: RATE_LIMITS.zeliExportBurst,
  },
  association: {
    scope: "export_association",
    sustained: RATE_LIMITS.associationExportSustained,
    burst: RATE_LIMITS.associationExportBurst,
  },
  audit: {
    scope: "export_audit",
    sustained: RATE_LIMITS.auditExportSustained,
    burst: RATE_LIMITS.auditExportBurst,
  },
  susuReport: {
    scope: "export_susu_report",
    sustained: RATE_LIMITS.auditExportSustained,
    burst: RATE_LIMITS.auditExportBurst,
  },
};

export interface ExportLimitOutcome {
  error: string;
  status: 429;
  retryAfter: number;
}

export async function enforceExportRateLimit(
  kind: ExportKind,
  actorId: string,
  businessScopeId: string,
  now: number = Date.now()
): Promise<ExportLimitOutcome | null> {
  const policy = POLICIES[kind];
  // Both components come from the server session/tenant context. A caller
  // cannot broaden or switch buckets with a query parameter.
  const identifier = `${actorId}|${businessScopeId}`;
  const [sustained, burst] = await Promise.all([
    consumeRateLimit(policy.scope, identifier, policy.sustained, now),
    consumeRateLimit(`${policy.scope}:burst`, identifier, policy.burst, now),
  ]);
  if (sustained.allowed && burst.allowed) return null;
  return {
    error: "Too many export requests. Try again shortly.",
    status: 429,
    retryAfter: Math.max(sustained.retryAfterSeconds, burst.retryAfterSeconds, 1),
  };
}

/** Uniform 429 response; no internal counters or policy detail is disclosed. */
export function exportRateLimitResponse(outcome: ExportLimitOutcome): Response {
  return Response.json(
    { error: outcome.error },
    {
      status: 429,
      headers: {
        "Retry-After": String(outcome.retryAfter),
        "Cache-Control": "no-store",
      },
    }
  );
}
