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

  let response: SiteVerifyResponse;
  try {
    const doFetch = input.fetchImpl ?? fetch;
    const http = await doFetch(config.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(config.timeoutMs),
      cache: "no-store",
    });
    if (!http.ok) return { ok: false, reason: "unavailable" };
    response = (await http.json()) as SiteVerifyResponse;
  } catch {
    // Network failure, timeout or invalid JSON: reject instead of bypassing.
    return { ok: false, reason: "unavailable" };
  }

  if (response.success !== true) return { ok: false, reason: "rejected" };

  const hostname = response.hostname?.toLowerCase();
  if (!hostname || !config.allowedHostnames.includes(hostname)) {
    return { ok: false, reason: "hostname" };
  }

  if (!response.action || response.action !== input.action) {
    return { ok: false, reason: "action" };
  }

  if (response.challenge_ts) {
    const issuedAt = Date.parse(response.challenge_ts);
    if (!Number.isFinite(issuedAt) || now - issuedAt > TOKEN_MAX_AGE_MS) {
      return { ok: false, reason: "expired" };
    }
  } else {
    // Cloudflare always returns this field; absence means an untrusted response.
    return { ok: false, reason: "rejected" };
  }

  const firstUse = await markTokenUsed(token, now);
  if (!firstUse) return { ok: false, reason: "replay" };

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
