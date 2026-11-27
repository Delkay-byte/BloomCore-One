"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireTenantAdminSusu, type TenantContext } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";
import { recordRemittance } from "@/lib/actions/susu-collector.actions";
import { reverseContribution, reverseWithdrawal } from "@/lib/actions/financial-reversal.actions";
import {
  OFFLINE_REQUEST_KIND_LABELS,
  splitReversalSubject,
  type NormalizedOfflineRequest,
  type OfflineRequestKind,
} from "@/lib/offline/request-payload";

export interface OfflineRequestActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface OfflineRequestView {
  id: string;
  kind: OfflineRequestKind;
  kindLabel: string;
  status: string;
  statusLabel: string;
  amount: number | null;
  notes: string | null;
  reason: string | null;
  subjectId: string;
  /** Human-readable subject, resolved server-side and tenant-scoped. */
  subjectLabel: string;
  requestedById: string;
  requestedByName: string | null;
  requestedAt: string;
  conflictReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  resultingEntityType: string | null;
  resultingEntityId: string | null;
  ageHours: number;
  /**
   * The step-up grant the domain action will consume, so the browser asks for
   * the password on the same binding the server checks. Null means the action
   * needs no separate proof beyond the administrator session.
   */
  grant: {
    purpose: string;
    targetType: string;
    targetId: string;
    context: Record<string, string>;
  } | null;
}

// Not exported: a "use server" module may only export async functions. This map is
// an implementation detail used by the action responses below.
const OFFLINE_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting for authorisation",
  needs_review: "Needs review",
  authorised: "Authorised",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const STATUSES = ["pending", "needs_review", "authorised", "rejected", "cancelled"] as const;

function revalidateOfflineRequests() {
  revalidatePath("/susu/admin/offline-requests");
  revalidatePath("/susu/admin/approvals");
}

function parsePayload(payloadJson: string): NormalizedOfflineRequest | null {
  try {
    const parsed = JSON.parse(payloadJson) as Partial<NormalizedOfflineRequest>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.kind !== "string" || typeof parsed.subjectId !== "string") return null;
    return {
      kind: parsed.kind as OfflineRequestKind,
      subjectId: parsed.subjectId,
      amountMinor: typeof parsed.amountMinor === "number" ? parsed.amountMinor : null,
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return null;
  }
}

async function subjectLabels(
  tenantId: string,
  requests: Array<{ kind: string; payloadJson: string }>
): Promise<Map<string, string>> {
  const accountIds: string[] = [];
  const collectorIds: string[] = [];
  const withdrawalIds: string[] = [];
  const contributionIds: string[] = [];

  const parsed = requests.map((row) => parsePayload(row.payloadJson));
  for (const payload of parsed) {
    if (!payload) continue;
    if (payload.kind === "withdrawal") accountIds.push(payload.subjectId);
    if (payload.kind === "remittance") collectorIds.push(payload.subjectId);
    if (payload.kind === "reversal") {
      const split = splitReversalSubject(payload.subjectId);
      if (!split) continue;
      if (split.recordType === "withdrawal") withdrawalIds.push(split.recordId);
      else contributionIds.push(split.recordId);
    }
  }

  const labels = new Map<string, string>();
  if (accountIds.length > 0) {
    const accounts = await db.susuAccount.findMany({
      where: { tenantId, id: { in: accountIds } },
      select: { id: true, accountId: true, customer: { select: { fullName: true } } },
    });
    for (const account of accounts) {
      labels.set(
        `withdrawal:${account.id}`,
        `${account.customer?.fullName ?? "Customer"} · ${account.accountId}`
      );
    }
  }
  if (collectorIds.length > 0) {
    const collectors = await db.collector.findMany({
      where: { tenantId, id: { in: collectorIds } },
      select: { id: true, user: { select: { fullName: true } } },
    });
    for (const collector of collectors) {
      labels.set(`remittance:${collector.id}`, collector.user?.fullName ?? "Collector");
    }
  }
  if (withdrawalIds.length > 0) {
    const withdrawals = await db.withdrawal.findMany({
      where: { tenantId, id: { in: withdrawalIds } },
      select: { id: true, referenceId: true, netAmount: true },
    });
    for (const row of withdrawals) {
      labels.set(
        `reversal:withdrawal:${row.id}`,
        `${row.referenceId} · GH₵${Number(row.netAmount).toFixed(2)}`
      );
    }
  }
  if (contributionIds.length > 0) {
    const contributions = await db.contribution.findMany({
      where: { tenantId, id: { in: contributionIds } },
      select: { id: true, referenceId: true, amount: true },
    });
    for (const row of contributions) {
      labels.set(
        `reversal:contribution:${row.id}`,
        `${row.referenceId} · GH₵${Number(row.amount).toFixed(2)}`
      );
    }
  }
  return labels;
}

function labelForRow(
  row: { kind: string; payloadJson: string },
  labels: Map<string, string>
): string {
  const payload = parsePayload(row.payloadJson);
  if (!payload) return "Unknown subject";
  if (payload.kind === "reversal") {
    return labels.get(`reversal:${payload.subjectId}`) ?? payload.subjectId;
  }
  return labels.get(`${payload.kind}:${payload.subjectId}`) ?? payload.subjectId;
}

/**
 * Offline captures waiting for an administrator.
 *
 * Ordered oldest first, because an unanswered withdrawal request is a customer
 * standing at a counter.
 */
export async function getOfflineRequests(
  status?: string
): Promise<OfflineRequestView[]> {
  const ctx = await requireTenantAdminSusu();
  const filter = status && (STATUSES as readonly string[]).includes(status) ? status : undefined;
  const rows = await db.offlineActionRequest.findMany({
    where: { tenantId: ctx.tenantId, ...(filter ? { status: filter } : {}) },
    orderBy: { requestedAt: "asc" },
    take: 200,
  });
  if (rows.length === 0) return [];

  const [labels, users] = await Promise.all([
    subjectLabels(ctx.tenantId, rows),
    db.user.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: {
          in: Array.from(
            new Set(
              rows.flatMap((row) => [row.requestedById, row.decidedById].filter(Boolean) as string[])
            )
          ),
        },
      },
      select: { id: true, fullName: true },
    }),
  ]);
  const nameById = new Map(users.map((user) => [user.id, user.fullName]));
  const now = Date.now();

  return rows.map((row) => {
    const payload = parsePayload(row.payloadJson);
    return {
      id: row.id,
      kind: row.kind as OfflineRequestKind,
      kindLabel: OFFLINE_REQUEST_KIND_LABELS[row.kind as OfflineRequestKind] ?? row.kind,
      status: row.status,
      statusLabel: OFFLINE_REQUEST_STATUS_LABELS[row.status] ?? row.status,
      amount: payload?.amountMinor == null ? null : payload.amountMinor / 100,
      notes: payload?.notes ?? null,
      reason: payload?.reason ?? null,
      subjectId: payload?.subjectId ?? "",
      subjectLabel: labelForRow(row, labels),
      requestedById: row.requestedById,
      requestedByName: nameById.get(row.requestedById) ?? null,
      requestedAt: row.requestedAt.toISOString(),
      conflictReason: row.conflictReason,
      decidedByName: row.decidedById ? nameById.get(row.decidedById) ?? null : null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
      resultingEntityType: row.resultingEntityType,
      resultingEntityId: row.resultingEntityId,
      ageHours: Math.max(0, Math.floor((now - row.requestedAt.getTime()) / 3_600_000)),
      grant: grantFor(payload),
    };
  });
}

/** The exact step-up binding the downstream domain action will claim. */
function grantFor(payload: NormalizedOfflineRequest | null): OfflineRequestView["grant"] {
  if (!payload) return null;
  if (payload.kind === "withdrawal") {
    return {
      purpose: "susu.withdrawal",
      targetType: "susuAccount",
      targetId: payload.subjectId,
      context: {
        amountMinor: String(payload.amountMinor ?? 0),
        currency: "GHS",
      },
    };
  }
  if (payload.kind === "reversal") {
    const split = splitReversalSubject(payload.subjectId);
    if (!split) return null;
    return {
      purpose:
        split.recordType === "withdrawal"
          ? "susu.withdrawal.reverse"
          : "susu.contribution.reverse",
      targetType: split.recordType,
      targetId: split.recordId,
      context: {},
    };
  }
  // A remittance is recorded by an administrator under their own session; the
  // domain action consumes no separate grant.
  return null;
}

async function countPending(ctx: TenantContext): Promise<number> {
  return db.offlineActionRequest.count({
    where: { tenantId: ctx.tenantId, status: { in: ["pending", "needs_review"] } },
  });
}

/**
 * Authorise an offline capture.
 *
 * The decision is made here, online, by an administrator, and the actual record
 * is created by the same domain action the online screen would use — so there is
 * one implementation of the money rule, not two. If the domain action refuses
 * (no funds, cycle closed, already reversed), the request moves to `needs_review`
 * with the server's own reason instead of being retried blindly.
 */
export async function authoriseOfflineRequest(input: {
  id: string;
  note?: string;
  stepUpToken?: string;
}): Promise<OfflineRequestActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const request = await db.offlineActionRequest.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!request) return { success: false, error: "That request was not found." };
  if (request.status === "authorised") {
    return { success: false, error: "This request has already been authorised." };
  }
  if (request.status === "rejected" || request.status === "cancelled") {
    return { success: false, error: "This request is closed." };
  }

  const payload = parsePayload(request.payloadJson);
  if (!payload) return { success: false, error: "The stored request could not be read." };

  const note = input.note?.trim() || null;
  let result: { success: boolean; error?: string; data?: unknown } = { success: false };
  let resultingEntityType: string | null = null;
  let resultingEntityId: string | null = null;

  if (payload.kind === "withdrawal") {
    result = await processWithdrawal({
      accountId: payload.subjectId,
      requestedAmount: (payload.amountMinor ?? 0) / 100,
      notes: payload.notes ?? note ?? undefined,
      idempotencyKey: `OFFLINE-${request.id}`,
      stepUpToken: input.stepUpToken,
    });
    if (result.success) {
      resultingEntityType = "withdrawal";
      resultingEntityId =
        (result.data as { withdrawalId?: string; id?: string } | undefined)?.withdrawalId ??
        (result.data as { id?: string } | undefined)?.id ??
        null;
    }
  } else if (payload.kind === "remittance") {
    result = await recordRemittance({
      collectorId: payload.subjectId,
      remittedAmount: (payload.amountMinor ?? 0) / 100,
      notes: payload.notes ?? note ?? undefined,
      idempotencyKey: `OFFLINE-${request.id}`,
    });
    if (result.success) {
      resultingEntityType = "collectorRemittance";
      resultingEntityId =
        (result.data as { remittanceId?: string; id?: string } | undefined)?.remittanceId ??
        (result.data as { id?: string } | undefined)?.id ??
        null;
    }
  } else {
    const split = splitReversalSubject(payload.subjectId);
    if (!split) return { success: false, error: "The stored request could not be read." };
    result =
      split.recordType === "withdrawal"
        ? await reverseWithdrawal({
            withdrawalId: split.recordId,
            reason: payload.reason ?? "Reversal requested from an offline capture.",
            stepUpToken: input.stepUpToken,
          })
        : await reverseContribution({
            contributionId: split.recordId,
            reason: payload.reason ?? "Reversal requested from an offline capture.",
            stepUpToken: input.stepUpToken,
          });
    if (result.success) {
      resultingEntityType = `${split.recordType}Reversal`;
      resultingEntityId =
        (result.data as { reversalId?: string; id?: string } | undefined)?.reversalId ??
        (result.data as { id?: string } | undefined)?.id ??
        null;
    }
  }

  const now = new Date();
  if (!result.success) {
    // A refusal from the domain action is information, not a transport error:
    // keep the request, record why, and let a person decide what to do.
    await db.$transaction(async (tx) => {
      await tx.offlineActionRequest.update({
        where: { id: request.id },
        data: {
          status: "needs_review",
          conflictReason: result.error ?? "The record could not be created.",
          decidedById: ctx.userId,
          decidedAt: now,
          decisionNote: note,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "offline.request_authorise_refused",
        entityType: "offlineActionRequest",
        entityId: request.id,
        details: {
          kind: payload.kind,
          reason: result.error ?? null,
          financialMutation: false,
        },
      });
    });
    revalidateOfflineRequests();
    return {
      success: false,
      error:
        result.error ??
        "The record could not be created. The request was moved to review with this reason.",
    };
  }

  await db.$transaction(async (tx) => {
    await tx.offlineActionRequest.update({
      where: { id: request.id },
      data: {
        status: "authorised",
        conflictReason: null,
        decidedById: ctx.userId,
        decidedAt: now,
        decisionNote: note,
        resultingEntityType,
        resultingEntityId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "offline.request_authorised",
      entityType: "offlineActionRequest",
      entityId: request.id,
      details: {
        kind: payload.kind,
        resultingEntityType,
        resultingEntityId,
        note,
        requestedById: request.requestedById,
        // The money movement happened inside the domain action, which audits it
        // itself; this event records the offline decision only.
        financialMutation: false,
      },
    });
  });

  revalidateOfflineRequests();
  return { success: true, data: { resultingEntityType, resultingEntityId } };
}

/** Refuse an offline capture, with a reason the collector can read. */
export async function rejectOfflineRequest(input: {
  id: string;
  note: string;
}): Promise<OfflineRequestActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const note = input.note?.trim() ?? "";
  if (note.length < 5) {
    return { success: false, error: "Write why the request was refused (at least 5 characters)." };
  }

  const request = await db.offlineActionRequest.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!request) return { success: false, error: "That request was not found." };
  if (request.status === "authorised") {
    return { success: false, error: "An authorised request cannot be rejected." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.offlineActionRequest.updateMany({
        where: { id: request.id, tenantId: ctx.tenantId, status: { not: "authorised" } },
        data: {
          status: "rejected",
          decidedById: ctx.userId,
          decidedAt: new Date(),
          decisionNote: note,
        },
      });
      if (updated.count !== 1) throw new Error("CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "offline.request_rejected",
        entityType: "offlineActionRequest",
        entityId: request.id,
        details: { note, financialMutation: false },
      });
    });
  } catch {
    return { success: false, error: "The request could not be rejected." };
  }

  revalidateOfflineRequests();
  return { success: true };
}

/** Badge count for the navigation and the approvals screen. */
export async function getOfflineRequestCount(): Promise<number> {
  const ctx = await requireTenantAdminSusu();
  return countPending(ctx);
}
