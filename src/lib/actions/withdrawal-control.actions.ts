"use server";

import { db } from "@/lib/db";
import { getAdminSession } from "@/lib/auth";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { assertBranchAccess, isBranchlessTenant, resolveBranchScope, resolveCustomerRequestBranch } from "@/lib/branch";
import { createAuditLog, createAuditLogTx } from "@/lib/audit";
import { claimStepUpGrant, StepUpDeniedError, type StepUpPurpose } from "@/lib/security/step-up";
import { stepUpSessionBinding } from "@/lib/security/step-up";
import { processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";
import {
  DEFAULT_WITHDRAWAL_POLICY,
  evaluateWithdrawalPolicy,
  policyFromRow,
  validateWithdrawalPolicy,
  type WithdrawalPolicyValues,
} from "@/lib/withdrawal-policy";
import {
  OPEN_WITHDRAWAL_REQUEST_STATUSES,
  toPesewa,
  type WithdrawalRequestStatus,
} from "@/lib/withdrawal-request";
import type { WithdrawalRequestView } from "@/lib/actions/withdrawal-request.actions";
import { revalidatePath } from "next/cache";

/**
 * Phase 4 — configurable, staged withdrawal controls.
 *
 * Every threshold, approval count and role decision is resolved from the
 * tenant policy row on the server. The browser never supplies a policy value
 * that is trusted for authorisation.
 */

const COMPANY_ADMIN_ERROR = "Withdrawal policy administration requires company-wide access.";

async function requireCompanyAdmin() {
  const ctx = await requireTenantAdminSusu();
  const scope = await resolveBranchScope(ctx);
  if (scope.kind !== "all") throw new Error(COMPANY_ADMIN_ERROR);
  return ctx;
}

export interface WithdrawalControlResponse {
  success: boolean;
  error?: string;
  data?: unknown;
  requests?: WithdrawalRequestView[];
}

function errorResponse(error: unknown): WithdrawalControlResponse {
  if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
  return {
    success: false,
    error: error instanceof Error ? error.message : "The withdrawal control could not be completed.",
  };
}

export async function getWithdrawalPolicy(): Promise<{
  success: boolean;
  error?: string;
  data?: WithdrawalPolicyValues;
}> {
  try {
    const ctx = await requireCompanyAdmin();
    const row = await db.withdrawalPolicy.findUnique({ where: { tenantId: ctx.tenantId } });
    return { success: true, data: row ? policyFromRow(row) : DEFAULT_WITHDRAWAL_POLICY };
  } catch (error) {
    return errorResponse(error) as { success: boolean; error?: string };
  }
}

export async function saveWithdrawalPolicy(
  input: WithdrawalPolicyValues & { changeNote?: string }
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  try {
    const ctx = await requireCompanyAdmin();
    const { changeNote, ...values } = input;
    const validation = validateWithdrawalPolicy(values);
    if (!validation.ok) return { success: false, error: validation.error };

    const existing = await db.withdrawalPolicy.findUnique({ where: { tenantId: ctx.tenantId } });
    const snapshot = JSON.stringify({
      ...values,
      requiredEvidenceFields: values.requiredEvidenceFields,
    });
    const saved = await db.$transaction(async (tx) => {
      const policy = await tx.withdrawalPolicy.upsert({
        where: { tenantId: ctx.tenantId },
        create: { ...values, requiredEvidenceFields: JSON.stringify(values.requiredEvidenceFields), tenantId: ctx.tenantId, updatedById: ctx.userId },
        update: { ...values, requiredEvidenceFields: JSON.stringify(values.requiredEvidenceFields), updatedById: ctx.userId },
      });
      await tx.withdrawalPolicyHistory.create({
        data: {
          tenantId: ctx.tenantId,
          policyId: policy.id,
          snapshot,
          changedById: ctx.userId,
          changeNote: changeNote?.trim() || null,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "withdrawal.policy_saved",
        entityType: "withdrawalPolicy",
        entityId: policy.id,
        details: {
          highValueThresholdPesewa: values.highValueThresholdPesewa,
          requiredApprovals: values.requiredApprovals,
          separationOfDuties: values.separationOfDuties,
          requirePaymentEvidence: values.requirePaymentEvidence,
          active: values.active,
          previousActive: existing?.active ?? null,
        },
      });
      return policy;
    });
    revalidatePath("/susu/admin/withdrawal-controls");
    return { success: true, data: saved };
  } catch (error) {
    return errorResponse(error);
  }
}

async function loadRequest(ctx: { tenantId: string; userId: string; role: string }, id: string) {
  const request = await db.customerWithdrawalRequest.findFirst({
    where: { id, tenantId: ctx.tenantId },
    select: {
      id: true,
      tenantId: true,
      branchId: true,
      reference: true,
      accountId: true,
      amountPesewa: true,
      status: true,
      requestedById: true,
      highValue: true,
      requiredApprovals: true,
      paymentInitiatedById: true,
      resultingWithdrawalId: true,
      approvals: { select: { approverId: true, status: true } },
    },
  });
  if (!request) return null;
  const scope = await resolveBranchScope(ctx as never);
  if (
    scope.kind === "limited" &&
    request.branchId &&
    !scope.branchIds.includes(request.branchId)
  ) {
    return null;
  }
  return request;
}

async function loadPolicy(tenantId: string): Promise<WithdrawalPolicyValues> {
  const row = await db.withdrawalPolicy.findUnique({ where: { tenantId } });
  return row ? policyFromRow(row) : DEFAULT_WITHDRAWAL_POLICY;
}

export async function approveWithdrawalRequest(input: {
  id: string;
  stepUpToken: string;
  note?: string;
}): Promise<WithdrawalControlResponse> {
  try {
    const ctx = await requireTenantAdminSusu();
    const request = await loadRequest(ctx, input.id);
    if (!request) return { success: false, error: "That request was not found." };
    if (request.status !== "requested" && request.status !== "needs_review") {
      return { success: false, error: "This request is not waiting for approval." };
    }
    if (request.requestedById === ctx.userId) {
      return { success: false, error: "The requester cannot approve this withdrawal." };
    }

    const policy = await loadPolicy(ctx.tenantId);
    const evaluation = evaluateWithdrawalPolicy(policy, request.amountPesewa);
    if (!evaluation.allowed) return { success: false, error: evaluation.reason };

    // Legacy path: no configured approvals means the existing behaviour stands.
    if (evaluation.requiredApprovals === 0) {
      const result = await processWithdrawal({
        accountId: request.accountId,
        requestedAmount: request.amountPesewa / 100,
        notes: `Customer request ${request.reference}`,
        idempotencyKey: request.reference,
        stepUpToken: input.stepUpToken,
        branchId: request.branchId ?? undefined,
      });
      if (!result.success) return { success: false, error: result.error };
      const updated = await db.customerWithdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: "paid",
          approvedById: ctx.userId,
          approvedAt: new Date(),
          paidAt: new Date(),
          paymentInitiatedById: ctx.userId,
          paymentInitiatedAt: new Date(),
          decidedById: ctx.userId,
          decidedAt: new Date(),
        },
      });
      return { success: true, data: { id: updated.id, reference: updated.reference } };
    }

    const session = await getAdminSession();
    const approval = await db.$transaction(async (tx) => {
      const grant = await claimStepUpGrant(tx, {
        token: input.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "withdrawal.approve",
        targetType: "customerWithdrawalRequest",
        targetId: request.id,
        context: { amountMinor: String(request.amountPesewa), currency: "GHS" },
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      await tx.withdrawalApproval.create({
        data: {
          tenantId: ctx.tenantId,
          requestId: request.id,
          approverId: ctx.userId,
          status: "approved",
          note: input.note?.trim() || null,
          decidedAt: new Date(),
        },
      });
      const count = await tx.withdrawalApproval.count({
        where: { tenantId: ctx.tenantId, requestId: request.id, status: "approved" },
      });
      const complete = count >= evaluation.requiredApprovals;
      await tx.customerWithdrawalRequest.update({
        where: { id: request.id, status: { in: ["requested", "needs_review"] } },
        data: {
          status: complete ? "awaiting_payment" : "needs_review",
          approvedById: complete ? ctx.userId : null,
          approvedAt: complete ? new Date() : null,
          decidedById: ctx.userId,
          decidedAt: new Date(),
          decisionNote: input.note?.trim() || null,
          highValue: evaluation.highValue,
          requiredApprovals: evaluation.requiredApprovals,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: request.branchId,
        action: "withdrawal.approval_recorded",
        entityType: "customerWithdrawalRequest",
        entityId: request.id,
        details: {
          reference: request.reference,
          approvalCount: count,
          requiredApprovals: evaluation.requiredApprovals,
          highValue: evaluation.highValue,
          complete,
          financialMutation: false,
        },
      });
      return { count, complete };
    });
    revalidatePath("/susu/admin/withdrawal-requests");
    return { success: true, data: approval };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { success: false, error: "You have already approved this request." };
    }
    return errorResponse(error);
  }
}

export async function payWithdrawalRequest(input: {
  id: string;
  stepUpToken: string;
  paymentMethod: string;
  paymentReference: string;
  evidenceRef?: string;
  acknowledgedById?: string;
  reasonCode?: string;
}): Promise<WithdrawalControlResponse> {
  try {
    const ctx = await requireTenantAdminSusu();
    const request = await loadRequest(ctx, input.id);
    if (!request) return { success: false, error: "That request was not found." };
    if (request.status !== "awaiting_payment") {
      return { success: false, error: "This request is not awaiting payment." };
    }
    const policy = await loadPolicy(ctx.tenantId);
    const evaluation = evaluateWithdrawalPolicy(policy, request.amountPesewa);
    if (!evaluation.allowed) return { success: false, error: evaluation.reason };

    if (evaluation.requiresIndependentPayment) {
      if (request.requestedById === ctx.userId) {
        return { success: false, error: "The requester cannot pay this withdrawal." };
      }
      if (request.approvals.some((a) => a.status === "approved" && a.approverId === ctx.userId)) {
        return { success: false, error: "The approver cannot also pay this withdrawal." };
      }
    }

    const method = input.paymentMethod?.trim();
    const reference = input.paymentReference?.trim();
    const required = evaluation.requiredEvidenceFields;
    if (required.includes("paymentMethod") && !method) {
      return { success: false, error: "A payment method is required by your business policy." };
    }
    if (required.includes("paymentReference") && !reference) {
      return { success: false, error: "A payment reference is required by your business policy." };
    }
    if (required.includes("evidenceAttachment")) {
      if (!input.evidenceRef) {
        return { success: false, error: "Payment evidence is required by your business policy." };
      }
      const evidence = await db.evidenceAttachment.findFirst({
        where: {
          id: input.evidenceRef,
          tenantId: ctx.tenantId,
          subjectType: "withdrawalRequest",
          subjectId: request.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!evidence) return { success: false, error: "That evidence does not belong to this request." };
    }
    if (required.includes("acknowledgedBy")) {
      if (!input.acknowledgedById) {
        return { success: false, error: "Acknowledgement is required by your business policy." };
      }
      const ack = await db.user.findFirst({
        where: { id: input.acknowledgedById, tenantId: ctx.tenantId, status: "active" },
        select: { id: true },
      });
      if (!ack) return { success: false, error: "The acknowledging person was not found." };
    }

    const claim = await db.customerWithdrawalRequest.updateMany({
      where: {
        id: request.id,
        tenantId: ctx.tenantId,
        status: "awaiting_payment",
        paymentInitiatedById: null,
        resultingWithdrawalId: null,
      },
      data: { paymentInitiatedById: ctx.userId, paymentInitiatedAt: new Date() },
    });
    if (claim.count !== 1) {
      return { success: false, error: "Payment was already claimed or this request changed." };
    }

    try {
      const result = await processWithdrawal({
        accountId: request.accountId,
        requestedAmount: request.amountPesewa / 100,
        notes: `Customer request ${request.reference}`,
        idempotencyKey: request.reference,
        stepUpToken: input.stepUpToken,
        stepUpPurpose: "withdrawal.pay",
        branchId: request.branchId ?? undefined,
        payment: {
          requestId: request.id,
          method: method || "office_cash",
          reference: reference || `PAY-${request.reference}`,
          evidenceRef: input.evidenceRef,
          reasonCode: input.reasonCode?.trim() || undefined,
          paidById: ctx.userId,
          paidAt: new Date(),
          acknowledgedById: input.acknowledgedById,
          acknowledgedAt: input.acknowledgedById ? new Date() : undefined,
        },
      });
      if (!result.success) {
        await db.customerWithdrawalRequest.updateMany({
          where: { id: request.id, paymentInitiatedById: ctx.userId },
          data: { paymentInitiatedById: null, paymentInitiatedAt: null },
        });
        return { success: false, error: result.error };
      }
      const withdrawal = await db.withdrawal.findUnique({
        where: { referenceId: `WDR-${request.reference}` },
        select: { id: true },
      });
      await db.$transaction(async (tx) => {
        await tx.customerWithdrawalRequest.update({
          where: { id: request.id },
          data: {
            status: "paid",
            paidAt: new Date(),
            paymentMethod: method || "office_cash",
            paymentReference: reference || `PAY-${request.reference}`,
            evidenceRef: input.evidenceRef ?? null,
            reasonCode: input.reasonCode?.trim() || null,
            resultingWithdrawalId: withdrawal?.id ?? null,
            decidedById: ctx.userId,
            decidedAt: new Date(),
          },
        });
        await createAuditLogTx(tx, {
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          branchId: request.branchId,
          action: "withdrawal.payment_recorded",
          entityType: "customerWithdrawalRequest",
          entityId: request.id,
          details: {
            reference: request.reference,
            withdrawalId: withdrawal?.id ?? null,
            paymentMethod: method || "office_cash",
            evidenceRef: input.evidenceRef ?? null,
            financialMutation: true,
          },
        });
      });
      revalidatePath("/susu/admin/withdrawal-requests");
      return { success: true, data: { withdrawalId: withdrawal?.id ?? null } };
    } catch (paymentError) {
      await db.customerWithdrawalRequest.updateMany({
        where: { id: request.id, paymentInitiatedById: ctx.userId },
        data: { paymentInitiatedById: null, paymentInitiatedAt: null },
      });
      throw paymentError;
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function recordWithdrawalAcknowledgement(input: {
  id: string;
  acknowledgedById: string;
  note?: string;
}): Promise<WithdrawalControlResponse> {
  try {
    const ctx = await requireTenantAdminSusu();
    const request = await loadRequest(ctx, input.id);
    if (!request) return { success: false, error: "That request was not found." };
    if (request.status !== "paid") {
      return { success: false, error: "Only a paid withdrawal can be acknowledged." };
    }
    const person = await db.user.findFirst({
      where: { id: input.acknowledgedById, tenantId: ctx.tenantId, status: "active" },
      select: { id: true },
    });
    if (!person) return { success: false, error: "The acknowledging person was not found." };
    await db.$transaction(async (tx) => {
      await tx.customerWithdrawalRequest.update({
        where: { id: request.id },
        data: { acknowledgedById: person.id, acknowledgedAt: new Date() },
      });
      if (request.resultingWithdrawalId) {
        await tx.withdrawal.update({
          where: { id: request.resultingWithdrawalId },
          data: { acknowledgedById: person.id, acknowledgedAt: new Date() },
        });
      }
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: request.branchId,
        action: "withdrawal.acknowledgement_recorded",
        entityType: "customerWithdrawalRequest",
        entityId: request.id,
        details: { acknowledgedById: person.id, note: input.note?.trim() || null },
      });
    });
    return { success: true };
  } catch (error) {
    return errorResponse(error);
  }
}

export async function getHighValueWithdrawalQueue(): Promise<WithdrawalControlResponse> {
  try {
    const ctx = await requireTenantAdminSusu();
    const scope = await resolveBranchScope(ctx);
    const rows = await db.customerWithdrawalRequest.findMany({
      where: {
        tenantId: ctx.tenantId,
        highValue: true,
        status: { in: OPEN_WITHDRAWAL_REQUEST_STATUSES as WithdrawalRequestStatus[] },
        ...(scope.kind === "limited" ? { branchId: { in: scope.branchIds } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return {
      success: true,
      requests: rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        accountId: row.accountId,
        accountReference: "",
        amountPesewa: row.amountPesewa,
        amountLabel: `${row.amountPesewa / 100}`,
        reason: row.reason,
        status: row.status as WithdrawalRequestStatus,
        statusLabel: row.status,
        canCancel: false,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        resultingWithdrawalId: row.resultingWithdrawalId,
        nextStep: null,
        highValue: row.highValue,
        requiredApprovals: row.requiredApprovals,
        approvalCount: 0,
        paymentMethod: row.paymentMethod,
        paymentReference: row.paymentReference,
        evidenceRef: row.evidenceRef,
        paidAt: row.paidAt?.toISOString() ?? null,
      })),
    };
  } catch (error) {
    return errorResponse(error);
  }
}
