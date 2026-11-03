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
  verifyTotpStep,
} from "./totp";
import { logSecurityEvent } from "./log";

/**
 * TOTP multi-factor authentication for platform operators and tenant
 * administrators.
 *
 * Secrets are encrypted with AES-256-GCM before storage. Recovery codes are
 * stored only as SHA-256 hashes and each code is removed on first use.
 */

export type MfaSubjectType = "user" | "platform" | "customer";

interface MfaRow {
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaRecoveryCodes: string | null;
}

const ISSUER = "BloomCore One";

function actorTypeFor(
  subjectType: MfaSubjectType
): "user" | "platform_admin" | "customer" {
  if (subjectType === "platform") return "platform_admin";
  if (subjectType === "customer") return "customer";
  return "user";
}

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
  if (subjectType === "customer") {
    return db.customer.findUnique({
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
  } else if (subjectType === "customer") {
    await db.customer.update({ where: { id: subjectId }, data });
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
      actorType:
        params.subjectType === "platform"
          ? "platform_admin"
          : params.subjectType === "customer"
            ? "customer"
            : "user",
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
    actorType: actorTypeFor(params.subjectType),
    actorId: params.subjectId,
  });

  return { recoveryCodes };
}

export interface MfaVerification {
  ok: boolean;
  usedRecoveryCode: boolean;
}

/**
 * Atomically claim a TOTP time step. The conditional update is the concurrency
 * guard: across instances and PostgreSQL connections, only one request can move
 * mfaLastTotpStep forward to this step. A replay of the same or an older step
 * matches zero rows and is rejected.
 */
async function claimTotpStep(
  subjectType: MfaSubjectType,
  subjectId: string,
  step: number,
  now: number
): Promise<boolean> {
  const where = {
    id: subjectId,
    OR: [{ mfaLastTotpStep: null }, { mfaLastTotpStep: { lt: step } }],
  };
  const data = { mfaLastTotpStep: step, mfaLastUsedAt: new Date(now) };

  if (subjectType === "platform") {
    const result = await db.platformSuperAdmin.updateMany({ where, data });
    return result.count === 1;
  }
  if (subjectType === "customer") {
    const result = await db.customer.updateMany({ where, data });
    return result.count === 1;
  }
  const result = await db.user.updateMany({ where, data });
  return result.count === 1;
}

/** Verify a TOTP code or a single-use recovery code. */
export async function verifyMfaCode(params: {
  subjectType: MfaSubjectType;
  subjectId: string;
  code: string;
  /** Injectable clock for deterministic tests. */
  now?: number;
}): Promise<MfaVerification> {
  const row = await loadSubject(params.subjectType, params.subjectId);
  if (!row?.mfaEnabled || !row.mfaSecret) return { ok: false, usedRecoveryCode: false };

  const secret = decryptSecret(row.mfaSecret);
  if (!secret) return { ok: false, usedRecoveryCode: false };

  const now = params.now ?? Date.now();
  const step = verifyTotpStep(secret, params.code, now);
  if (step !== null) {
    const claimed = await claimTotpStep(params.subjectType, params.subjectId, step, now);
    if (!claimed) {
      logSecurityEvent({
        event: "mfa.totp_replay_rejected",
        outcome: "blocked",
        actorType: actorTypeFor(params.subjectType),
        actorId: params.subjectId,
        reason: "TOTP time step already consumed",
      });
      return { ok: false, usedRecoveryCode: false };
    }
    return { ok: true, usedRecoveryCode: false };
  }

  const recovery = consumeRecoveryCode(row.mfaRecoveryCodes, params.code);
  if (!recovery.ok) {
    logSecurityEvent({
      event: "mfa.verify_failed",
      outcome: "failure",
      actorType:
        params.subjectType === "platform"
          ? "platform_admin"
          : params.subjectType === "customer"
            ? "customer"
            : "user",
      actorId: params.subjectId,
    });
    return { ok: false, usedRecoveryCode: false };
  }

  // Recovery code is consumed in the same write that records the new list.
  await updateSubject(params.subjectType, params.subjectId, {
    mfaRecoveryCodes: recovery.remaining,
    mfaLastUsedAt: new Date(now),
  });
  logSecurityEvent({
    event: "mfa.recovery_code_used",
    outcome: "success",
    actorType: actorTypeFor(params.subjectType),
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
    actorType: actorTypeFor(params.subjectType),
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
