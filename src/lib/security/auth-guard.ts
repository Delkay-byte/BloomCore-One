import { headers } from "next/headers";
import { getClientIp, ipBucketKey } from "./client-ip";
import { RATE_LIMITS } from "./config";
import { consumeRateLimit } from "./rate-limit";
import {
  clearThrottle,
  readThrottle,
  registerFailure,
  throttleKeys,
} from "./login-throttle";
import { verifyTurnstile } from "./turnstile";
import { logSecurityEvent } from "./log";

/**
 * Shared pre-credential guard used by every authentication entry point.
 *
 * Order matters:
 *   1. persistent per-IP request limit
 *   2. persistent account/pair cooldown (progressive 1/5/15 minutes)
 *   3. Turnstile server verification (when enabled)
 *
 * Only then may a password be checked. Failed passwords call
 * `recordLoginFailure`, which advances the cooldown; a success clears it.
 */

export function humanizeSeconds(seconds: number): string {
  const safe = Math.max(1, Math.ceil(seconds));
  if (safe < 60) return `${safe} second${safe === 1 ? "" : "s"}`;
  const minutes = Math.ceil(safe / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export type LoginGuardResult =
  | { ok: true; ip: string | null; identifier: string }
  | { ok: false; error: string; retryAfterSeconds?: number };

export interface LoginGuardOptions {
  identifier: string;
  /** Turnstile action and rate-limit scope, e.g. "login". */
  action: string;
  turnstileToken?: string | null;
  now?: number;
}

export async function guardLogin(
  options: LoginGuardOptions
): Promise<LoginGuardResult> {
  const identifier = options.identifier.trim().toLowerCase();
  const now = options.now ?? Date.now();

  let headerBag: Headers;
  try {
    headerBag = await headers();
  } catch {
    headerBag = new Headers();
  }
  const client = getClientIp(headerBag);
  const ipKey = ipBucketKey(client);

  // 1. Per-IP request rate limit for this endpoint category. When the client
  //    IP cannot be established safely the IP dimension is skipped rather than
  //    keyed on an attacker-controlled header; account throttling still applies.
  if (client.ip) {
    const ipLimit = await consumeRateLimit(
      `ip:${options.action}`,
      ipKey,
      RATE_LIMITS.loginIp,
      now
    );
    if (!ipLimit.allowed) {
      logSecurityEvent({
        event: "auth.rate_limited",
        outcome: "blocked",
        route: options.action,
        ip: client.ip,
        reason: "ip",
      });
      return {
        ok: false,
        error: `Too many attempts from this connection. Please try again in ${humanizeSeconds(
          ipLimit.retryAfterSeconds
        )}.`,
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      };
    }
  }

  // 2. Progressive account + pair cooldown.
  const keys = throttleKeys(identifier, client.ip);
  const states = await Promise.all(keys.map((key) => readThrottle(key, now)));
  const blocked = states.find((state) => state.blocked);
  if (blocked) {
    logSecurityEvent({
      event: "auth.cooldown",
      outcome: "blocked",
      route: options.action,
      ip: client.ip,
      reason: "throttle",
    });
    return {
      ok: false,
      error: `Too many failed attempts. Please try again in ${humanizeSeconds(
        blocked.retryAfterSeconds
      )}.`,
      retryAfterSeconds: blocked.retryAfterSeconds,
    };
  }

  // 3. Turnstile is mandatory whenever enabled.
  const turnstile = await verifyTurnstile({
    token: options.turnstileToken,
    action: options.action,
    ip: client.ip,
    now,
  });
  if (!turnstile.ok) {
    logSecurityEvent({
      event: "turnstile.verification_failed",
      outcome: "blocked",
      route: options.action,
      ip: client.ip,
      reason: turnstile.reason,
    });
    return {
      ok: false,
      error:
        "Security verification failed. Please complete the challenge again and retry.",
    };
  }

  return { ok: true, ip: client.ip, identifier };
}

/** Record one failed credential check and return the resulting cooldown. */
export async function recordLoginFailure(
  identifier: string,
  ip: string | null,
  route: string,
  now: number = Date.now()
): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const keys = throttleKeys(identifier.trim().toLowerCase(), ip);
  const state = await registerFailure(keys, now);
  logSecurityEvent({
    event: "auth.login_failed",
    outcome: "failure",
    route,
    ip,
    reason: state.blocked ? "cooldown_triggered" : "invalid_credentials",
  });
  return {
    blocked: state.blocked,
    retryAfterSeconds: state.retryAfterSeconds,
  };
}

/** Clear the failure progression after a successful authentication. */
export async function recordLoginSuccess(
  identifier: string,
  ip: string | null,
  route: string
): Promise<void> {
  await clearThrottle(throttleKeys(identifier.trim().toLowerCase(), ip));
  logSecurityEvent({
    event: "auth.login_success",
    outcome: "success",
    route,
    ip,
  });
}

export function cooldownMessage(retryAfterSeconds: number): string {
  return `Too many failed attempts. Please try again in ${humanizeSeconds(
    retryAfterSeconds
  )}.`;
}

/** Generic credential error. Never reveals whether the account exists. */
export const GENERIC_LOGIN_ERROR = "Invalid credentials. Please try again.";
