import { db } from "../db";
import { keyedHash } from "./crypto";
import { logSecurityEvent } from "./log";

/**
 * Persistent fixed-window rate limiting.
 *
 * Counters live in PostgreSQL/SQLite, so they survive instance restarts and are
 * shared by every Render instance. Keys are keyed HMAC digests: no raw email
 * address, IP address or token is ever stored.
 *
 * Callers pass an `identifier` (already normalized) and a `scope`. The stored
 * key is "<scope>:<hmac>", which keeps buckets from different endpoints
 * independent while preventing scope confusion.
 */

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: Date;
}

let lastCleanupAt = 0;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

async function cleanupExpired(now: number): Promise<void> {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    await db.rateLimitCounter.deleteMany({
      where: { expiresAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } },
    });
  } catch {
    // Cleanup is best-effort; it must never affect the request outcome.
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export async function consumeRateLimit(
  scope: string,
  identifier: string,
  policy: RateLimitPolicy,
  now: number = Date.now()
): Promise<RateLimitResult> {
  const key = `${scope}:${keyedHash(identifier)}`;
  const windowStart = new Date(now);
  const windowEnd = new Date(now + policy.windowMs);

  try {
    // Atomically reset an expired window, otherwise increment the live one.
    const reset = await db.rateLimitCounter.updateMany({
      where: { key, expiresAt: { lte: windowStart } },
      data: {
        count: 1,
        windowStartedAt: windowStart,
        expiresAt: windowEnd,
      },
    });

    if (reset.count === 0) {
      const incremented = await db.rateLimitCounter.updateMany({
        where: { key, expiresAt: { gt: windowStart } },
        data: { count: { increment: 1 } },
      });

      if (incremented.count === 0) {
        try {
          await db.rateLimitCounter.create({
            data: {
              key,
              count: 1,
              windowStartedAt: windowStart,
              expiresAt: windowEnd,
            },
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Another instance created the row first — increment its counter.
          await db.rateLimitCounter.updateMany({
            where: { key, expiresAt: { gt: windowStart } },
            data: { count: { increment: 1 } },
          });
        }
      }
    }

    const row = await db.rateLimitCounter.findUnique({ where: { key } });
    const count = row?.count ?? 1;
    const resetAt = row?.expiresAt ?? windowEnd;
    const allowed = count <= policy.limit;

    if (!allowed) {
      logSecurityEvent({
        event: "ratelimit.blocked",
        outcome: "blocked",
        reason: scope,
        actorType: "anonymous",
      });
    }

    void cleanupExpired(now);

    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
      resetAt,
    };
  } catch {
    // Fail closed: an unavailable counter store must not silently disable
    // protection on an authentication or financial endpoint.
    logSecurityEvent({
      event: "ratelimit.error",
      outcome: "error",
      reason: scope,
      actorType: "anonymous",
    });
    return {
      allowed: false,
      limit: policy.limit,
      remaining: 0,
      retryAfterSeconds: 60,
      resetAt: new Date(now + 60_000),
    };
  }
}

/** Format a Retry-After value (seconds) with a safe minimum. */
export function retryAfterSeconds(result: RateLimitResult): string {
  return String(Math.max(1, result.retryAfterSeconds));
}
