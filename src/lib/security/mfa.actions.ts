"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { headers } from "next/headers";
import { readMfaChallenge } from "@/lib/security/mfa-challenge";
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  verifyMfaCode,
} from "@/lib/security/mfa";
import { getClientIp } from "@/lib/security/client-ip";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { RATE_LIMITS } from "@/lib/security/config";
import { recordSecurityEvent } from "@/lib/security/events";
import { createAuditLog } from "@/lib/audit";
import { issueModuleSession } from "@/lib/session-issuance";
import {
  setPlatformSession,
  getPlatformAdminOrNull,
} from "@/lib/platform-auth";
import { getAdminSession, setModuleSession, verifyPassword } from "@/lib/auth";
import {
  consumeMfaChallenge,
  consumeMfaEnrollmentProof,
} from "@/lib/security/session-store";
import { createPasswordChangeChallenge } from "@/lib/security/password-change-challenge";
import { billingHref, resolveSubscriptionAccess } from "@/lib/billing/access";

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
  /** Issued only after a successful challenge; handed to this tab's worker. */
  sessionToken?: string;
  redirectTo?: string;
  /** Present instead of a session when the account must upgrade its password. */
  passwordChangeRequired?: boolean;
  challengeToken?: string;
}

async function clientIp(): Promise<string | null> {
  try {
    return getClientIp(await headers()).ip;
  } catch {
    return null;
  }
}

function mfaOutcomeResult(outcome: PostMfaOutcome): MfaActionResult {
  if (outcome.kind === "challenge") {
    return {
      success: true,
      passwordChangeRequired: true,
      challengeToken: outcome.token,
      redirectTo: outcome.redirectTo,
    };
  }
  return {
    success: true,
    sessionToken: outcome.token,
    redirectTo: outcome.redirectTo,
  };
}

function dashboardFor(module: string): string {
  if (module === "platform") return "/platform/dashboard";
  if (module === "admin") return "/admin/dashboard";
  if (module === "momo") return "/worker/dashboard";
  if (module === "susu") return "/collector/dashboard";
  return "/customer/dashboard";
}

/** SEC-15: per-subject limit for every MFA management mutation. */
async function mfaManagementLimited(
  scope: string,
  identifier: string
): Promise<string | null> {
  const result = await consumeRateLimit(scope, identifier, RATE_LIMITS.mfaSubject);
  return result.allowed ? null : "Too many attempts. Please wait and try again.";
}

/**
 * Residual F: a first MFA enrolment is only accepted once the account's
 * recovery channel is already trusted. A user must have verified their e-mail
 * address; a platform administrator is provisioned through the owner-run
 * bootstrap (an administrator-issued invitation) and has no separate mailbox
 * proof. The check runs at start AND at confirm, so an account whose address
 * was un-verified in between cannot complete enrolment.
 */
async function enrollmentChannelVerified(
  subjectType: string,
  subjectId: string
): Promise<boolean> {
  if (subjectType === "user") {
    const row = await db.user.findUnique({
      where: { id: subjectId },
      select: { emailVerified: true, status: true },
    });
    return Boolean(row && row.status === "active" && row.emailVerified);
  }
  if (subjectType === "platform") {
    const row = await db.platformSuperAdmin.findUnique({
      where: { id: subjectId },
      select: { status: true },
    });
    return Boolean(row && row.status === "active");
  }
  if (subjectType === "customer") {
    const row = await db.customer.findUnique({
      where: { id: subjectId },
      select: { status: true },
    });
    return Boolean(row && row.status === "active");
  }
  return false;
}

async function notifyMfaChange(email: string | null, action: string): Promise<void> {
  if (!email) return;
  const subject =
    action === "disable"
      ? "MaaCash: multi-factor authentication disabled"
      : "MaaCash: multi-factor authentication changed";
  const text =
    action === "disable"
      ? "Multi-factor authentication was disabled on your MaaCash account. If you did not do this, contact your administrator immediately."
      : "The multi-factor authentication settings on your MaaCash account were changed. If you did not do this, contact your administrator immediately.";
  await sendTransactionalEmail({
    to: email,
    subject,
    text,
    html: `<p>${text}</p>`,
    tag: "security_notification",
  }).catch(() => undefined);
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

type PostMfaOutcome =
  | { kind: "session"; token: string; redirectTo: string }
  | {
      kind: "challenge";
      token: string;
      redirectTo: string;
      passwordChangeRequired: true;
    };

async function issueSessionFromChallenge(challenge: {
  module: string;
  subjectId: string;
  tokenVersion: number;
}): Promise<PostMfaOutcome> {
  if (challenge.module === "platform") {
    const admin = await db.platformSuperAdmin.findUnique({
      where: { id: challenge.subjectId },
    });
    if (!admin || admin.status !== "active") throw new Error("Account unavailable");
    if (admin.tokenVersion !== challenge.tokenVersion) {
      throw new Error("Session expired. Please sign in again.");
    }
    if (admin.forcePasswordReset) {
      return {
        kind: "challenge",
        passwordChangeRequired: true,
        token: await createPasswordChangeChallenge("platform", admin.id, "platform"),
        redirectTo: "/password-upgrade?required=1",
      };
    }
    const token = await setPlatformSession({
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      forcePasswordReset: false,
      tokenVersion: admin.tokenVersion,
      amr: "pwd+mfa",
    });
    return { kind: "session", token, redirectTo: "/platform/dashboard" };
  }

  if (challenge.module === "customer") {
    const customer = await db.customer.findUnique({
      where: { id: challenge.subjectId },
    });
    if (!customer || customer.status !== "active" || !customer.portalEnabled) {
      throw new Error("Account unavailable");
    }
    if ((customer.tokenVersion ?? 0) !== challenge.tokenVersion) {
      throw new Error("Session expired. Please sign in again.");
    }
    if (customer.forcePortalPasswordReset) {
      return {
        kind: "challenge",
        passwordChangeRequired: true,
        token: await createPasswordChangeChallenge("customer", customer.id, "customer"),
        redirectTo: "/password-upgrade?required=1",
      };
    }
    const token = await setModuleSession("customer", {
      userId: customer.id,
      email: customer.email || `${customer.customerId}@bloomcore.local`,
      fullName: customer.fullName,
      role: "customer",
      modules: ["customer"],
      module: "customer",
      tenantId: customer.tenantId,
      forcePasswordReset: false,
      tokenVersion: customer.tokenVersion ?? 0,
      amr: "pwd+mfa",
    });
    return { kind: "session", token, redirectTo: "/customer/dashboard" };
  }

  const user = await db.user.findUnique({ where: { id: challenge.subjectId } });
  if (!user || user.status !== "active") throw new Error("Account unavailable");
  if (!user.emailVerified) throw new Error("Verify your email address before signing in.");
  if (user.tokenVersion !== challenge.tokenVersion) {
    throw new Error("Session expired. Please sign in again.");
  }

  const sessionModule = challenge.module as "admin" | "momo" | "susu";
  if (user.tenantId) {
    const tenant = await db.businessTenant.findUnique({
      where: { id: user.tenantId },
      select: { status: true },
    });
    if (!tenant || (tenant.status !== "ACTIVE" && tenant.status !== "PENDING_PAYMENT")) {
      throw new Error(
        "This business workspace is not available. Contact your platform administrator."
      );
    }
  }
  if (user.forcePasswordReset) {
    return {
      kind: "challenge",
      passwordChangeRequired: true,
      token: await createPasswordChangeChallenge("user", user.id, sessionModule),
      redirectTo: "/password-upgrade?required=1",
    };
  }
  const issued = await issueModuleSession(user.id, sessionModule, true);
  let redirectTo = dashboardFor(sessionModule);
  if (sessionModule === "admin" && user.tenantId && !issued.payload.forcePasswordReset) {
    const access = await resolveSubscriptionAccess(user.tenantId);
    if (!access.operable && access.billingRequired) {
      redirectTo = billingHref(access.reason);
    }
  }
  return {
    kind: "session",
    token: issued.token,
    redirectTo,
  };
}

/** Step 1 (enrolment mode): show the QR code for a fresh secret. */
export async function startMfaEnrollmentAction(
  challengeToken: string
): Promise<MfaActionResult> {
  const challenge = await readMfaChallenge(challengeToken);
  if (!challenge || challenge.mode !== "enroll") {
    return { success: false, error: "Enrolment session expired. Please sign in again." };
  }

  const limited = await mfaManagementLimited(
    "mfa:enroll",
    `${challenge.subjectType}:${challenge.subjectId}`
  );
  if (limited) return { success: false, error: limited };

  if (!(await enrollmentChannelVerified(challenge.subjectType, challenge.subjectId))) {
    return {
      success: false,
      error:
        "Verify your e-mail address before enrolling multi-factor authentication.",
    };
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
  const challenge = await readMfaChallenge(
    String(formData.get("challenge") ?? "")
  );
  if (!challenge || challenge.mode !== "enroll") {
    return { success: false, error: "Enrolment session expired. Please sign in again." };
  }

  const limited = await mfaManagementLimited(
    "mfa:confirm",
    `${challenge.subjectType}:${challenge.subjectId}`
  );
  if (limited) return { success: false, error: limited };

  if (!(await enrollmentChannelVerified(challenge.subjectType, challenge.subjectId))) {
    return {
      success: false,
      error:
        "Verify your e-mail address before enrolling multi-factor authentication.",
    };
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

  // Record server-side proof that the TOTP code was accepted. finish cannot
  // mint a session without consuming this row, so calling finish directly
  // cannot bypass enrolment.
  if (!challenge.jti) {
    return { success: false, error: "Enrolment session expired. Please sign in again." };
  }
  const proven = await consumeMfaChallenge({
    id: challenge.jti,
    purpose: "enrolled",
    subjectType: challenge.subjectType,
    subjectId: challenge.subjectId,
    expiresAt: new Date((challenge.exp ?? Math.floor(Date.now() / 1000) + 300) * 1000),
  });
  if (!proven) {
    return { success: false, error: "This enrolment was already completed. Please sign in again." };
  }

  await notifyMfaChange(challenge.email, "enroll");
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

export async function finishMfaEnrollmentAction(
  formData: FormData
): Promise<MfaActionResult> {
  const challenge = await readMfaChallenge(
    String(formData.get("challenge") ?? "")
  );
  if (!challenge || challenge.mode !== "enroll") {
    return { success: false, error: "Enrolment session expired. Please sign in again." };
  }
  if (!challenge.jti) {
    return { success: false, error: "Enrolment session expired. Please sign in again." };
  }
  const proven = await consumeMfaEnrollmentProof(challenge.jti);
  if (!proven) {
    return {
      success: false,
      error: "Enrolment was not confirmed. Verify a code before continuing.",
    };
  }
  let issued: PostMfaOutcome;
  try {
    issued = await issueSessionFromChallenge(challenge);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not open a session.",
    };
  }
  return mfaOutcomeResult(issued);
}

/** Verify a TOTP/recovery code for a pending login and open the session. */
export async function verifyMfaLoginAction(
  formData: FormData
): Promise<MfaActionResult> {
  const challenge = await readMfaChallenge(
    String(formData.get("challenge") ?? "")
  );
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
    recordSecurityEvent({
      event: "mfa.login_verify_failed",
      outcome: "failure",
      actorType: challenge.subjectType === "platform" ? "platform_admin" : "user",
      actorId: challenge.subjectId,
      ip,
    });
    return { success: false, error: "Invalid verification code. Please try again." };
  }

  if (!challenge.jti) {
    return { success: false, error: "Your verification session expired. Please sign in again." };
  }
  const claimed = await consumeMfaChallenge({
    id: challenge.jti,
    purpose: "verified",
    subjectType: challenge.subjectType,
    subjectId: challenge.subjectId,
    expiresAt: new Date((challenge.exp ?? Math.floor(Date.now() / 1000) + 300) * 1000),
  });
  if (!claimed) {
    return {
      success: false,
      error: "This verification was already used. Please sign in again.",
    };
  }

  let issued: PostMfaOutcome;
  try {
    issued = await issueSessionFromChallenge(challenge);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not open a session.",
    };
  }

  await createAuditLog({
    userId: challenge.subjectId,
    action: verification.usedRecoveryCode
      ? "auth.mfa_recovery_code_used"
      : "auth.mfa_verified",
    entityType: challenge.subjectType === "platform" ? "platform_admin" : "user",
    entityId: challenge.subjectId,
  });

  return mfaOutcomeResult(issued);
}

/** Settings: start enrolment for the currently authenticated account. */
export async function selfEnrollmentAction(restart = false): Promise<MfaActionResult> {
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
      restart,
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
    const reason = await mfaManagementLimited(
      "mfa:enroll",
      `platform:${platform.adminId}`
    );
    if (reason) return { success: false, error: reason };
    const enrollment = await beginMfaEnrollment({
      subjectType: "platform",
      subjectId: platform.adminId,
      accountName: platform.email,
      restart,
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
    const reason = await mfaManagementLimited(`mfa:confirm`, `user:${admin.userId}`);
    if (reason) return { success: false, error: reason };
    const result = await confirmMfaEnrollment({
      subjectType: "user",
      subjectId: admin.userId,
      code,
    });
    if (!result) return { success: false, error: "That code is not valid." };
    await notifyMfaChange(admin.email, "enroll");
    return { success: true, recoveryCodes: result.recoveryCodes };
  }

  const platform = await getPlatformAdminOrNull();
  if (platform) {
    const reason = await mfaManagementLimited(
      `mfa:confirm`,
      `platform:${platform.adminId}`
    );
    if (reason) return { success: false, error: reason };
    const result = await confirmMfaEnrollment({
      subjectType: "platform",
      subjectId: platform.adminId,
      code,
    });
    if (!result) return { success: false, error: "That code is not valid." };
    await notifyMfaChange(platform.email, "enroll");
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
  const reasonText = String(formData.get("reason") ?? "").trim();
  const confirmed = String(formData.get("confirm") ?? "") === "on";

  if (!confirmed) {
    return { success: false, error: "Confirm that you want to disable MFA." };
  }
  if (reasonText.length < 10 || reasonText.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }

  const admin = await getAdminSession();
  if (admin) {
    const limited = await mfaManagementLimited("mfa:disable", `user:${admin.userId}`);
    if (limited) return { success: false, error: limited };
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
    await createAuditLog({
      userId: admin.userId,
      action: "auth.mfa_disabled",
      entityType: "user",
      entityId: admin.userId,
      details: { reason: reasonText },
    });
    await notifyMfaChange(user.email, "disable");
    revalidatePath("/settings/mfa");
    return { success: true };
  }

  const platform = await getPlatformAdminOrNull();
  if (platform) {
    const limited = await mfaManagementLimited(
      "mfa:disable",
      `platform:${platform.adminId}`
    );
    if (limited) return { success: false, error: limited };
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
    await createAuditLog({
      userId: platform.adminId,
      action: "auth.mfa_disabled",
      entityType: "platform_admin",
      entityId: platform.adminId,
      details: { reason: reasonText },
    });
    await notifyMfaChange(adminRow.email, "disable");
    return { success: true };
  }

  return { success: false, error: "Not authenticated." };
}
