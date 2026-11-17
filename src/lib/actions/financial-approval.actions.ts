"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { recordSecurityEvent } from "@/lib/security/events";
import {
  listFinancialApprovals as listRows,
  type ApprovalRow,
} from "@/lib/security/dual-control";
import {
  reverseContribution,
  reverseWithdrawal,
} from "@/lib/actions/financial-reversal.actions";
import { reverseRemittance } from "@/lib/actions/susu-collector.actions";
import { revalidatePath } from "next/cache";

/**
 * Residual E — second-administrator approval of a financial correction.
 *
 * The approver must be a different active administrator of the same tenant. The
 * approval row is marked approved first, then the underlying operation is
 * executed by this approver's own session (which claims the approver's step-up
 * grant and consumes the approval inside the financial transaction). If the
 * operation fails, the approval is returned to `pending` so it can be retried.
 */

export interface ApprovalActionResponse {
  success: boolean;
  error?: string;
  executed?: boolean;
}

export async function listFinancialApprovals(): Promise<ApprovalRow[]> {
  const ctx = await requireTenantAdminSusu();
  return listRows(ctx.tenantId);
}

export async function approveFinancialApproval(
  approvalId: string,
  stepUpToken?: string
): Promise<ApprovalActionResponse> {
  const ctx = await requireTenantAdminSusu();
  if (typeof approvalId !== "string" || approvalId.length === 0) {
    return { success: false, error: "Approval request not found." };
  }

  const approval = await db.financialApproval.findFirst({
    where: { id: approvalId, tenantId: ctx.tenantId },
  });
  if (!approval) return { success: false, error: "Approval request not found." };
  if (approval.status !== "pending") {
    return { success: false, error: "This request is no longer pending." };
  }
  if (approval.expiresAt.getTime() <= Date.now()) {
    return { success: false, error: "This request has expired." };
  }
  if (approval.requestedBy === ctx.userId) {
    return {
      success: false,
      error: "A different administrator must approve this correction.",
    };
  }

  // Concurrency gate for the approval decision itself.
  const claimed = await db.financialApproval.updateMany({
    where: {
      id: approval.id,
      tenantId: ctx.tenantId,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    data: {
      status: "approved",
      approvedBy: ctx.userId,
      decidedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    return { success: false, error: "This request is no longer pending." };
  }

  const execution =
    approval.action === "susu.withdrawal.reverse"
      ? await reverseWithdrawal({
          withdrawalId: approval.targetId,
          reason: approval.reason,
          stepUpToken,
          approvalId: approval.id,
        })
      : approval.action === "susu.contribution.reverse"
        ? await reverseContribution({
            contributionId: approval.targetId,
            reason: approval.reason,
            stepUpToken,
            approvalId: approval.id,
          })
        : approval.action === "susu.remittance.reverse"
          ? await reverseRemittance({
              remittanceId: approval.targetId,
              reason: approval.reason,
              stepUpToken,
              approvalId: approval.id,
            })
          : null;

  if (!execution) {
    await db.financialApproval.updateMany({
      where: { id: approval.id, status: "approved" },
      data: { status: "pending", approvedBy: null, decidedAt: null },
    });
    return { success: false, error: "This approval type is not supported." };
  }

  if (!execution.success) {
    // Step-up or a changed target means nothing was posted: make the request
    // available again instead of stranding it in `approved`.
    await db.financialApproval.updateMany({
      where: { id: approval.id, status: "approved" },
      data: { status: "pending", approvedBy: null, decidedAt: null },
    });
    return { success: false, error: execution.error ?? "The correction could not be posted." };
  }

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "finance.approval_applied",
    entityType: approval.targetType,
    entityId: approval.targetId,
    details: {
      approvalId: approval.id,
      operation: approval.action,
      requestedBy: approval.requestedBy,
      approvedBy: ctx.userId,
    },
  });

  recordSecurityEvent({
    event: "finance.approval_applied",
    outcome: "success",
    actorType: "user",
    actorId: ctx.userId,
    tenantId: ctx.tenantId,
    route: approval.action,
    reason: "second_person_approved",
  });

  revalidatePath("/susu/admin/approvals");
  revalidatePath("/susu/admin/history");
  return { success: true, executed: true };
}

export async function rejectFinancialApproval(
  approvalId: string,
  note: string
): Promise<ApprovalActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const reason = note?.trim() ?? "";
  if (reason.length < 3 || reason.length > 300) {
    return { success: false, error: "Enter a short rejection reason." };
  }
  const approval = await db.financialApproval.findFirst({
    where: { id: approvalId, tenantId: ctx.tenantId },
  });
  if (!approval) return { success: false, error: "Approval request not found." };
  if (approval.requestedBy === ctx.userId) {
    return { success: false, error: "A different administrator must decide this request." };
  }
  const updated = await db.financialApproval.updateMany({
    where: { id: approval.id, tenantId: ctx.tenantId, status: "pending" },
    data: {
      status: "rejected",
      approvedBy: ctx.userId,
      decidedAt: new Date(),
      reason: `${approval.reason} | rejected: ${reason}`,
    },
  });
  if (updated.count !== 1) {
    return { success: false, error: "This request is no longer pending." };
  }
  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "finance.approval_rejected",
    entityType: approval.targetType,
    entityId: approval.targetId,
    details: { approvalId: approval.id, note: reason },
  });
  recordSecurityEvent({
    event: "finance.approval_rejected",
    outcome: "blocked",
    actorType: "user",
    actorId: ctx.userId,
    tenantId: ctx.tenantId,
    route: approval.action,
    reason: "second_person_rejected",
  });
  revalidatePath("/susu/admin/approvals");
  return { success: true };
}
