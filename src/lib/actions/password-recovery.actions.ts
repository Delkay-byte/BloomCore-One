"use server";

import { db } from "@/lib/db";
import { hashPassword, revokeAllUserSessions } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { createHash, randomBytes } from "crypto";
import { headers } from "next/headers";
import { getClientIp } from "@/lib/security/client-ip";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { humanizeSeconds } from "@/lib/security/auth-guard";
import { logSecurityEvent } from "@/lib/security/log";
import { validatePasswordPolicy } from "@/lib/platform-auth";
import { TURNSTILE_ACTIONS } from "@/lib/security/turnstile-actions";

export interface ActionResponse {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash a string (for token storage). */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Generate a cryptographically secure random token (URL-safe). */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

async function currentIp(): Promise<string | null> {
  try {
    return getClientIp(await headers()).ip;
  } catch {
    return null;
  }
}

/**
 * Recovery requests are rate limited per IP and per identifier, and require a
 * Turnstile token whenever Turnstile is enabled. The response is identical for
 * every request so it cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(
  email: string,
  turnstileToken?: string | null
): Promise<ActionResponse> {
  const normalisedEmail = email.trim().toLowerCase();
  const genericSuccess: ActionResponse = { success: true };

  if (!normalisedEmail || normalisedEmail.length > 320) return genericSuccess;

  const ip = await currentIp();

  if (ip) {
    const ipLimit = await consumeRateLimit(
      "password_reset:ip",
      ip,
      RATE_LIMITS.passwordResetIp
    );
    if (!ipLimit.allowed) {
      return {
        success: false,
        error: `Too many recovery requests. Please try again in ${humanizeSeconds(
          ipLimit.retryAfterSeconds
        )}.`,
      };
    }
  }

  const identifierLimit = await consumeRateLimit(
    "password_reset:identifier",
    normalisedEmail,
    { limit: 3, windowMs: 15 * 60 * 1000 }
  );
  if (!identifierLimit.allowed) {
    return {
      success: false,
      error: `Too many recovery requests. Please try again in ${humanizeSeconds(
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
    logSecurityEvent({
      event: "password_reset.turnstile_failed",
      outcome: "blocked",
      route: "password_reset",
      ip,
      reason: turnstile.reason,
    });
    return {
      success: false,
      error:
        "Security verification failed. Please complete the challenge again and retry.",
    };
  }

  const user = await db.user.findUnique({
    where: { email: normalisedEmail },
  });

  if (!user || user.status !== "active") {
    // Same timing-independent response. No token is generated for an unknown
    // account, but the caller cannot tell the difference.
    return genericSuccess;
  }

  await db.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  const rawToken = generateToken();
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tenantId: user.tenantId,
      tokenHash,
      expiresAt,
    },
  });

  await createAuditLog({
    userId: user.id,
    tenantId: user.tenantId,
    action: "auth.password_recovery_requested",
    entityType: "user",
    entityId: user.id,
    ipAddress: ip ?? undefined,
  });

  /*
   * No email provider is configured in this deployment. The raw token must
   * NEVER be returned to the browser (that would be an account-takeover
   * primitive). Delivery is an outstanding owner action documented in
   * docs/security/PRODUCTION-SECURITY-ROLLOUT.md.
   */
  if (process.env.PASSWORD_RESET_DELIVERY === "console") {
    console.warn(
      "[SECURITY] Password reset token generated but no email channel is configured. " +
        "Delivery is blocked until an email provider is integrated."
    );
  }

  return genericSuccess;
}

// ---------------------------------------------------------------------------
// Verify recovery token
// ---------------------------------------------------------------------------

async function verifyRecoveryToken(
  token: string
): Promise<{ valid: true; userId: string } | { valid: false; error: string }> {
  if (!token || token.length > 512) {
    return { valid: false, error: "This recovery link is invalid or has expired." };
  }
  const tokenHash = sha256(token);

  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!record || record.usedAt || new Date() > record.expiresAt) {
    return {
      valid: false,
      error: "This recovery link is invalid or has expired. Please request a new one.",
    };
  }

  return { valid: true, userId: record.userId };
}

// ---------------------------------------------------------------------------
// Complete password reset
// ---------------------------------------------------------------------------

export async function completePasswordReset(params: {
  token: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<ActionResponse> {
  const { token, newPassword, confirmPassword } = params;

  const ip = await currentIp();
  if (ip) {
    const limit = await consumeRateLimit(
      "password_reset_submit:ip",
      ip,
      RATE_LIMITS.passwordResetSubmitIp
    );
    if (!limit.allowed) {
      return {
        success: false,
        error: `Too many reset attempts. Please try again in ${humanizeSeconds(
          limit.retryAfterSeconds
        )}.`,
      };
    }
  }

  if (!newPassword || newPassword !== confirmPassword) {
    return { success: false, error: "Passwords don't match" };
  }

  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) return { success: false, error: policyError };

  const tokenResult = await verifyRecoveryToken(token);
  if (!tokenResult.valid) {
    return { success: false, error: tokenResult.error };
  }

  const { userId } = tokenResult;
  const newHash = await hashPassword(newPassword);

  // The token is consumed and the password changed in one transaction. The
  // conditional update ensures concurrent submissions cannot both succeed.
  const consumed = await db.$transaction(async (tx) => {
    const update = await tx.passwordResetToken.updateMany({
      where: {
        tokenHash: sha256(token),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (update.count !== 1) return false;

    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        forcePasswordReset: false,
        tokenVersion: { increment: 1 },
      },
    });
    return true;
  });

  if (!consumed) {
    return {
      success: false,
      error: "This recovery link has already been used. Please request a new one.",
    };
  }

  await revokeAllUserSessions("user", userId, "password_reset");

  await createAuditLog({
    userId,
    action: "auth.password_recovery_completed",
    entityType: "user",
    entityId: userId,
    ipAddress: ip ?? undefined,
  });

  logSecurityEvent({
    event: "auth.password_reset_completed",
    outcome: "success",
    actorType: "user",
    actorId: userId,
    ip,
  });

  return { success: true };
}
