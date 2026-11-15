"use server";

import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { headers } from "next/headers";
import { getClientIp } from "@/lib/security/client-ip";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { humanizeSeconds } from "@/lib/security/auth-guard";
import { TURNSTILE_ACTIONS } from "@/lib/security/turnstile-actions";
import {
  consumeEmailVerification,
  issueEmailVerification,
} from "@/lib/security/account-tokens";

export interface VerificationResponse {
  success: boolean;
  error?: string;
  /** Verified state for the success screen; never includes the account email. */
  verified?: boolean;
}

async function currentIp(): Promise<string | null> {
  try {
    return getClientIp(await headers()).ip;
  } catch {
    return null;
  }
}

/**
 * Request another verification email.
 *
 * The response is the same whether the address exists, is already verified or
 * belongs to an inactive account. Only rate limiting can produce a different
 * message, and that limit is applied before the lookup.
 */
export async function requestVerificationEmail(
  email: string,
  turnstileToken?: string | null
): Promise<VerificationResponse> {
  const normalised = (email || "").trim().toLowerCase();
  if (!normalised || normalised.length > 320 || !normalised.includes("@")) {
    return { success: true };
  }

  const ip = await currentIp();
  if (ip) {
    const ipLimit = await consumeRateLimit(
      "email_verification:ip",
      ip,
      RATE_LIMITS.passwordResetIp
    );
    if (!ipLimit.allowed) {
      return {
        success: false,
        error: `Too many verification requests. Please try again in ${humanizeSeconds(
          ipLimit.retryAfterSeconds
        )}.`,
      };
    }
  }

  const identifierLimit = await consumeRateLimit(
    "email_verification:identifier",
    normalised,
    { limit: 3, windowMs: 15 * 60 * 1000 }
  );
  if (!identifierLimit.allowed) {
    return {
      success: false,
      error: `Too many verification requests. Please try again in ${humanizeSeconds(
        identifierLimit.retryAfterSeconds
      )}.`,
    };
  }

  const turnstile = await verifyTurnstile({
    token: turnstileToken,
    action: TURNSTILE_ACTIONS.passwordReset,
    ip,
  });
  if (!turnstile.ok) {
    return {
      success: false,
      error:
        "Security verification failed. Please complete the challenge again and retry.",
    };
  }

  const user = await db.user.findUnique({
    where: { email: normalised },
    select: { id: true, status: true, emailVerified: true, tenantId: true },
  });

  if (!user || user.status !== "active" || user.emailVerified) {
    return { success: true };
  }

  const result = await issueEmailVerification(user.id);
  if (result.reason === "cooldown") {
    // Keep the same outward response; the previous link is still valid.
    return { success: true };
  }
  if (!result.sent && result.reason === "send_failed") {
    // Generic response: an address-existence oracle is not acceptable.
    console.error("[auth] Verification email delivery failed for an eligible account.");
    return { success: true };
  }

  await createAuditLog({
    userId: user.id,
    tenantId: user.tenantId,
    action: "auth.email_verification_requested",
    entityType: "user",
    entityId: user.id,
    ipAddress: ip ?? undefined,
  });

  return { success: true };
}

/** Verify an email token. The token is single-use and expires after 24 hours. */
export async function confirmEmailVerification(
  token: string
): Promise<VerificationResponse> {
  const result = await consumeEmailVerification(token);
  if (!result.ok) {
    const message =
      result.reason === "expired"
        ? "This verification link has expired. Request a new one."
        : result.reason === "used"
          ? "This verification link has already been used."
          : result.reason === "inactive"
            ? "This account is not available. Contact your administrator."
            : "This verification link is invalid. Request a new one.";
    return { success: false, error: message };
  }
  await createAuditLog({
    userId: result.userId,
    action: "auth.email_verified",
    entityType: "user",
    entityId: result.userId,
  });
  return { success: true, verified: true };
}
