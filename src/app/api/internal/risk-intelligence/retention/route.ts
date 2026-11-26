import { NextRequest } from "next/server";
import { expireStaleRiskSignals } from "@/lib/actions/risk-intelligence.actions";
import { runSystemRiskRetentionSweep } from "@/lib/actions/risk-governance.actions";
import { verifyRiskRetentionToken } from "@/lib/security/risk-retention-token";
import { consumeRateLimit } from "@/lib/security/rate-limit";

/**
 * Scheduled Risk Intelligence expiry and retention sweep.
 *
 * The existing scheduler calls this route with `RISK_RETENTION_TOKEN`. It is
 * disabled until that secret is configured. It expires open signals within the
 * daily cycle and then performs the approved deletion/scrubbing sweep. No user
 * session is involved and no financial audit record is touched.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETENTION_RATE_LIMIT = { limit: 6, windowMs: 60 * 60 * 1000 };

export async function POST(request: NextRequest): Promise<Response> {
  const token =
    request.headers.get("x-retention-token") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token.trim()) return new Response("Not configured", { status: 503 });

  // Authorise with a NON-MUTATING verifier before any state-changing work.
  // A bad token must never expire signals or start a sweep as a side effect.
  if (!verifyRiskRetentionToken({ token })) {
    return new Response("Forbidden", { status: 403 });
  }

  // A leaked static token must not permit unbounded expensive work. The rate
  // limiter hashes the identifier before storing it, so the token is not kept.
  const limit = await consumeRateLimit(
    "risk_retention:sweep",
    token,
    RETENTION_RATE_LIMIT
  );
  if (!limit.allowed) return new Response("Too Many Requests", { status: 429 });

  // Cross-process serialisation is enforced by a database-backed lease in
  // both mutation functions. This route must not rely on process-local state.
  // Mutating work starts only after authorisation and rate limiting.
  const sweep = await runSystemRiskRetentionSweep({ token });
  if (sweep.conflict) return new Response("Sweep already running", { status: 409 });
  if (!sweep.success) return new Response("Forbidden", { status: 403 });

  const expired = await expireStaleRiskSignals({ token });
  if (expired.conflict) return new Response("Sweep already running", { status: 409 });
  if (!expired.success) return new Response("Forbidden", { status: 403 });

  return Response.json({
    expired: expired.expired ?? 0,
    scrubbed: sweep.data?.scrubbed ?? 0,
    audited: sweep.data?.audited ?? 0,
  });
}
