"use server";

import { db } from "@/lib/db";
import {
  getPlatformAdminOrNull,
  requirePlatformAdmin,
  getPlatformTokenPayload,
} from "@/lib/platform-auth";
import { revokeAllUserSessions } from "@/lib/auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  claimStepUpGrant,
  stepUpSessionBinding,
  StepUpDeniedError,
} from "@/lib/security/step-up";
import { raiseSecurityAlert, recordSecurityEvent } from "@/lib/security/events";

/**
 * Residual D — break-glass platform MFA recovery.
 *
 * A platform administrator may reset another platform administrator's MFA
 * factor only after:
 *
 *   1. a fresh password (+ MFA when enrolled) step-up bound to this exact
 *      target (five minutes, single use);
 *   2. a recorded reason;
 *   3. a second, different authorized platform administrator approving the
 *      request whenever one exists;
 *   4. an audit record and a critical security alert to every platform admin.
 *
 * When no other active platform administrator exists, the owner-approved
 * single-administrator exception applies: the reset still requires step-up and
 * a reason, is audited, and notifies the operator. The target's own sessions are
 * revoked and the account has to enrol a new factor at next sign-in.
 */

export interface PlatformRecoveryResponse {
  success: boolean;
  error?: string;
  requiresApproval?: boolean;
  approvalId?: string;
  exceptionUsed?: boolean;
}

const REASON_MIN = 10;
const REASON_MAX = 500;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

async function afterRecovery(input: {
  actorId: string;
  actorEmail: string;
  targetId: string;
  targetEmail: string;
  reason: string;
  approvalId: string | null;
  exceptionUsed: boolean;
}) {
  await createPlatformAuditLog({
    actorId: input.actorId,
    actorEmail: input.actorEmail,
    action: "platform.mfa_recovery_applied",
    entityType: "PlatformSuperAdmin",
    entityId: input.targetId,
    reason: input.reason,
    details: {
      targetEmail: input.targetEmail,
      approvalId: input.approvalId,
      exceptionUsed: input.exceptionUsed,
    },
  });

  recordSecurityEvent({
    event: "platform.mfa_recovery_applied",
    outcome: "success",
    actorType: "platform_admin",
    actorId: input.actorId,
    route: "platform.mfa_recovery",
    reason: input.exceptionUsed ? "single_admin_exception" : "second_person_approved",
  });

  await raiseSecurityAlert({
    event: "platform.mfa_recovery_applied",
    severity: "critical",
    title: "Platform administrator MFA was reset",
    body:
      `MFA was reset for platform administrator ${input.targetEmail}. ` +
      `Reason recorded. ${input.exceptionUsed ? "Single-administrator exception applied." : "Approved by a second platform administrator."}`,
    audience: "platform",
    dedupeKey: `platform-mfa-recovery:${input.targetId}:${Date.now()}`,
  });
}

/** Count active platform administrators other than the requester and target. */
async function otherApprovers(
  requesterId: string,
  targetId: string
): Promise<number> {
  return db.platformSuperAdmin.count({
    where: {
      status: "active",
      id: { notIn: [requesterId, targetId] },
    },
  });
}

export async function requestPlatformMfaRecovery(input: {
  targetAdminId: string;
  reason: string;
  stepUpToken?: string;
}): Promise<PlatformRecoveryResponse> {
  const session = await requirePlatformAdmin();
  const payload = await getPlatformTokenPayload();
  if (!payload) {
    return { success: false, error: "Your session has expired. Please sign in again." };
  }

  const reason = input.reason?.trim() ?? "";
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return {
      success: false,
      error: `Enter a recovery reason of at least ${REASON_MIN} characters.`,
    };
  }

  const rate = await consumeRateLimit(
    "platform:mfa_recovery",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many recovery requests. Please wait." };
  }

  const target = await db.platformSuperAdmin.findUnique({
    where: { id: input.targetAdminId },
    select: { id: true, email: true, status: true },
  });
  if (!target || target.status !== "active") {
    return { success: false, error: "Platform administrator not found." };
  }
  if (target.id === session.adminId) {
    return {
      success: false,
      error: "Use the normal sign-in recovery flow to reset your own factor.",
    };
  }

  const approvers = await otherApprovers(session.adminId, target.id);
  const now = Date.now();

  try {
    const outcome = await db.$transaction(async (tx) => {
      const grant = await claimStepUpGrant(tx, {
        token: input.stepUpToken,
        subjectType: "platform",
        subjectId: session.adminId,
        sessionId: stepUpSessionBinding(payload, session.adminId),
        purpose: "platform.mfa_recovery",
        targetType: "platform_admin",
        targetId: target.id,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      if (approvers > 0) {
        const request = await tx.platformApprovalRequest.create({
          data: {
            action: "platform.mfa_recovery",
            targetType: "platform_admin",
            targetId: target.id,
            reason,
            requestedBy: session.adminId,
            expiresAt: new Date(now + APPROVAL_TTL_MS),
          },
          select: { id: true },
        });
        return { kind: "pending" as const, approvalId: request.id };
      }

      // Owner-approved single-administrator exception.
      await tx.platformSuperAdmin.update({
        where: { id: target.id },
        data: {
          mfaEnabled: false,
          mfaSecret: null,
          mfaRecoveryCodes: null,
          mfaPendingSecretAt: null,
          mfaEnrolledAt: null,
          mfaLastUsedAt: null,
          mfaLastTotpStep: null,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.mfaRecoveryCode.deleteMany({
        where: { subjectType: "platform", subjectId: target.id },
      });
      return { kind: "applied" as const, approvalId: null };
    });

    if (outcome.kind === "pending") {
      await createPlatformAuditLog({
        actorId: session.adminId,
        actorEmail: session.email,
        action: "platform.mfa_recovery_requested",
        entityType: "PlatformSuperAdmin",
        entityId: target.id,
        reason,
        details: { targetEmail: target.email, approvalId: outcome.approvalId },
      });
      recordSecurityEvent({
        event: "platform.mfa_recovery_requested",
        outcome: "success",
        actorType: "platform_admin",
        actorId: session.adminId,
        route: "platform.mfa_recovery",
        reason: "awaiting_second_approver",
      });
      await raiseSecurityAlert({
        event: "platform.mfa_recovery_requested",
        severity: "critical",
        title: "Platform MFA recovery awaiting a second approver",
        body: `A platform administrator requested an MFA reset for ${target.email}. A different platform administrator must approve it within 24 hours.`,
        audience: "platform",
        dedupeKey: `platform-mfa-recovery-request:${outcome.approvalId}`,
      });
      return {
        success: true,
        requiresApproval: true,
        approvalId: outcome.approvalId,
      };
    }

    await revokeAllUserSessions(
      "platform",
      target.id,
      "platform_mfa_recovery_exception"
    );
    await afterRecovery({
      actorId: session.adminId,
      actorEmail: session.email,
      targetId: target.id,
      targetEmail: target.email,
      reason,
      approvalId: null,
      exceptionUsed: true,
    });
    return { success: true, exceptionUsed: true };
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "The recovery request could not be recorded." };
  }
}

export async function approvePlatformMfaRecovery(
  approvalId: string,
  stepUpToken?: string
): Promise<PlatformRecoveryResponse> {
  const session = await requirePlatformAdmin();
  const payload = await getPlatformTokenPayload();
  if (!payload) {
    return { success: false, error: "Your session has expired. Please sign in again." };
  }

  const rate = await consumeRateLimit(
    "platform:mfa_recovery_approve",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many approval attempts. Please wait." };
  }

  const request = await db.platformApprovalRequest.findUnique({
    where: { id: approvalId },
  });
  if (!request || request.action !== "platform.mfa_recovery") {
    return { success: false, error: "Approval request not found." };
  }
  if (request.status !== "pending") {
    return { success: false, error: "This request is no longer pending." };
  }
  if (request.expiresAt.getTime() <= Date.now()) {
    return { success: false, error: "This request has expired. Ask for a new one." };
  }
  if (request.requestedBy === session.adminId) {
    return {
      success: false,
      error: "A different platform administrator must approve this request.",
    };
  }
  if (request.targetId === session.adminId) {
    return { success: false, error: "The affected administrator cannot approve this request." };
  }

  const target = await db.platformSuperAdmin.findUnique({
    where: { id: request.targetId },
    select: { id: true, email: true, status: true },
  });
  if (!target || target.status !== "active") {
    return { success: false, error: "Platform administrator not found." };
  }

  try {
    const claimed = await db.$transaction(async (tx) => {
      const grant = await claimStepUpGrant(tx, {
        token: stepUpToken,
        subjectType: "platform",
        subjectId: session.adminId,
        sessionId: stepUpSessionBinding(payload, session.adminId),
        purpose: "platform.mfa_recovery",
        targetType: "platform_admin",
        targetId: target.id,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      // Concurrency gate: exactly one approver can move pending -> approved.
      const updated = await tx.platformApprovalRequest.updateMany({
        where: {
          id: approvalId,
          status: "pending",
          expiresAt: { gt: new Date() },
        },
        data: {
          status: "approved",
          approvedBy: session.adminId,
          decidedAt: new Date(),
        },
      });
      if (updated.count !== 1) return false;

      await tx.platformSuperAdmin.update({
        where: { id: target.id },
        data: {
          mfaEnabled: false,
          mfaSecret: null,
          mfaRecoveryCodes: null,
          mfaPendingSecretAt: null,
          mfaEnrolledAt: null,
          mfaLastUsedAt: null,
          mfaLastTotpStep: null,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.mfaRecoveryCode.deleteMany({
        where: { subjectType: "platform", subjectId: target.id },
      });
      return true;
    });
    if (!claimed) {
      return { success: false, error: "This request is no longer pending." };
    }
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "The approval could not be applied." };
  }

  await revokeAllUserSessions("platform", target.id, "platform_mfa_recovery");

  recordSecurityEvent({
    event: "platform.mfa_recovery_approved",
    outcome: "success",
    actorType: "platform_admin",
    actorId: session.adminId,
    route: "platform.mfa_recovery",
    reason: "second_person_approved",
  });

  await afterRecovery({
    actorId: session.adminId,
    actorEmail: session.email,
    targetId: target.id,
    targetEmail: target.email,
    reason: request.reason,
    approvalId,
    exceptionUsed: false,
  });

  return { success: true };
}

export async function rejectPlatformMfaRecovery(
  approvalId: string,
  reason: string
): Promise<PlatformRecoveryResponse> {
  const session = await requirePlatformAdmin();
  const note = reason?.trim() ?? "";
  if (note.length < 3 || note.length > 300) {
    return { success: false, error: "Enter a short rejection reason." };
  }
  const request = await db.platformApprovalRequest.findUnique({
    where: { id: approvalId },
  });
  if (!request || request.status !== "pending") {
    return { success: false, error: "This request is no longer pending." };
  }
  if (request.requestedBy === session.adminId) {
    return { success: false, error: "A different administrator must decide this request." };
  }
  const updated = await db.platformApprovalRequest.updateMany({
    where: { id: approvalId, status: "pending" },
    data: {
      status: "rejected",
      approvedBy: session.adminId,
      decidedAt: new Date(),
      reason: `${request.reason} | rejected: ${note}`,
    },
  });
  if (updated.count !== 1) {
    return { success: false, error: "This request is no longer pending." };
  }
  await createPlatformAuditLog({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "platform.mfa_recovery_rejected",
    entityType: "PlatformSuperAdmin",
    entityId: request.targetId,
    reason: note,
    details: { approvalId },
  });
  recordSecurityEvent({
    event: "platform.mfa_recovery_rejected",
    outcome: "blocked",
    actorType: "platform_admin",
    actorId: session.adminId,
    route: "platform.mfa_recovery",
    reason: "second_person_rejected",
  });
  return { success: true };
}

export interface PendingPlatformApproval {
  id: string;
  targetEmail: string;
  reason: string;
  requestedByEmail: string;
  createdAt: string;
  expiresAt: string;
  requestedByMe: boolean;
}

export async function listPlatformApprovals(): Promise<PendingPlatformApproval[]> {
  const admin = await getPlatformAdminOrNull();
  if (!admin) return [];
  const rows = await db.platformApprovalRequest.findMany({
    where: {
      action: "platform.mfa_recovery",
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const adminIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.targetId]))];
  const admins = await db.platformSuperAdmin.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, email: true },
  });
  const emailById = new Map(admins.map((a) => [a.id, a.email]));
  return rows.map((row) => ({
    id: row.id,
    targetEmail: emailById.get(row.targetId) ?? "unknown",
    reason: row.reason,
    requestedByEmail: emailById.get(row.requestedBy) ?? "unknown",
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    requestedByMe: row.requestedBy === admin.adminId,
  }));
}
