import { createHash } from "crypto";

/**
 * Central security configuration.
 *
 * Every value here is server-only. Nothing in this module may be imported by a
 * client component: the secrets below must never reach the browser bundle.
 */

const isProduction = process.env.NODE_ENV === "production";

function envBoolean(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Development/test fallback derivation.
 *
 * Production MUST provide dedicated secrets. The fallback exists only so local
 * development and the automated test suite can run without operator setup; it
 * is a one-way derivation and never reuses JWT_SECRET as the signing material.
 */
function derivedFallback(label: string): string {
  const base = process.env.JWT_SECRET ?? "insecure-development-only";
  return createHash("sha256").update(`${base}:${label}`).digest("hex");
}

function requireSecret(
  name: string,
  fallbackLabel: string
): string {
  const raw = process.env[name];
  if (raw && raw.length >= 32) return raw;
  if (raw && raw.length > 0 && !isProduction) return raw;
  if (isProduction) {
    throw new Error(
      `${name} is required in production and must be at least 32 characters. ` +
        "Generate one with the command documented in docs/security/PRODUCTION-SECURITY-ROLLOUT.md."
    );
  }
  return derivedFallback(fallbackLabel);
}

let cachedRateLimitSecret: string | null = null;
/** Dedicated HMAC key for rate-limit and throttle bucket identifiers. */
export function rateLimitHmacSecret(): string {
  if (!cachedRateLimitSecret) {
    cachedRateLimitSecret = requireSecret(
      "RATE_LIMIT_HMAC_SECRET",
      "rate-limit-hmac"
    );
  }
  return cachedRateLimitSecret;
}

let cachedMfaKey: Buffer | null = null;
/**
 * 32-byte AES-256-GCM key used to encrypt TOTP secrets at rest.
 * Accepts base64 or hex; both decode to exactly 32 bytes.
 */
export function mfaEncryptionKey(): Buffer {
  if (cachedMfaKey) return cachedMfaKey;
  const raw = process.env.MFA_ENCRYPTION_KEY;
  let key: Buffer | null = null;

  if (raw) {
    const trimmed = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      key = Buffer.from(trimmed, "hex");
    } else {
      try {
        const decoded = Buffer.from(trimmed, "base64");
        if (decoded.length === 32) key = decoded;
      } catch {
        key = null;
      }
    }
    if (!key && isProduction) {
      throw new Error(
        "MFA_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters."
      );
    }
  }

  if (!key) {
    if (isProduction) {
      throw new Error(
        "MFA_ENCRYPTION_KEY is required in production. See docs/security/PRODUCTION-SECURITY-ROLLOUT.md."
      );
    }
    key = createHash("sha256")
      .update(`${derivedFallback("mfa-encryption")}`)
      .digest();
  }

  cachedMfaKey = key;
  return key;
}

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string | null;
  secretKey: string | null;
  allowedHostnames: string[];
  verifyUrl: string;
  timeoutMs: number;
}

const DEFAULT_TURNSTILE_HOSTNAMES = ["bloomcore-one.onrender.com"];

export function turnstileConfig(): TurnstileConfig {
  const enabled = envBoolean("TURNSTILE_ENABLED", false);
  const allowedHostnames = (process.env.TURNSTILE_ALLOWED_HOSTNAMES ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return {
    enabled,
    siteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null,
    secretKey: process.env.TURNSTILE_SECRET_KEY?.trim() || null,
    allowedHostnames:
      allowedHostnames.length > 0
        ? allowedHostnames
        : DEFAULT_TURNSTILE_HOSTNAMES,
    verifyUrl:
      process.env.TURNSTILE_VERIFY_URL ??
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    timeoutMs: 5000,
  };
}

/**
 * MFA enforcement policy.
 *
 * - "optional":   users who enrolled must verify; privileged users are prompted
 *                 to enrol but are not blocked during the rollout window.
 * - "enforce":    privileged roles (platform super admins and tenant admins)
 *                 must enrol and verify before receiving a session.
 *
 * The default is "optional" so a deploy can never lock every administrator out.
 * The production rollout switches this value only after the owner has enrolled.
 */
export type MfaPolicy = "optional" | "enforce";

export function mfaPolicy(): MfaPolicy {
  return process.env.MFA_ENFORCEMENT?.trim().toLowerCase() === "enforce"
    ? "enforce"
    : "optional";
}

/** Failed-login thresholds and cooldown schedule (milliseconds). */
export const LOGIN_THROTTLE = {
  /** Failures within this rolling window count toward the progression. */
  OBSERVATION_WINDOW_MS: 15 * 60 * 1000,
  /** Consecutive failures needed to reach each stage. */
  THRESHOLDS: [5, 8, 11] as const,
  /** Cooldown applied after each threshold: 1 min, 5 min, 15 min. */
  COOLDOWNS_MS: [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000] as const,
  /** Failure state that has been quiet this long is discarded. */
  QUIET_PERIOD_MS: 24 * 60 * 60 * 1000,
  /** Hard ceiling on automatic refusal (never permanent). */
  MAX_COOLDOWN_MS: 15 * 60 * 1000,
} as const;

/** Request-rate policies per endpoint category. */
export const RATE_LIMITS = {
  /** Any single login endpoint, per IP. */
  loginIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  /** Password recovery requests, per IP. */
  passwordResetIp: { limit: 5, windowMs: 15 * 60 * 1000 },
  /** Password reset submissions, per IP. */
  passwordResetSubmitIp: { limit: 10, windowMs: 15 * 60 * 1000 },
  /** MFA verification attempts, per IP and per subject. */
  mfaIp: { limit: 10, windowMs: 10 * 60 * 1000 },
  mfaSubject: { limit: 5, windowMs: 10 * 60 * 1000 },
  /** Sensitive administrative actions, per subject. */
  adminSensitive: { limit: 30, windowMs: 10 * 60 * 1000 },
  /** Financial mutations, per subject. */
  financeMutation: { limit: 60, windowMs: 10 * 60 * 1000 },
  /** Offline queue drain, per user. Leaves room for a normal route batch. */
  offlineSync: { limit: 120, windowMs: 60 * 1000 },
  /** Expensive public endpoints (health/readiness excluded), per IP. */
  publicExpensive: { limit: 30, windowMs: 10 * 60 * 1000 },
} as const;
