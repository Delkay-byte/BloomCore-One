"use server";

import { db } from "@/lib/db";
import {
  hashPassword,
  getAdminSession,
  revokeAllUserSessions,
} from "@/lib/auth";
import { getTenantContext, type TenantContext } from "@/lib/tenant";
import {
  getPlatformAdminOrNull,
  validatePasswordPolicy,
} from "@/lib/platform-auth";
import { createAuditLog } from "@/lib/audit";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { verifyMfaCode } from "@/lib/security/mfa";
import { base32Encode } from "@/lib/security/totp";
import { sha256 } from "@/lib/security/crypto";
import { getClientIp } from "@/lib/security/client-ip";
import { logSecurityEvent } from "@/lib/security/log";
import { headers } from "next/headers";
import { randomBytes } from "crypto";

/**
 * Administrator-assisted account recovery.
 *
 * No email provider is configured. A tenant administrator issues a one-time
 * recovery code to an ordinary user in their own business. A platform operator
 * issues codes to business owners / tenant administrators (and may assist any
 * account as an escalation path).
 *
 * The plaintext code is returned exactly once to the issuing administrator and
 * is never written to the database or logs. Only a SHA-256 hash is stored.
 */

const RECOVERY_CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface RecoveryActionResult {
  success: boolean;
  error?: string;
  code?: string;
  expiresAt?: string;
  requestId?: string;
}

type Actor =
  | {
      kind: "platform";
      id: string;
      email: string;
      mfaEnabled: boolean;
    }
  | {
      kind: "user";
      id: string;
      email: string;
      tenantId: string;
      role: string;
      mfaEnabled: boolean;
      ctx: TenantContext;
    };

async function resolveActor(): Promise<Actor | null> {
  const platform = await getPlatformAdminOrNull();
  if (platform) {
    const row = await db.platformSuperAdmin.findUnique({
      where: { id: platform.adminId },
      select: { mfaEnabled: true },
    });
    return {
      kind: "platform",
      id: platform.adminId,
      email: platform.email,
      mfaEnabled: Boolean(row?.mfaEnabled),
    };
  }

  const ctx = await getTenantContext("admin");
  if (ctx && ctx.role === "admin") {
    const user = await db.user.findUnique({
      where: { id: ctx.userId },
      select: { email: true, mfaEnabled: true },
    });
    if (user) {
      return {
        kind: "user",
        id: ctx.userId,
        email: user.email,
        tenantId: ctx.tenantId,
        role: ctx.role,
        mfaEnabled: Boolean(user.mfaEnabled),
        ctx,
      };
    }
  }

  // Fallback: an authenticated administrator via the raw module cookie. This
  // covers callers whose tenant context is temporarily unavailable but whose
  // session is still current.
  const admin = await getAdminSession();
  if (admin?.role === "admin") {
    const user = await db.user.findUnique({
      where: { id: admin.userId },
      select: { tenantId: true, email: true, mfaEnabled: true },
    });
    if (user?.tenantId) {
      const ctx = await getTenantContext("admin");
      if (ctx) {
        return {
          kind: "user",
          id: admin.userId,
          email: user.email,
          tenantId: user.tenantId,
          role: "admin",
          mfaEnabled: Boolean(user.mfaEnabled),
          ctx,
        };
      }
    }
  }
  return null;
}

async function currentIp(): Promise<string | null> {
  try {
    return getClientIp(await headers()).ip;
  } catch {
    return null;
  }
}

/** Step-up re-authentication: enrolled administrators must present a code. */
async function verifyActorStepUp(
  actor: Actor,
  code: string | undefined
): Promise<boolean> {
  if (!actor.mfaEnabled) return true;
  if (!code) return false;
  const result = await verifyMfaCode({
    subjectType: actor.kind === "platform" ? "platform" : "user",
    subjectId: actor.id,
    code,
  });
  return result.ok;
}

interface ResolvedTarget {
  targetType: "user" | "customer";
  id: string;
  tenantId: string | null;
  email: string;
  fullName: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
}

async function resolveTarget(
  actor: Actor,
  targetType: "user" | "customer",
  identifier: string
): Promise<ResolvedTarget | null> {
  const value = identifier.trim();
  if (!value) return null;

  if (targetType === "user") {
    const user = await db.user.findFirst({
      where: {
        OR: [{ id: value }, { email: value.toLowerCase() }],
      },
      select: {
        id: true,
        tenantId: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        mfaEnabled: true,
      },
    });
    if (!user) return null;
    // A tenant administrator manages ordinary users only. Business owners and
    // other administrators are recovered by the platform operator.
    if (actor.kind === "user") {
      if (user.tenantId !== actor.tenantId || user.role === "admin") return null;
    }
    return {
      targetType: "user",
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
    };
  }

  const customer = await db.customer.findFirst({
    where: {
      OR: [{ id: value }, { customerId: value }, { email: value.toLowerCase() }],
    },
    select: {
      id: true,
      tenantId: true,
      email: true,
      fullName: true,
      status: true,
      portalEnabled: true,
      mfaEnabled: true,
    },
  });
  if (!customer) return null;
  if (actor.kind === "user" && customer.tenantId !== actor.tenantId) return null;
  if (!customer.portalEnabled) return null;
  return {
    targetType: "customer",
    id: customer.id,
    tenantId: customer.tenantId,
    email: customer.email || "",
    fullName: customer.fullName,
    role: "customer",
    status: customer.status,
    mfaEnabled: customer.mfaEnabled,
  };
}

function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(10)); // 16 characters, ~80 bits
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return sha256(`admin-recovery:${normalized}`);
}

function actorLabel(actor: Actor): string {
  return actor.kind === "platform" ? "platform_admin" : "user";
}

/** Issue a one-time recovery code. Returns the plaintext code exactly once. */
export async function issueAccountRecoveryCode(input: {
  targetType: "user" | "customer";
  targetIdentifier: string;
  reason: string;
  stepUpCode?: string;
}): Promise<RecoveryActionResult> {
  const actor = await resolveActor();
  if (!actor) return { success: false, error: "Not authorized." };

  if (!(await verifyActorStepUp(actor, input.stepUpCode))) {
    return {
      success: false,
      error: "A current authenticator code is required to issue a recovery code.",
    };
  }

  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    return {
      success: false,
      error: "Enter a reason of at least 10 characters.",
    };
  }

  const target = await resolveTarget(
    actor,
    input.targetType,
    input.targetIdentifier
  );
  if (!target) {
    return {
      success: false,
      error: "Account not found or not permitted for your role.",
    };
  }
  if (target.status !== "active") {
    return { success: false, error: "The account is not active." };
  }
  if (actor.kind === "user" && target.id === actor.id) {
    return { success: false, error: "You cannot issue a recovery code for yourself." };
  }

  const actorLimit = await consumeRateLimit(
    "recovery:issue:actor",
    actor.id,
    RATE_LIMITS.adminSensitive
  );
  if (!actorLimit.allowed) {
    return {
      success: false,
      error: "Too many recovery requests. Please wait and try again.",
    };
  }
  const targetLimit = await consumeRateLimit(
    "recovery:issue:target",
    target.id,
    { limit: 5, windowMs: 15 * 60 * 1000 }
  );
  if (!targetLimit.allowed) {
    return {
      success: false,
      error: "A recovery code was issued recently for this account. Wait before issuing another.",
    };
  }

  const code = generateRecoveryCode();
  const expiresAt = new Date(Date.now() + RECOVERY_CODE_TTL_MS);

  // Invalidate any outstanding code for this account.
  await db.accountRecoveryRequest.updateMany({
    where: {
      targetType: target.targetType,
      targetId: target.id,
      usedAt: null,
      cancelledAt: null,
    },
    data: { cancelledAt: new Date() },
  });

  const request = await db.accountRecoveryRequest.create({
    data: {
      tenantId: target.tenantId,
      targetType: target.targetType,
      targetId: target.id,
      requestedById: actor.id,
      requestedByType: actor.kind,
      reason,
      codeHash: hashRecoveryCode(code),
      expiresAt,
    },
  });

  const ip = await currentIp();
  await createAuditLog({
    userId: actor.kind === "user" ? actor.id : target.id,
    tenantId: target.tenantId,
    action: "auth.admin_recovery_issued",
    entityType: target.targetType,
    entityId: target.id,
    details: {
      requestId: request.id,
      issuedByType: actor.kind,
      issuedById: actor.id,
      reason,
    },
    ipAddress: ip ?? undefined,
  });
  if (actor.kind === "platform") {
    await createPlatformAuditLog({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "tenant.admin_recovery_initiated",
      tenantId: target.tenantId,
      entityType: target.targetType,
      entityId: target.id,
      reason,
      details: { requestId: request.id, targetRole: target.role },
      ipAddress: ip,
    });
  }
  logSecurityEvent({
    event: "recovery.code_issued",
    outcome: "success",
    actorType: actorLabel(actor) as "platform_admin" | "user",
    actorId: actor.id,
    tenantId: target.tenantId,
    ip,
  });

  return {
    success: true,
    code,
    expiresAt: expiresAt.toISOString(),
    requestId: request.id,
  };
}

/** Public redemption: code + new password. No session is created here. */
export async function redeemRecoveryCode(input: {
  code: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<RecoveryActionResult> {
  const ip = await currentIp();
  if (ip) {
    const limit = await consumeRateLimit(
      "recovery:redeem:ip",
      ip,
      RATE_LIMITS.passwordResetSubmitIp
    );
    if (!limit.allowed) {
      return {
        success: false,
        error: "Too many attempts. Please wait and try again.",
      };
    }
  }

  if (!input.newPassword || input.newPassword !== input.confirmPassword) {
    return { success: false, error: "Passwords do not match." };
  }
  const policyError = validatePasswordPolicy(input.newPassword);
  if (policyError) return { success: false, error: policyError };

  const normalized = input.code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length !== 16) {
    return { success: false, error: "This recovery code is invalid or has expired." };
  }

  const request = await db.accountRecoveryRequest.findUnique({
    where: { codeHash: hashRecoveryCode(input.code) },
  });
  if (
    !request ||
    request.usedAt ||
    request.cancelledAt ||
    request.expiresAt.getTime() <= Date.now()
  ) {
    return { success: false, error: "This recovery code is invalid or has expired." };
  }

  const target =
    request.targetType === "customer"
      ? await db.customer.findUnique({ where: { id: request.targetId } })
      : await db.user.findUnique({ where: { id: request.targetId } });
  if (!target || target.status !== "active") {
    return { success: false, error: "This recovery code is invalid or has expired." };
  }
  if (request.targetType === "customer" && !("portalEnabled" in target && target.portalEnabled)) {
    return { success: false, error: "This recovery code is invalid or has expired." };
  }

  const passwordHash = await hashPassword(input.newPassword);

  const consumed = await db.$transaction(async (tx) => {
    const claim = await tx.accountRecoveryRequest.updateMany({
      where: {
        id: request.id,
        usedAt: null,
        cancelledAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (claim.count !== 1) return false;

    if (request.targetType === "customer") {
      await tx.customer.update({
        where: { id: request.targetId },
        data: {
          portalPasswordHash: passwordHash,
          forcePortalPasswordReset: false,
          tokenVersion: { increment: 1 },
        },
      });
    } else {
      await tx.user.update({
        where: { id: request.targetId },
        data: {
          passwordHash,
          forcePasswordReset: false,
          tokenVersion: { increment: 1 },
        },
      });
    }
    return true;
  });

  if (!consumed) {
    return { success: false, error: "This recovery code has already been used." };
  }

  await revokeAllUserSessions(
    request.targetType === "customer" ? "customer" : "user",
    request.targetId,
    "admin_recovery"
  );

  await createAuditLog({
    userId: request.targetId,
    tenantId: request.tenantId,
    action: "auth.admin_recovery_redeemed",
    entityType: request.targetType,
    entityId: request.targetId,
    details: { requestId: request.id },
    ipAddress: ip ?? undefined,
  });
  logSecurityEvent({
    event: "recovery.code_redeemed",
    outcome: "success",
    actorType: request.targetType === "customer" ? "customer" : "user",
    actorId: request.targetId,
    tenantId: request.tenantId,
    ip,
  });

  return { success: true };
}

/**
 * Reset a lost authenticator (and recovery codes) for another account.
 * The account must still prove its password; MFA will be re-enrolled at login.
 */
export async function resetAccountMfa(input: {
  targetType: "user" | "customer";
  targetIdentifier: string;
  reason: string;
  stepUpCode?: string;
}): Promise<RecoveryActionResult> {
  const actor = await resolveActor();
  if (!actor) return { success: false, error: "Not authorized." };

  if (!(await verifyActorStepUp(actor, input.stepUpCode))) {
    return {
      success: false,
      error: "A current authenticator code is required for this action.",
    };
  }

  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }

  const target = await resolveTarget(actor, input.targetType, input.targetIdentifier);
  if (!target) {
    return { success: false, error: "Account not found or not permitted for your role." };
  }
  if (actor.kind === "user" && target.id === actor.id) {
    return { success: false, error: "You cannot reset your own MFA here." };
  }

  const limit = await consumeRateLimit(
    "recovery:mfa_reset:actor",
    actor.id,
    RATE_LIMITS.adminSensitive
  );
  if (!limit.allowed) {
    return { success: false, error: "Too many requests. Please wait and try again." };
  }

  if (target.targetType === "customer") {
    await db.customer.update({
      where: { id: target.id },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
        mfaRecoveryCodes: null,
        mfaEnrolledAt: null,
        mfaLastUsedAt: null,
      },
    });
  } else {
    await db.user.update({
      where: { id: target.id },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
        mfaRecoveryCodes: null,
        mfaEnrolledAt: null,
        mfaLastUsedAt: null,
      },
    });
  }

  await revokeAllUserSessions(
    target.targetType === "customer" ? "customer" : "user",
    target.id,
    "mfa_reset_by_admin"
  );

  const ip = await currentIp();
  await createAuditLog({
    userId: actor.kind === "user" ? actor.id : target.id,
    tenantId: target.tenantId,
    action: "auth.mfa_reset_by_admin",
    entityType: target.targetType,
    entityId: target.id,
    details: {
      issuedByType: actor.kind,
      issuedById: actor.id,
      reason,
    },
    ipAddress: ip ?? undefined,
  });
  if (actor.kind === "platform") {
    await createPlatformAuditLog({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "tenant.admin_mfa_reset",
      tenantId: target.tenantId,
      entityType: target.targetType,
      entityId: target.id,
      reason,
      ipAddress: ip,
    });
  }

  return { success: true };
}
