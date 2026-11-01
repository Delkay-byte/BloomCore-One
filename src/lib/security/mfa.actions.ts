"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { headers } from "next/headers";
import {
  clearMfaChallenge,
  readMfaChallenge,
} from "@/lib/security/mfa-challenge";
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  verifyMfaCode,
} from "@/lib/security/mfa";
import { getClientIp } from "@/lib/security/client-ip";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { logSecurityEvent } from "@/lib/security/log";
import { createAuditLog } from "@/lib/audit";
import { issueModuleSession } from "@/lib/actions/auth.actions";
import {
  setPlatformSession,
  getPlatformAdminOrNull,
} from "@/lib/platform-auth";
import { getAdminSession, verifyPassword } from "@/lib/auth";

/**
 * MFA server actions.
 *
 * Challenge flows (no session yet):
 *   startEnrollmentAction / confirmEnrollmentAction / verifyMfaLoginAction
 *
 * Settings flows (already authenticated):
 *   selfEnrollmentAction / selfConfirmAction / selfDisableAction
 */

export interface MfaActionResult {
  success: boolean;
  error?: string;
  qrDataUrl?: string;
  manualKey?: string;
  recoveryCodes?: string[];
}

async function clientIp(): Promise<string | null> {
  try {
    return getClientIp(await headers()).ip;
  } catch {
    return null;
  }
}

function dashboardFor(module: string): string {
  if (module === "platform") return "/platform/dashboard";
  if (module === "admin") return "/admin/dashboard";
  if (module === "momo") return "/worker/dashboard";
  if (module === "susu") return "/collector/dashboard";
  return "/customer/dashboard";
}

async function mfaRateLimited(
  scope: string,
  identifier: string,
  policy: { limit: number; windowMs: number }
): Promise<string | null> {
  const result = await consumeRateLimit(scope, identifier, policy);
  if (result.allowed) return null;
  return `Too many verification attempts. Please wait ${Math.ceil(
    result.retryAfterSeconds / 60
  )} minute(s) and try again.`;
}

async function issueSessionFromChallenge(challenge: {
  module: string;
  subjectId: string;
}): Promise<void> {
  if (challenge.module === "platform") {
    const admin = await db.platformSuperAdmin.findUnique({
      where: { id: challenge.subjectId },
    });
    if (!admin || admin.status !== "active") throw new Error("Account unavailable");
    await setPlatformSession({
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      forcePasswordReset: admin.forcePasswordReset,
      tokenVersion: admin.tokenVersion,
    });
    return;
  }

  const user = await db.user.findUnique({ where: { id: challenge.subjectId } });
  if (!user || user.status !== "active") throw new Error("Account unavailable");

  const sessionModule = challenge.module as "admin" | "momo" | "susu";
  await issueModuleSession(user.id, sessionModule);
}

/** Step 1 (enrolment mode): show the QR code for a fresh secret. */
export async function startMfaEnrollmentAction(): Promise<MfaActionResult> {
  const challenge = await readMfaChallenge();
  if (!challenge || challenge.mode !== "enroll") {
    return { success: false, error: "Enrolment session expired. Please sign in again." };
  }

  const enrollment = await beginMfaEnrollment({
    subjectType: challenge.subjectType,
    subjectId: challenge.subjectId,
    accountName: challenge.email,
  });

  return {
    success: true,
    qrDataUrl: enrollment.qrDataUrl,
    manualKey: enrollment.secret,
  };
}

/** Step 2: confirm the first code, receive recovery codes, open the session. */
export async function confirmMfaEnrollmentAction(
  formData: FormData
): Promise<MfaActionResult> {
  const challenge = await readMfaChallenge();
  if (!challenge || challenge.mode !== "enroll") {
    return { success: false, error: "Enrolment session expired. Please sign in again." };
  }

  const code = String(formData.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    return { success: false, error: "Enter the 6-digit code from your authenticator app." };
  }

  const result = await confirmMfaEnrollment({
    subjectType: challenge.subjectType,
    subjectId: challenge.subjectId,
    code,
  });
  if (!result) {
    return { success: false, error: "That code is not valid. Check the time on your device and try again." };
  }

  await createAuditLog({
    userId: challenge.subjectId,
    action: "auth.mfa_enrolled",
    entityType: challenge.subjectType === "platform" ? "platform_admin" : "user",
    entityId: challenge.subjectId,
  });

  // Keep the challenge until the person has seen the recovery codes; the
  // session is issued by finishMfaEnrollmentAction below.
  return { success: true, recoveryCodes: result.recoveryCodes };
}

export async function finishMfaEnrollmentAction(): Promise<void> {
  const challenge = await readMfaChallenge();
  if (!challenge || challenge.mode !== "enroll") {
    redirect("/login");
  }
  await issueSessionFromChallenge(challenge);
  await clearMfaChallenge();
  redirect(dashboardFor(challenge.module));
}

/** Verify a TOTP/recovery code for a pending login and open the session. */
export async function verifyMfaLoginAction(
  formData: FormData
): Promise<MfaActionResult> {
  const challenge = await readMfaChallenge();
  if (!challenge || challenge.mode !== "verify") {
    return { success: false, error: "Your verification session expired. Please sign in again." };
  }

  const ip = await clientIp();
  const ipError = await mfaRateLimited(
    "mfa:ip",
    ip ?? "unknown",
    RATE_LIMITS.mfaIp
  );
  if (ipError) return { success: false, error: ipError };

  const subjectError = await mfaRateLimited(
    "mfa:subject",
    `${challenge.subjectType}:${challenge.subjectId}`,
    RATE_LIMITS.mfaSubject
  );
  if (subjectError) return { success: false, error: subjectError };

  const code = String(formData.get("code") ?? "").trim();
  if (!/^[0-9A-Za-z-]{6,20}$/.test(code)) {
    return { success: false, error: "Enter a verification code." };
  }

  const verification = await verifyMfaCode({
    subjectType: challenge.subjectType,
    subjectId: challenge.subjectId,
    code,
  });
  if (!verification.ok) {
    logSecurityEvent({
      event: "mfa.login_verify_failed",
      outcome: "failure",
      actorType: challenge.subjectType === "platform" ? "platform_admin" : "user",
      actorId: challenge.subjectId,
      ip,
    });
    return { success: false, error: "Invalid verification code. Please try again." };
  }

  await issueSessionFromChallenge(challenge);
  await clearMfaChallenge();

  await createAuditLog({
    userId: challenge.subjectId,
    action: verification.usedRecoveryCode
      ? "auth.mfa_recovery_code_used"
      : "auth.mfa_verified",
    entityType: challenge.subjectType === "platform" ? "platform_admin" : "user",
    entityId: challenge.subjectId,
  });

  redirect(dashboardFor(challenge.module));
}

/** Settings: start enrolment for the currently authenticated account. */
export async function selfEnrollmentAction(): Promise<MfaActionResult> {
  const admin = await getAdminSession();
  if (admin) {
    const row = await db.user.findUnique({
      where: { id: admin.userId },
      select: { mfaEnabled: true },
    });
    if (row?.mfaEnabled) {
      return {
        success: false,
        error: "MFA is already enabled. Disable it first to enrol a new device.",
      };
    }
    const reason = await mfaRateLimited(
      "mfa:enroll",
      `user:${admin.userId}`,
      { limit: 5, windowMs: 10 * 60 * 1000 }
    );
    if (reason) return { success: false, error: reason };
    const enrollment = await beginMfaEnrollment({
      subjectType: "user",
      subjectId: admin.userId,
      accountName: admin.email,
    });
    return {
      success: true,
      qrDataUrl: enrollment.qrDataUrl,
      manualKey: enrollment.secret,
    };
  }

  const platform = await getPlatformAdminOrNull();
  if (platform) {
    const row = await db.platformSuperAdmin.findUnique({
      where: { id: platform.adminId },
      select: { mfaEnabled: true },
    });
    if (row?.mfaEnabled) {
      return {
        success: false,
        error: "MFA is already enabled. Disable it first to enrol a new device.",
      };
    }
    const enrollment = await beginMfaEnrollment({
      subjectType: "platform",
      subjectId: platform.adminId,
      accountName: platform.email,
    });
    return {
      success: true,
      qrDataUrl: enrollment.qrDataUrl,
      manualKey: enrollment.secret,
    };
  }

  return { success: false, error: "Sign in as an administrator to manage MFA." };
}

export async function selfConfirmAction(
  formData: FormData
): Promise<MfaActionResult> {
  const code = String(formData.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    return { success: false, error: "Enter the 6-digit code from your authenticator app." };
  }

  const admin = await getAdminSession();
  if (admin) {
    const result = await confirmMfaEnrollment({
      subjectType: "user",
      subjectId: admin.userId,
      code,
    });
    if (!result) return { success: false, error: "That code is not valid." };
    return { success: true, recoveryCodes: result.recoveryCodes };
  }

  const platform = await getPlatformAdminOrNull();
  if (platform) {
    const result = await confirmMfaEnrollment({
      subjectType: "platform",
      subjectId: platform.adminId,
      code,
    });
    if (!result) return { success: false, error: "That code is not valid." };
    return { success: true, recoveryCodes: result.recoveryCodes };
  }

  return { success: false, error: "Not authenticated." };
}

/** Settings: disable MFA after password + current code re-verification. */
export async function selfDisableAction(
  formData: FormData
): Promise<MfaActionResult> {
  const password = String(formData.get("password") ?? "");
  const code = String(formData.get("code") ?? "").trim();

  const admin = await getAdminSession();
  if (admin) {
    const user = await db.user.findUnique({ where: { id: admin.userId } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return { success: false, error: "Password is incorrect." };
    }
    const disabled = await disableMfa({
      subjectType: "user",
      subjectId: admin.userId,
      code,
    });
    if (!disabled) return { success: false, error: "Verification code is invalid." };
    revalidatePath("/settings/mfa");
    return { success: true };
  }

  const platform = await getPlatformAdminOrNull();
  if (platform) {
    const adminRow = await db.platformSuperAdmin.findUnique({
      where: { id: platform.adminId },
    });
    if (!adminRow || !(await verifyPassword(password, adminRow.passwordHash))) {
      return { success: false, error: "Password is incorrect." };
    }
    const disabled = await disableMfa({
      subjectType: "platform",
      subjectId: platform.adminId,
      code,
    });
    if (!disabled) return { success: false, error: "Verification code is invalid." };
    return { success: true };
  }

  return { success: false, error: "Not authenticated." };
}
