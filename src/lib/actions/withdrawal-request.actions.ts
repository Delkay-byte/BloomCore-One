"use server";

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireTenantAdminSusu, requireTenantCustomer } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";
import { resolveBranchScope, resolveCustomerRequestBranch, assertBranchAccess, isBranchlessTenant } from "@/lib/branch";
import {
  OPEN_WITHDRAWAL_REQUEST_STATUSES,
  cycleAvailablePesewa,
  customerCanCancel,
  formatPesewa,
  reservedPesewa,
  toPesewa,
  withdrawalRequestSchema,
  WITHDRAWAL_DECISION_SCHEMA,
  type WithdrawalRequestStatus,
} from "@/lib/withdrawal-request";

/**
 * Customer withdrawal requests.
 *
 * The customer never posts a withdrawal here. A request is recorded, the
 * customer can cancel it while it is still waiting, and the office decides.
 * Approval runs `processWithdrawal`, so there is one implementation of the
 * withdrawal rules — including its step-up grant and commission rule.
 */

export interface WithdrawalRequestView {
  id: string;
  reference: string;
  accountId: string;
  accountReference: string;
  amountPesewa: number;
  amountLabel: string;
  reason: string;
  status: WithdrawalRequestStatus;
  statusLabel: string;
  canCancel: boolean;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  resultingWithdrawalId: string | null;
  /** Set when the request is waiting on the customer to do something. */
  nextStep: string | null;
}

export interface WithdrawalRequestResponse {
  success: boolean;
  error?: string;
  data?: WithdrawalRequestView;
  requests?: WithdrawalRequestView[];
}

const STATUS_LABELS_LOCAL: Record<WithdrawalRequestStatus, string> = {
  requested: "Waiting for the office",
  approved: "Approved, being paid",
  paid: "Paid",
  rejected: "Declined",
  cancelled: "Cancelled by you",
  needs_review: "Needs a person to review",
};

function statusLabel(status: string): string {
  return STATUS_LABELS_LOCAL[status as WithdrawalRequestStatus] ?? status;
}

function nextStepFor(status: string): string | null {
  if (status === "requested") return "No action needed. The office will review this.";
  if (status === "needs_review") {
    return "The office needs to check this. Ask them to review the request.";
  }
  if (status === "rejected") return "You can start a new request if you still need the money.";
  return null;
}

interface RequestRow {
  id: string;
  reference: string;
  accountId: string;
  amountPesewa: number;
  reason: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  resultingWithdrawalId: string | null;
  account: { accountId: string };
}

function toView(row: RequestRow): WithdrawalRequestView {
  return {
    id: row.id,
    reference: row.reference,
    accountId: row.accountId,
    accountReference: row.account.accountId,
    amountPesewa: row.amountPesewa,
    amountLabel: formatPesewa(row.amountPesewa),
    reason: row.reason,
    status: row.status as WithdrawalRequestStatus,
    statusLabel: statusLabel(row.status),
    canCancel: customerCanCancel(row.status),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    resultingWithdrawalId: row.resultingWithdrawalId,
    nextStep: nextStepFor(row.status),
  };
}

const requestSelect = {
  id: true,
  reference: true,
  accountId: true,
  amountPesewa: true,
  reason: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  decisionNote: true,
  resultingWithdrawalId: true,
  account: { select: { accountId: true } },
} as const;

/**
 * Ask to withdraw.
 *
 * The available balance and any money already reserved by an open request are
 * checked here, so a customer cannot queue more requests than the account holds.
 */
export async function requestWithdrawal(input: {
  accountId: string;
  amount: number;
  reason: string;
}): Promise<WithdrawalRequestResponse> {
  const ctx = await requireTenantCustomer();

  const parsed = withdrawalRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Check the request and try again.",
    };
  }
  const { pesewa, error } = toPesewa(parsed.data.amount);
  if (error) return { success: false, error };

  const rate = await consumeRateLimit(
    "finance:withdrawal_request",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return {
      success: false,
      error: "Too many withdrawal requests. Please wait and try again.",
    };
  }

  const account = await db.susuAccount.findFirst({
    where: { id: parsed.data.accountId, tenantId: ctx.tenantId, customerId: ctx.userId },
    include: {
      cycles: {
        where: { status: "active" },
        take: 1,
        include: {
          contributions: { select: { amount: true } },
          withdrawals: { select: { requestedAmount: true } },
          commissions: { select: { amount: true } },
        },
      },
    },
  });
  if (!account) return { success: false, error: "That account is not yours." };
  if (account.status !== "active") {
    return { success: false, error: "This account is not active." };
  }
  const cycle = account.cycles[0];
  if (!cycle) return { success: false, error: "There is no active cycle to withdraw from." };

  const openRequests = await db.customerWithdrawalRequest.findMany({
    where: {
      accountId: account.id,
      customerId: ctx.userId,
      status: { in: OPEN_WITHDRAWAL_REQUEST_STATUSES },
    },
    select: { amountPesewa: true, reference: true },
  });
  if (openRequests.length > 0) {
    return {
      success: false,
      error: `You already have a request waiting (${openRequests[0].reference}). Cancel it or wait for the office to decide.`,
    };
  }

  const available = cycleAvailablePesewa(cycle);
  const reserved = reservedPesewa(openRequests);
  if (pesewa > available - reserved) {
    return {
      success: false,
      error: `You can withdraw up to ${formatPesewa(Math.max(0, available - reserved))} from this cycle right now.`,
    };
  }

  const reference = `WRQ-${randomBytes(6).toString("hex").toUpperCase()}`;
  const branchId = await resolveCustomerRequestBranch(ctx, account.id);
  if (!branchId && !(await isBranchlessTenant(ctx))) {
    return {
      success: false,
      error: "Your savings branch cannot be determined. Contact the office.",
    };
  }
  const created = await db.$transaction(async (tx) => {
    const row = await tx.customerWithdrawalRequest.create({
      data: {
        tenantId: ctx.tenantId,
        branchId,
        reference,
        customerId: ctx.userId,
        accountId: account.id,
        cycleId: cycle.id,
        amountPesewa: pesewa,
        reason: parsed.data.reason,
        status: "requested",
        requestedById: ctx.userId,
      },
      select: requestSelect,
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      branchId,
      action: "customer.withdrawal_requested",
      entityType: "customerWithdrawalRequest",
      entityId: row.id,
      details: {
        reference,
        accountId: account.accountId,
        amountPesewa: pesewa,
        availablePesewa: available,
        financialMutation: false,
      },
    });
    return row;
  });

  return { success: true, data: toView(created) };
}

export async function getMyWithdrawalRequests(): Promise<WithdrawalRequestResponse> {
  const ctx = await requireTenantCustomer();
  const rows = await db.customerWithdrawalRequest.findMany({
    where: { customerId: ctx.userId, tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: requestSelect,
  });
  return { success: true, requests: rows.map(toView) };
}

/** Cancel while the office has not decided. Paid or declined requests cannot move. */
export async function cancelMyWithdrawalRequest(id: string): Promise<WithdrawalRequestResponse> {
  const ctx = await requireTenantCustomer();
  const existing = await db.customerWithdrawalRequest.findFirst({
    where: { id, customerId: ctx.userId, tenantId: ctx.tenantId },
    select: { id: true, status: true, reference: true, amountPesewa: true },
  });
  if (!existing) return { success: false, error: "That request was not found." };
  if (!customerCanCancel(existing.status)) {
    return {
      success: false,
      error: `You cannot cancel a request that is ${statusLabel(existing.status).toLowerCase()}.`,
    };
  }
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.customerWithdrawalRequest.update({
      where: { id: existing.id },
      data: { status: "cancelled", decidedAt: new Date(), decidedById: ctx.userId },
      select: requestSelect,
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "customer.withdrawal_request_cancelled",
      entityType: "customerWithdrawalRequest",
      entityId: existing.id,
      details: {
        reference: existing.reference,
        amountPesewa: existing.amountPesewa,
        financialMutation: false,
      },
    });
    return row;
  });
  return { success: true, data: toView(updated) };
}

/** The office queue. Oldest first, because a customer is waiting on each one. */
export async function getWithdrawalRequests(params?: {
  status?: WithdrawalRequestStatus | "open" | "all";
}): Promise<WithdrawalRequestResponse> {
  const ctx = await requireTenantAdminSusu();
  const scope = await resolveBranchScope(ctx);
  const status = params?.status ?? "open";
  const rows = await db.customerWithdrawalRequest.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(scope.kind === "limited" ? { branchId: { in: scope.branchIds } } : {}),
      ...(status === "all"
        ? {}
        : status === "open"
          ? { status: { in: OPEN_WITHDRAWAL_REQUEST_STATUSES } }
          : { status }),
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      ...requestSelect,
      customer: { select: { fullName: true, customerId: true, phone: true } },
    },
  });
  return {
    success: true,
    requests: rows.map((row) => ({
      ...toView(row),
      customerName: row.customer.fullName,
      customerReference: row.customer.customerId,
      customerPhoneLast4: row.customer.phone?.slice(-4) ?? null,
    })) as WithdrawalRequestView[],
  };
}

/**
 * Approve and record the withdrawal.
 *
 * `processWithdrawal` keeps its own step-up grant, commission rule, account lock
 * and receipt enqueue. When it refuses, the request stays where it is and the
 * refusal is returned unchanged, so an operator sees the real reason.
 */
export async function approveWithdrawalRequest(input: {
  id: string;
  stepUpToken: string;
}): Promise<WithdrawalRequestResponse> {
  const ctx = await requireTenantAdminSusu();
  const request = await db.customerWithdrawalRequest.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
    select: {
      id: true,
      status: true,
      reference: true,
      accountId: true,
      amountPesewa: true,
      customerId: true,
      branchId: true,
    },
  });
  if (!request) return { success: false, error: "That request was not found." };
  if (request.status !== "requested" && request.status !== "needs_review") {
    return {
      success: false,
      error: `This request is already ${statusLabel(request.status).toLowerCase()}.`,
    };
  }

  if (
    request.branchId &&
    !(await assertBranchAccess(ctx, request.branchId, "write"))
  ) {
    return { success: false, error: "This request belongs to a branch outside your scope" };
  }
  const result = await processWithdrawal({
    accountId: request.accountId,
    requestedAmount: request.amountPesewa / 100,
    notes: `Customer request ${request.reference}`,
    idempotencyKey: request.reference,
    stepUpToken: input.stepUpToken,
    branchId: request.branchId ?? undefined,
  });
  if (!result.success) {
    // A refusal from the domain action is the authoritative answer; the request
    // stays open so the operator can fix the cause and try again.
    return { success: false, error: result.error ?? "The withdrawal was refused." };
  }
  const withdrawalId =
    (result.data as { withdrawal?: { id?: string }; id?: string } | undefined)?.withdrawal?.id ??
    (result.data as { id?: string } | undefined)?.id ??
    null;

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.customerWithdrawalRequest.update({
      where: { id: request.id },
      data: {
        status: "paid",
        decidedById: ctx.userId,
        decidedAt: new Date(),
        decisionNote: "Approved and recorded as a withdrawal.",
        resultingWithdrawalId: withdrawalId,
      },
      select: requestSelect,
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "customer.withdrawal_request_paid",
      entityType: "customerWithdrawalRequest",
      entityId: request.id,
      details: {
        reference: request.reference,
        amountPesewa: request.amountPesewa,
        withdrawalId,
        financialMutation: true,
      },
    });
    return row;
  });

  return { success: true, data: toView(updated) };
}

export async function rejectWithdrawalRequest(input: {
  id: string;
  note: string;
}): Promise<WithdrawalRequestResponse> {
  const ctx = await requireTenantAdminSusu();
  const parsed = WITHDRAWAL_DECISION_SCHEMA.safeParse({ note: input.note });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Give a reason for the decision.",
    };
  }
  const request = await db.customerWithdrawalRequest.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
    select: { id: true, status: true, reference: true, amountPesewa: true },
  });
  if (!request) return { success: false, error: "That request was not found." };
  if (request.status === "paid") {
    return { success: false, error: "A paid request cannot be declined." };
  }
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.customerWithdrawalRequest.update({
      where: { id: request.id },
      data: {
        status: "rejected",
        decidedById: ctx.userId,
        decidedAt: new Date(),
        decisionNote: parsed.data.note,
      },
      select: requestSelect,
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "customer.withdrawal_request_rejected",
      entityType: "customerWithdrawalRequest",
      entityId: request.id,
      details: {
        reference: request.reference,
        amountPesewa: request.amountPesewa,
        note: parsed.data.note,
        financialMutation: false,
      },
    });
    return row;
  });
  return { success: true, data: toView(updated) };
}
