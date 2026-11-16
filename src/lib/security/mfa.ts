import QRCode from "qrcode";
import { db } from "../db";
import { decryptSecret, encryptSecret } from "./crypto";
import {
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
  mfaPendingSecretAt?: Date | null;
}

const ISSUER = "MaaCash";

/** A pending TOTP secret is reused for this long before it is replaced. */
export const MFA_ENROLLMENT_PENDING_TTL_MS = 15 * 60 * 1000;

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
        mfaPendingSecretAt: true,
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
        mfaPendingSecretAt: true,
      },
    });
  }
  return db.user.findUnique({
    where: { id: subjectId },
    select: {
      mfaEnabled: true,
      mfaSecret: true,
      mfaRecoveryCodes: true,
      mfaPendingSecretAt: true,
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

/**
 * SEC-07: persist one hashed recovery code per row, replacing any previous set.
 * Plaintext codes never reach storage and are shown to the user exactly once.
 */
async function replaceRecoveryCodes(
  subjectType: MfaSubjectType,
  subjectId: string,
  plainCodes: string[]
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { subjectType, subjectId } });
    await tx.mfaRecoveryCode.createMany({
      data: plainCodes.map((code) => ({
        subjectType,
        subjectId,
        codeHash: hashRecoveryCode(code),
      })),
    });
    // The legacy JSON array is retired in the same transaction so there is no
    // second, non-atomic source of truth.
    if (subjectType === "platform") {
      await tx.platformSuperAdmin.update({
        where: { id: subjectId },
        data: { mfaRecoveryCodes: null },
      });
    } else if (subjectType === "customer") {
      await tx.customer.update({
        where: { id: subjectId },
        data: { mfaRecoveryCodes: null },
      });
    } else {
      await tx.user.update({
        where: { id: subjectId },
        data: { mfaRecoveryCodes: null },
      });
    }
  });
}

/** Copy any legacy JSON hashes into rows before the first consumption. */
async function ensureRecoveryCodesMigrated(
  subjectType: MfaSubjectType,
  subjectId: string,
  legacyJson: string | null
): Promise<void> {
  if (!legacyJson) return;
  let hashes: string[] = [];
  try {
    const parsed = JSON.parse(legacyJson);
    if (Array.isArray(parsed)) {
      hashes = parsed.filter(
        (item): item is string =>
          typeof item === "string" && /^[0-9a-f]{64}$/.test(item)
      );
    }
  } catch {
    return;
  }
  if (hashes.length === 0) return;
  const unique = Array.from(new Set(hashes));
  await db.mfaRecoveryCode.createMany({
    data: unique.map((codeHash) => ({ subjectType, subjectId, codeHash })),
  });
}

/**
 * Conditionally consume one recovery code. The `usedAt: null` filter is the
 * concurrency gate: across connections and instances exactly one request can
 * claim the row.
 */
async function consumeRecoveryCodeAtomic(
  subjectType: MfaSubjectType,
  subjectId: string,
  code: string,
  now: number
): Promise<boolean> {
  const codeHash = hashRecoveryCode(code);
  const row = await db.mfaRecoveryCode.findUnique({
    where: {
      subjectType_subjectId_codeHash: { subjectType, subjectId, codeHash },
    },
    select: { id: true, usedAt: true },
  });
  if (!row || row.usedAt) return false;
  const claimed = await db.mfaRecoveryCode.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date(now) },
  });
  return claimed.count === 1;
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
  /** Explicit user restart discards the pending secret instead of reusing it. */
  restart?: boolean;
}): Promise<EnrollmentStart> {
  const existing = await loadSubject(params.subjectType, params.subjectId);
  const pendingAgeMs =
    existing?.mfaPendingSecretAt != null
      ? Date.now() - existing.mfaPendingSecretAt.getTime()
      : Number.POSITIVE_INFINITY;
  if (
    !params.restart &&
    existing?.mfaSecret &&
    !existing.mfaEnabled &&
    pendingAgeMs < MFA_ENROLLMENT_PENDING_TTL_MS
  ) {
    // SEC-15: repeated start requests return the same unexpired pending secret
    // instead of silently replacing the QR the user is currently scanning.
    const pendingSecret = decryptSecret(existing.mfaSecret);
    if (pendingSecret) {
      const pendingUrl = otpauthUrl({
        secret: pendingSecret,
        accountName: params.accountName,
        issuer: ISSUER,
      });
      return {
        secret: pendingSecret,
        otpauthUrl: pendingUrl,
        qrDataUrl: await QRCode.toDataURL(pendingUrl, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 240,
        }),
      };
    }
  }

  const secret = generateTotpSecret();
  await updateSubject(params.subjectType, params.subjectId, {
    mfaSecret: encryptSecret(secret),
    mfaEnabled: false,
    mfaRecoveryCodes: null,
    mfaPendingSecretAt: new Date(),
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
  await replaceRecoveryCodes(params.subjectType, params.subjectId, recoveryCodes);
  await updateSubject(params.subjectType, params.subjectId, {
    mfaEnabled: true,
    mfaEnrolledAt: new Date(),
    mfaLastUsedAt: new Date(),
    mfaPendingSecretAt: null,
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

  await ensureRecoveryCodesMigrated(
    params.subjectType,
    params.subjectId,
    row.mfaRecoveryCodes
  );
  const consumed = await consumeRecoveryCodeAtomic(
    params.subjectType,
    params.subjectId,
    params.code,
    now
  );
  if (!consumed) {
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

  // The row is already consumed by the conditional update above.
  await updateSubject(params.subjectType, params.subjectId, {
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
  const cleared = {
    mfaEnabled: false,
    mfaSecret: null,
    mfaRecoveryCodes: null,
    mfaPendingSecretAt: null,
    mfaEnrolledAt: null,
    mfaLastUsedAt: null,
  };
  await db.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({
      where: { subjectType: params.subjectType, subjectId: params.subjectId },
    });
    if (params.subjectType === "platform") {
      await tx.platformSuperAdmin.update({
        where: { id: params.subjectId },
        data: cleared,
      });
    } else if (params.subjectType === "customer") {
      await tx.customer.update({
        where: { id: params.subjectId },
        data: cleared,
      });
    } else {
      await tx.user.update({ where: { id: params.subjectId }, data: cleared });
    }
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
