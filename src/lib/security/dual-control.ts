import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { raiseSecurityAlert, recordSecurityEvent } from "@/lib/security/events";

/**
 * Residual E — maker-checker (dual control) for sensitive financial actions.
 *
 * Policy, as approved by the owner:
 *
 * - When the tenant has MORE THAN ONE active administrator, a sensitive
 *   correction or reversal made by one administrator must be approved by a
 *   DIFFERENT active administrator before it is posted.
 * - When the tenant has exactly ONE active administrator, the operation may
 *   proceed through the controlled single-administrator exception: it still
 *   requires a fresh step-up grant and a recorded reason, it is audited as an
 *   exception, and the business owner receives a critical alert (in-app and
 *   email).
 * - High-value withdrawal approvals use a configurable threshold
 *   (`WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR`). No threshold is invented: an
 *   unset or invalid value disables threshold-based approval entirely.
 *
 * The approval row is consumed in the same transaction as the financial write,
 * so a crash can never post a correction twice or post one without an approval.
 */

export const FINANCIAL_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type DualControlAction =
  | "susu.withdrawal.reverse"
  | "susu.contribution.reverse"
  | "susu.remittance.reverse"
  | "finance.daily_account.correct"
  | "susu.withdrawal.high_value";

export function withdrawalApprovalThresholdMinor(): number | null {
  const raw = process.env.WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR;
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** True when another active administrator exists in the tenant. */
export async function hasSecondAdministrator(
  tenantId: string,
  requesterId: string
): Promise<boolean> {
  const count = await db.user.count({
    where: {
      tenantId,
      role: "admin",
      status: "active",
      id: { not: requesterId },
    },
  });
  return count > 0;
}

export interface ApprovalContext {
  tenantId: string;
  action: DualControlAction;
  targetType: string;
  targetId: string;
  amountMinor?: number | null;
  reason: string;
  requesterId: string;
}

export type DualControlDecision =
  | { kind: "proceed"; exceptionUsed: boolean }
  | { kind: "pending"; approvalId: string };

/**
 * Create a pending approval request. Returns the request id.
 * The caller returns "awaiting approval" to the administrator.
 */
export async function requestFinancialApproval(
  ctx: ApprovalContext
): Promise<string> {
  const request = await db.financialApproval.create({
    data: {
      tenantId: ctx.tenantId,
      action: ctx.action,
      targetType: ctx.targetType,
      targetId: ctx.targetId,
      amountMinor: ctx.amountMinor ?? null,
      reason: ctx.reason,
      requestedBy: ctx.requesterId,
      expiresAt: new Date(Date.now() + FINANCIAL_APPROVAL_TTL_MS),
    },
    select: { id: true },
  });

  await createAuditLog({
    userId: ctx.requesterId,
    tenantId: ctx.tenantId,
    action: "finance.approval_requested",
    entityType: ctx.targetType,
    entityId: ctx.targetId,
    details: {
      approvalId: request.id,
      operation: ctx.action,
      amountMinor: ctx.amountMinor ?? null,
      reason: ctx.reason,
    },
  });

  recordSecurityEvent({
    event: "finance.approval_requested",
    outcome: "success",
    actorType: "user",
    actorId: ctx.requesterId,
    tenantId: ctx.tenantId,
    route: ctx.action,
    reason: "maker_checker_required",
  });

  const tenant = await db.businessTenant.findUnique({
    where: { id: ctx.tenantId },
    select: { name: true },
  });
  await raiseSecurityAlert({
    event: "finance.approval_requested",
    severity: "critical",
    title: "A financial correction needs a second administrator",
    body:
      `A ${ctx.action.replace(/[._]/g, " ")} on ${tenant?.name ?? "this business"} was requested and is awaiting approval by a different administrator. ` +
      `Recorded reason: ${ctx.reason}`,
    audience: "tenant_admin",
    tenantId: ctx.tenantId,
    dedupeKey: `finance-approval-request:${request.id}`,
  });

  return request.id;
}

/**
 * Record the approved single-administrator exception. The exception row is
 * already consumed: there is no second person to approve it.
 */
export async function recordSingleAdministratorException(
  ctx: ApprovalContext
): Promise<void> {
  const now = new Date();
  await db.financialApproval.create({
    data: {
      tenantId: ctx.tenantId,
      action: ctx.action,
      targetType: ctx.targetType,
      targetId: ctx.targetId,
      amountMinor: ctx.amountMinor ?? null,
      reason: ctx.reason,
      requestedBy: ctx.requesterId,
      status: "consumed",
      approvedBy: null,
      exceptionUsed: true,
      decidedAt: now,
      expiresAt: now,
    },
  });

  await createAuditLog({
    userId: ctx.requesterId,
    tenantId: ctx.tenantId,
    action: "finance.dual_control_exception",
    entityType: ctx.targetType,
    entityId: ctx.targetId,
    details: {
      operation: ctx.action,
      amountMinor: ctx.amountMinor ?? null,
      reason: ctx.reason,
      policy: "single_administrator_exception",
    },
  });

  recordSecurityEvent({
    event: "finance.dual_control_exception",
    outcome: "success",
    actorType: "user",
    actorId: ctx.requesterId,
    tenantId: ctx.tenantId,
    route: ctx.action,
    reason: "single_administrator",
  });

  const tenant = await db.businessTenant.findUnique({
    where: { id: ctx.tenantId },
    select: { name: true },
  });
  await raiseSecurityAlert({
    event: "finance.dual_control_exception",
    severity: "critical",
    title: "Single-administrator financial exception recorded",
    body:
      `A ${ctx.action.replace(/[._]/g, " ")} was posted by the only active administrator of ${tenant?.name ?? "a business"}. ` +
      `Recorded reason: ${ctx.reason}`,
    audience: "tenant_admin",
    tenantId: ctx.tenantId,
    dedupeKey: `finance-exception:${ctx.targetId}:${Date.now()}`,
  });
}

/**
 * Resolve what the requester may do now.
 *
 * `approvalId` is supplied when a second administrator is approving; the
 * caller then verifies the row and consumes it inside its transaction.
 */
export async function decideDualControl(
  ctx: ApprovalContext,
  approvalId?: string | null
): Promise<DualControlDecision | { kind: "denied"; error: string }> {
  if (approvalId) {
    const approval = await db.financialApproval.findUnique({
      where: { id: approvalId },
    });
    if (
      !approval ||
      approval.tenantId !== ctx.tenantId ||
      approval.action !== ctx.action ||
      approval.targetType !== ctx.targetType ||
      approval.targetId !== ctx.targetId
    ) {
      return { kind: "denied", error: "This approval does not match the operation." };
    }
    if (approval.status !== "approved") {
      return { kind: "denied", error: "This approval is not ready to be applied." };
    }
    if (approval.expiresAt.getTime() <= Date.now()) {
      return { kind: "denied", error: "This approval has expired. Request a new one." };
    }
    // The current caller is the approver applying the correction, so the maker
    // (requestedBy) must be someone else. This is the same-person guard.
    if (approval.requestedBy === ctx.requesterId) {
      return {
        kind: "denied",
        error: "A different administrator must approve this operation.",
      };
    }
    if (!approval.approvedBy) {
      return { kind: "denied", error: "This approval has not been confirmed." };
    }
    return { kind: "proceed", exceptionUsed: false };
  }

  const second = await hasSecondAdministrator(ctx.tenantId, ctx.requesterId);
  if (!second) return { kind: "proceed", exceptionUsed: true };

  const approvalId2 = await requestFinancialApproval(ctx);
  return { kind: "pending", approvalId: approvalId2 };
}

/**
 * Atomically consume an approved request inside the financial transaction.
 * Returns false when the approval was already used or is no longer valid, so
 * the caller must abort the whole transaction.
 */
export async function consumeFinancialApproval(
  tx: Prisma.TransactionClient,
  approvalId: string,
  ctx: { tenantId: string; action: string; targetId: string; requesterId: string }
): Promise<boolean> {
  const result = await tx.financialApproval.updateMany({
    where: {
      id: approvalId,
      tenantId: ctx.tenantId,
      action: ctx.action,
      targetId: ctx.targetId,
      status: "approved",
      approvedBy: ctx.requesterId,
      requestedBy: { not: ctx.requesterId },
      expiresAt: { gt: new Date() },
    },
    data: { status: "consumed", decidedAt: new Date() },
  });
  return result.count === 1;
}

export interface ApprovalRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  amountMinor: number | null;
  reason: string;
  requestedBy: string;
  requestedByEmail: string;
  createdAt: string;
  expiresAt: string;
}

export async function listFinancialApprovals(
  tenantId: string
): Promise<ApprovalRow[]> {
  const rows = await db.financialApproval.findMany({
    where: {
      tenantId,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const requesters = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.requestedBy))] } },
    select: { id: true, email: true },
  });
  const emailById = new Map(requesters.map((row) => [row.id, row.email]));
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    amountMinor: row.amountMinor,
    reason: row.reason,
    requestedBy: row.requestedBy,
    requestedByEmail: emailById.get(row.requestedBy) ?? "unknown",
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}
