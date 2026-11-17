import { db } from "../db";
import { sha256 } from "./crypto";
import { turnstileConfig } from "./config";
import { logSecurityEvent } from "./log";

/**
 * Cloudflare Turnstile server-side verification.
 *
 * The widget rendering successfully proves nothing. Every protected submission
 * must present a token that Cloudflare confirms, for the expected action and
 * hostname, and that has never been used before.
 *
 * Failure policy: fail closed. A missing token, a Cloudflare timeout, a missing
 * secret or an unexpected response all reject the protected request.
 */

export interface TurnstileVerificationInput {
  token: string | null | undefined;
  /** Action label configured on the widget, e.g. "login" or "password_reset". */
  action: string;
  ip?: string | null;
  fetchImpl?: typeof fetch;
  now?: number;
}

export interface TurnstileVerificationResult {
  ok: boolean;
  reason?:
    | "disabled"
    | "missing"
    | "configuration"
    | "rejected"
    | "hostname"
    | "action"
    | "expired"
    | "replay"
    | "unavailable";
  /**
   * Sanitized Cloudflare error codes for protected server logs. Never rendered
   * to the customer and never includes the token or the secret.
   */
  errorCodes?: string[];
}

interface SiteVerifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  challenge_ts?: string;
  "error-codes"?: string[];
}

const TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
const TOKEN_LEDGER_TTL_MS = 20 * 60 * 1000;

/** Cloudflare rejects unknown error-code shapes; keep only documented characters. */
function sanitizeErrorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((code): code is string => typeof code === "string")
    .map((code) => code.toLowerCase().replace(/[^a-z0-9-]/g, ""))
    .filter((code) => code.length > 0 && code.length <= 40)
    .slice(0, 8);
}

/**
 * Map Cloudflare's documented error codes onto the rejection category that is
 * safe to persist in a protected security log.
 */
function reasonForErrorCodes(
  codes: string[]
): Exclude<TurnstileVerificationResult["reason"], undefined | "disabled"> {
  if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret")) {
    return "configuration";
  }
  if (codes.includes("internal-error")) return "unavailable";
  if (codes.includes("timeout-or-duplicate")) return "replay";
  if (codes.includes("missing-input-response") || codes.includes("invalid-input-response")) {
    return "rejected";
  }
  return "rejected";
}

async function markTokenUsed(token: string, now: number): Promise<boolean> {
  const tokenHash = sha256(token);
  try {
    await db.turnstileTokenUse.create({
      data: {
        tokenHash,
        expiresAt: new Date(now + TOKEN_LEDGER_TTL_MS),
      },
    });
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

export async function verifyTurnstile(
  input: TurnstileVerificationInput
): Promise<TurnstileVerificationResult> {
  const config = turnstileConfig();
  if (!config.enabled) return { ok: true, reason: "disabled" };

  if (!config.secretKey || !config.siteKey) {
    logSecurityEvent({
      event: "turnstile.configuration_error",
      outcome: "error",
      actorType: "anonymous",
      reason: "enabled_without_keys",
    });
    return { ok: false, reason: "configuration" };
  }

  const token = input.token?.trim();
  if (!token || token.length > 2048) return { ok: false, reason: "missing" };

  const now = input.now ?? Date.now();
  const body = new URLSearchParams();
  body.set("secret", config.secretKey);
  body.set("response", token);
  if (input.ip) body.set("remoteip", input.ip);
  // Cloudflare's documented idempotency support: a retried request with the
  // same key returns the original verdict instead of "timeout-or-duplicate".
  // The key is derived from the token, so it is stable across retries of the
  // same challenge and different for a fresh challenge.
  body.set("idempotency_key", `maacash-${sha256(token).slice(0, 48)}`);

  const doFetch = input.fetchImpl ?? fetch;
  const attempt = async (): Promise<
    { response: SiteVerifyResponse } | { failure: "unavailable" }
  > => {
    try {
      const http = await doFetch(config.verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
        cache: "no-store",
      });
      if (!http.ok) return { failure: "unavailable" };
      return { response: (await http.json()) as SiteVerifyResponse };
    } catch {
      return { failure: "unavailable" };
    }
  };

  // Exactly one safe retry, and only after a transport/HTTP failure. A
  // definitive rejection is never retried; the customer must solve a fresh
  // challenge instead.
  let outcome = await attempt();
  if ("failure" in outcome) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    outcome = await attempt();
  }
  if ("failure" in outcome) return { ok: false, reason: "unavailable" };

  const response = outcome.response;
  if (response.success !== true) {
    const codes = sanitizeErrorCodes(response["error-codes"]);
    return { ok: false, reason: reasonForErrorCodes(codes), errorCodes: codes };
  }

  const hostname = response.hostname?.toLowerCase();
  if (!hostname || !config.allowedHostnames.includes(hostname)) {
    return { ok: false, reason: "hostname", errorCodes: ["hostname-mismatch"] };
  }

  if (!response.action || response.action !== input.action) {
    return { ok: false, reason: "action", errorCodes: ["action-mismatch"] };
  }

  if (response.challenge_ts) {
    const issuedAt = Date.parse(response.challenge_ts);
    if (!Number.isFinite(issuedAt) || now - issuedAt > TOKEN_MAX_AGE_MS) {
      return { ok: false, reason: "expired", errorCodes: ["challenge-too-old"] };
    }
  } else {
    // Cloudflare always returns this field; absence means an untrusted response.
    return { ok: false, reason: "rejected", errorCodes: ["missing-challenge-ts"] };
  }

  const firstUse = await markTokenUsed(token, now);
  if (!firstUse) return { ok: false, reason: "replay", errorCodes: ["token-already-consumed"] };

  // Opportunistic cleanup of the single-use ledger.
  try {
    await db.turnstileTokenUse.deleteMany({
      where: { expiresAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } },
    });
  } catch {
    // best effort
  }

  return { ok: true };
}

/** Normalize a submitted token field from FormData. */
export function readTurnstileToken(formData: FormData): string | null {
  const value = formData.get("cf-turnstile-response") ?? formData.get("turnstileToken");
  return typeof value === "string" ? value : null;
}
