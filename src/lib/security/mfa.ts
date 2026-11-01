import QRCode from "qrcode";
import { db } from "../db";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "./totp";
import { logSecurityEvent } from "./log";

/**
 * TOTP multi-factor authentication for platform operators and tenant
 * administrators.
 *
 * Secrets are encrypted with AES-256-GCM before storage. Recovery codes are
 * stored only as SHA-256 hashes and each code is removed on first use.
 */

export type MfaSubjectType = "user" | "platform";

interface MfaRow {
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaRecoveryCodes: string | null;
}

const ISSUER = "BloomCore One";

async function loadSubject(
  subjectType: MfaSubjectType,
  subjectId: string
): Promise<MfaRow | null> {
  if (subjectType === "platform") {
    return db.platformSuperAdmin.findUnique({
      where: { id: subjectId },
      select: {
        mfaEnabled: true,
        mfaSecret: true,
        mfaRecoveryCodes: true,
      },
    });
  }
  return db.user.findUnique({
    where: { id: subjectId },
    select: {
      mfaEnabled: true,
      mfaSecret: true,
      mfaRecoveryCodes: true,
    },
  });
}

async function updateSubject(
  subjectType: MfaSubjectType,
  subjectId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (subjectType === "platform") {
    await db.platformSuperAdmin.update({ where: { id: subjectId }, data });
  } else {
    await db.user.update({ where: { id: subjectId }, data });
  }
}

export interface EnrollmentStart {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/**
 * Begin enrolment. The new secret is stored encrypted but MFA stays disabled
 * until the user proves possession by submitting a valid code.
 */
export async function beginMfaEnrollment(params: {
  subjectType: MfaSubjectType;
  subjectId: string;
  accountName: string;
}): Promise<EnrollmentStart> {
  const secret = generateTotpSecret();
  await updateSubject(params.subjectType, params.subjectId, {
    mfaSecret: encryptSecret(secret),
    mfaEnabled: false,
    mfaRecoveryCodes: null,
  });

  const url = otpauthUrl({
    secret,
    accountName: params.accountName,
    issuer: ISSUER,
  });
  const qrDataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
  });
  return { secret, otpauthUrl: url, qrDataUrl };
}

export interface EnrollmentResult {
  recoveryCodes: string[];
}

export async function confirmMfaEnrollment(params: {
  subjectType: MfaSubjectType;
  subjectId: string;
  code: string;
}): Promise<EnrollmentResult | null> {
  const row = await loadSubject(params.subjectType, params.subjectId);
  if (!row?.mfaSecret) return null;
  const secret = decryptSecret(row.mfaSecret);
  if (!secret) return null;
  if (!verifyTotp(secret, params.code)) {
    logSecurityEvent({
      event: "mfa.enrollment_failed",
      outcome: "failure",
      actorType: params.subjectType === "platform" ? "platform_admin" : "user",
      actorId: params.subjectId,
    });
    return null;
  }

  const recoveryCodes = generateRecoveryCodes(10);
  await updateSubject(params.subjectType, params.subjectId, {
    mfaEnabled: true,
    mfaEnrolledAt: new Date(),
    mfaLastUsedAt: new Date(),
    mfaRecoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
  });

  logSecurityEvent({
    event: "mfa.enrolled",
    outcome: "success",
    actorType: params.subjectType === "platform" ? "platform_admin" : "user",
    actorId: params.subjectId,
  });

  return { recoveryCodes };
}

export interface MfaVerification {
  ok: boolean;
  usedRecoveryCode: boolean;
}

/** Verify a TOTP code or a single-use recovery code. */
export async function verifyMfaCode(params: {
  subjectType: MfaSubjectType;
  subjectId: string;
  code: string;
}): Promise<MfaVerification> {
  const row = await loadSubject(params.subjectType, params.subjectId);
  if (!row?.mfaEnabled || !row.mfaSecret) return { ok: false, usedRecoveryCode: false };

  const secret = decryptSecret(row.mfaSecret);
  if (!secret) return { ok: false, usedRecoveryCode: false };

  if (verifyTotp(secret, params.code)) {
    await updateSubject(params.subjectType, params.subjectId, {
      mfaLastUsedAt: new Date(),
    });
    return { ok: true, usedRecoveryCode: false };
  }

  const recovery = consumeRecoveryCode(row.mfaRecoveryCodes, params.code);
  if (!recovery.ok) {
    logSecurityEvent({
      event: "mfa.verify_failed",
      outcome: "failure",
      actorType: params.subjectType === "platform" ? "platform_admin" : "user",
      actorId: params.subjectId,
    });
    return { ok: false, usedRecoveryCode: false };
  }

  // Recovery code is consumed in the same write that records the new list.
  await updateSubject(params.subjectType, params.subjectId, {
    mfaRecoveryCodes: recovery.remaining,
    mfaLastUsedAt: new Date(),
  });
  logSecurityEvent({
    event: "mfa.recovery_code_used",
    outcome: "success",
    actorType: params.subjectType === "platform" ? "platform_admin" : "user",
    actorId: params.subjectId,
  });
  return { ok: true, usedRecoveryCode: true };
}

/** Disable MFA after a fresh TOTP/recovery verification. */
export async function disableMfa(params: {
  subjectType: MfaSubjectType;
  subjectId: string;
  code: string;
}): Promise<boolean> {
  const verification = await verifyMfaCode(params);
  if (!verification.ok) return false;
  await updateSubject(params.subjectType, params.subjectId, {
    mfaEnabled: false,
    mfaSecret: null,
    mfaRecoveryCodes: null,
    mfaEnrolledAt: null,
    mfaLastUsedAt: null,
  });
  logSecurityEvent({
    event: "mfa.disabled",
    outcome: "success",
    actorType: params.subjectType === "platform" ? "platform_admin" : "user",
    actorId: params.subjectId,
  });
  return true;
}

export async function isMfaEnrolled(
  subjectType: MfaSubjectType,
  subjectId: string
): Promise<boolean> {
  const row = await loadSubject(subjectType, subjectId);
  return Boolean(row?.mfaEnabled);
}

/** Roles for which the "enforce" policy requires MFA. */
export function isPrivilegedSubject(role: string | undefined): boolean {
  return role === "admin";
}
