import { db } from "../db";
import { keyedHash } from "./crypto";
import { LOGIN_THROTTLE } from "./config";

/**
 * Progressive failed-login throttling.
 *
 * Two dimensions are tracked:
 *
 *   pair:<hmac(identifier|ip)>    the progressive 1/5/15-minute cooldown
 *   acct:<hmac(identifier)>       a high-threshold account-wide ceiling
 *
 * The pair dimension means an attacker on one IP cannot lock a legitimate user
 * out from their own IP. The account dimension stops distributed guessing but
 * uses a much higher threshold and is still capped at a 15-minute refusal, so
 * it can never become a permanent lockout.
 *
 * Attempts made while a cooldown is active are rejected without touching the
 * stored state, so hammering the endpoint cannot extend the cooldown.
 */

export interface ThrottleState {
  blocked: boolean;
  retryAfterSeconds: number;
  stage: number;
}

interface ThrottleSnapshot {
  failedCount: number;
  stage: number;
  lastFailedAt: Date;
  blockedUntil: Date | null;
}

const ACCOUNT_THRESHOLD = 30;

export function accountThrottleKey(identifier: string): string {
  return `acct:${keyedHash(`identifier:${identifier}`)}`;
}

export function pairThrottleKey(identifier: string, clientIp: string): string {
  return `pair:${keyedHash(`identifier:${identifier}|ip:${clientIp}`)}`;
}

function cooldownForStage(stage: number): number {
  const capped = Math.min(stage, LOGIN_THROTTLE.COOLDOWNS_MS.length - 1);
  return Math.min(
    LOGIN_THROTTLE.COOLDOWNS_MS[capped],
    LOGIN_THROTTLE.MAX_COOLDOWN_MS
  );
}

/** Read the effective state of one throttle key without mutating it. */
export async function readThrottle(
  key: string,
  now: number = Date.now()
): Promise<ThrottleState> {
  const row = await db.authThrottle.findUnique({ where: { key } });
  return stateFromRow(row, now);
}

function stateFromRow(
  row: ThrottleSnapshot | null,
  now: number
): ThrottleState {
  if (!row) return { blocked: false, retryAfterSeconds: 0, stage: 0 };
  if (row.blockedUntil && row.blockedUntil.getTime() > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((row.blockedUntil.getTime() - now) / 1000),
      stage: row.stage,
    };
  }
  return { blocked: false, retryAfterSeconds: 0, stage: row.stage };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

async function ensureRow(key: string, now: number): Promise<void> {
  try {
    await db.authThrottle.create({
      data: {
        key,
        failedCount: 0,
        stage: 0,
        windowStartedAt: new Date(now),
        lastFailedAt: new Date(now),
        expiresAt: new Date(now + LOGIN_THROTTLE.QUIET_PERIOD_MS),
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

/**
 * Record one failed credential submission for the supplied keys.
 * Returns the state after the failure (which may now be blocked).
 */
export async function registerFailure(
  keys: string[],
  now: number = Date.now()
): Promise<ThrottleState> {
  let result: ThrottleState = { blocked: false, retryAfterSeconds: 0, stage: 0 };

  for (const key of keys) {
    await ensureRow(key, now);

    const existing = await db.authThrottle.findUnique({ where: { key } });
    if (!existing) continue;

    // Never extend an active cooldown.
    if (existing.blockedUntil && existing.blockedUntil.getTime() > now) {
      result = stateFromRow(existing, now);
      continue;
    }

    const quiet = now - existing.lastFailedAt.getTime();
    const observationExpired =
      quiet > LOGIN_THROTTLE.OBSERVATION_WINDOW_MS;
    const fullReset = quiet > LOGIN_THROTTLE.QUIET_PERIOD_MS;

    await db.authThrottle.updateMany({
      where: { key, lastFailedAt: { lte: new Date(now) } },
      data: {
        failedCount: fullReset
          ? 1
          : observationExpired
            ? 1
            : { increment: 1 },
        stage: fullReset ? 0 : existing.stage,
        windowStartedAt: observationExpired
          ? new Date(now)
          : existing.windowStartedAt,
        lastFailedAt: new Date(now),
        blockedUntil: null,
        expiresAt: new Date(now + LOGIN_THROTTLE.QUIET_PERIOD_MS),
      },
    });

    const updated = await db.authThrottle.findUnique({ where: { key } });
    if (!updated) continue;

    const isAccountKey = key.startsWith("acct:");
    const threshold = isAccountKey
      ? ACCOUNT_THRESHOLD
      : LOGIN_THROTTLE.THRESHOLDS[
          Math.min(updated.stage, LOGIN_THROTTLE.THRESHOLDS.length - 1)
        ];

    if (updated.failedCount >= threshold) {
      const nextStage = Math.min(
        updated.stage + 1,
        LOGIN_THROTTLE.COOLDOWNS_MS.length
      );
      const blockedUntil = new Date(now + cooldownForStage(nextStage - 1));
      await db.authThrottle.update({
        where: { key },
        data: { stage: nextStage, blockedUntil },
      });
      const state = {
        blocked: true,
        retryAfterSeconds: Math.ceil(
          (blockedUntil.getTime() - now) / 1000
        ),
        stage: nextStage,
      };
      if (key.startsWith("pair:")) result = state;
    } else {
      const state = stateFromRow(updated, now);
      if (key.startsWith("pair:")) result = state;
    }
  }

  return result;
}

/** A successful password/MFA verification clears both dimensions. */
export async function clearThrottle(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.authThrottle.deleteMany({ where: { key: { in: keys } } });
}

export function throttleKeys(
  identifier: string,
  clientIp: string | null
): string[] {
  return [
    accountThrottleKey(identifier),
    pairThrottleKey(identifier, clientIp ?? "unknown"),
  ];
}
