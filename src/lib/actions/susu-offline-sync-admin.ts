"use server";

/**
 * Administrative visibility into offline contribution synchronization.
 *
 * Phase 2 addition. Authorized tenant administrators can inspect pending,
 * accepted, already-synced, rejected and failed sync attempts, with failure
 * reasons, collector/device context and timestamps. No encrypted payload and
 * no authentication material is ever exposed. Collectors cannot read or write
 * these rows.
 *
 * A safe retry is an administrator-authorized signal that the collector may
 * resend the same idempotency key from their device — it never replays a
 * stored payload server-side, so it cannot create a duplicate financial
 * transaction.
 */

import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import { requireTenantAdminSusu } from "@/lib/tenant";

interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface OfflineSyncAttemptView {
  id: string;
  kind: string;
  outcome: string;
  reasonCode?: string | null;
  reason?: string | null;
  retryable: boolean;
  httpStatus?: number | null;
  userId: string;
  deviceId?: string | null;
  idempotencyKey?: string | null;
  accountId?: string | null;
  collectorId?: string | null;
  amount?: number | null;
  capturedAt?: Date | null;
  payloadDigest?: string | null;
  retriedAt?: Date | null;
  retriedById?: string | null;
  resolution?: string | null;
  resolvedAt?: Date | null;
  resolvedById?: string | null;
  createdAt: Date;
}

interface ListOfflineSyncAttemptsParams {
  outcome?: string | null;
  retryable?: boolean | null;
  collectorId?: string | null;
  deviceId?: string | null;
  page?: number;
  limit?: number;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export async function listOfflineSyncAttempts(params: ListOfflineSyncAttemptsParams) {
  const ctx = await requireTenantAdminSusu();

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    kind: "contribution",
  };
  if (params.outcome) where.outcome = params.outcome;
  if (params.retryable !== undefined) where.retryable = params.retryable;
  if (params.collectorId) where.collectorId = params.collectorId;
  if (params.deviceId) where.deviceId = params.deviceId;
  if (params.dateFrom || params.dateTo) {
    where.createdAt = {};
    if (params.dateFrom) (where.createdAt as Record<string, Date>).gte = new Date(params.dateFrom + "T00:00:00Z");
    if (params.dateTo) (where.createdAt as Record<string, Date>).lte = new Date(params.dateTo + "T23:59:59.999Z");
  }

  const [attempts, total] = await Promise.all([
    db.offlineSyncAttempt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.offlineSyncAttempt.count({ where }),
  ]);

  return {
    attempts: attempts.map((a) => ({
      id: a.id,
      kind: a.kind,
      outcome: a.outcome,
      reasonCode: a.reasonCode ?? null,
      reason: a.reason ?? null,
      retryable: a.retryable,
      httpStatus: a.httpStatus ?? null,
      userId: a.userId,
      deviceId: a.deviceId ?? null,
      idempotencyKey: a.idempotencyKey ?? null,
      accountId: a.accountId ?? null,
      collectorId: a.collectorId ?? null,
      amount: a.amount ? Number(a.amount) : null,
      capturedAt: a.capturedAt ?? null,
      payloadDigest: a.payloadDigest ?? null,
      retriedAt: a.retriedAt ?? null,
      retriedById: a.retriedById ?? null,
      resolution: a.resolution ?? null,
      resolvedAt: a.resolvedAt ?? null,
      resolvedById: a.resolvedById ?? null,
      createdAt: a.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Authorized administrator resolves or dismisses a sync attempt. Resolution is
 * append-only: a resolved attempt can be re-opened by recording a new state,
 * but the original outcome is never erased.
 */
export async function resolveOfflineSyncAttempt(params: {
  attemptId: string;
  resolution: "resolved" | "dismissed";
  note?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const { attemptId, resolution, note } = params;

  const attempt = await db.offlineSyncAttempt.findFirst({
    where: { id: attemptId, tenantId: ctx.tenantId },
  });
  if (!attempt) {
    return { success: false, error: "Sync attempt not found" };
  }

  await db.$transaction(async (tx) => {
    await tx.offlineSyncAttempt.update({
      where: { id: attemptId },
      data: {
        resolution,
        resolvedAt: new Date(),
        resolvedById: ctx.userId,
        reason: attempt.reason
          ? `${attempt.reason} | Administrator resolution: ${resolution}${
              note ? `. ${note}` : ""
            }`
          : `Administrator resolution: ${resolution}${note ? `. ${note}` : ""}`,
      },
    });

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.offline_sync_attempt_resolved",
      entityType: "offlineSyncAttempt",
      entityId: attemptId,
      details: {
        attemptId,
        outcome: attempt.outcome,
        reasonCode: attempt.reasonCode,
        resolution,
        note: note ?? null,
      },
    });
  });

  return { success: true, data: { attemptId, resolution } };
}

/**
 * Administrator-authorized retry signal for a retryable failed or rejected
 * sync attempt.
 *
 * This does NOT replay any stored payload (none is stored) and does NOT create
 * a financial transaction. It records the retry authorization and returns the
 * idempotency key and device context so the collector can resend the same
 * offline transaction from their device; the server-side idempotency guard on
 * the key prevents a duplicate posting.
 */
export async function retryOfflineSyncAttempt(params: {
  attemptId: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const { attemptId } = params;

  const attempt = await db.offlineSyncAttempt.findFirst({
    where: { id: attemptId, tenantId: ctx.tenantId },
  });
  if (!attempt) {
    return { success: false, error: "Sync attempt not found" };
  }
  if (!attempt.retryable) {
    return {
      success: false,
      error: "This failure is not retryable. Review the reason before resolving.",
    };
  }
  if (attempt.outcome === "accepted") {
    return { success: false, error: "This attempt was already accepted." };
  }

  await db.$transaction(async (tx) => {
    await tx.offlineSyncAttempt.update({
      where: { id: attemptId },
      data: {
        retriedAt: new Date(),
        retriedById: ctx.userId,
        resolution: "resolved",
        resolvedAt: new Date(),
        resolvedById: ctx.userId,
        reason: attempt.reason
          ? `${attempt.reason} | Administrator authorized a safe retry (no server-side repost).`
          : "Administrator authorized a safe retry (no server-side repost).",
      },
    });

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.offline_sync_attempt_retried",
      entityType: "offlineSyncAttempt",
      entityId: attemptId,
      details: {
        attemptId,
        outcome: attempt.outcome,
        reasonCode: attempt.reasonCode,
        idempotencyKey: attempt.idempotencyKey,
        deviceId: attempt.deviceId,
        collectorId: attempt.collectorId,
        accountId: attempt.accountId,
      },
    });
  });

  return {
    success: true,
    data: {
      attemptId,
      idempotencyKey: attempt.idempotencyKey ?? null,
      deviceId: attempt.deviceId ?? null,
      collectorId: attempt.collectorId ?? null,
      accountId: attempt.accountId ?? null,
      reason:
        "The collector should resend the same offline transaction from their device. " +
        "The server idempotency guard prevents duplicate posting.",
    },
  };
}
