"use server";

import { db } from "@/lib/db";
import { getAdminSession } from "@/lib/auth";
import { requireTenantAdminSusu, requireTenantCollector, assertTenantEntity } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { createHash, randomBytes } from "crypto";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { lockAccountForUpdate } from "@/lib/db-lock";
import { validateRemittanceAmount } from "@/lib/finance/remittance";

type ActionResponse = { success: boolean; error?: string; data?: unknown };

const VALID_METHODS = new Set(["cash", "momo", "bank", "other"]);

export async function declareRemittance(params: {
  collectorId?: string;
  contributionIds?: string[];
  periodStart?: string | Date;
  periodEnd?: string | Date;
  declaredAmount: number;
  method?: string;
  provider?: string;
  transactionReference?: string;
  transactionAt?: string | Date;
  evidenceRef?: string;
  notes?: string;
  idempotencyKey?: string;
}): Promise<ActionResponse> {
  let adminCtx: any = null;
  try { adminCtx = await requireTenantAdminSusu(); } catch { adminCtx = null; }

  let ctxTenantId: string;
  let ctxUserId: string;
  let collectorId = params.collectorId;

  if (adminCtx) {
    ctxTenantId = adminCtx.tenantId;
    ctxUserId = adminCtx.userId;
    if (!collectorId) return { success: false, error: "Collector is required" };
  } else {
    const collectorCtx = await requireTenantCollector();
    ctxTenantId = collectorCtx.tenantId;
    ctxUserId = collectorCtx.userId;
    const collector = await db.collector.findFirst({ where: { tenantId: ctxTenantId, userId: ctxUserId, status: "active" } });
    if (!collector) return { success: false, error: "Active collector record not found" };
    collectorId = collector.id;
  }

  const amount = validateRemittanceAmount(params.declaredAmount);
  if (!amount.ok) return { success: false, error: amount.error };
  const declared = amount.value;

  const method = params.method || "cash";
  if (!VALID_METHODS.has(method)) return { success: false, error: "Unsupported remittance method" };
  if (method !== "cash" && !params.transactionReference?.trim()) {
    return { success: false, error: "Transaction reference is required for electronic remittances" };
  }

  const rawKey = params.idempotencyKey;
  if (rawKey !== undefined && !/^[A-Za-z0-9:_-]{8,120}$/.test(rawKey)) {
    return { success: false, error: "Invalid idempotency key." };
  }
  const idempotencyKey = rawKey ? `REMDEC-${rawKey}` : null;
  const requestHash = createHash("sha256").update(JSON.stringify({ collectorId, declared, method, ids: params.contributionIds || [] })).digest("hex");

  const rate = await consumeRateLimit("finance:remittance_declare", `${ctxTenantId}:${ctxUserId}`, RATE_LIMITS.financeMutation);
  if (!rate.allowed) return { success: false, error: "Too many financial actions. Please wait and try again." };

  const collector = await db.collector.findFirst({ where: { id: collectorId!, tenantId: ctxTenantId } });
  if (!collector) return { success: false, error: "Collector not found" };

  try {
    const remittance = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `collector-remittance:${collectorId}`);

      if (idempotencyKey) {
        const existing = await tx.collectorRemittance.findFirst({ where: { tenantId: ctxTenantId, idempotencyKey } });
        if (existing) {
          if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
          return existing;
        }
      }

      const linked = await tx.remittanceContribution.findMany({
        where: { remittance: { collectorId: collectorId!, tenantId: ctxTenantId, reversedAt: null } },
        select: { contributionId: true },
      });
      const linkedIds = new Set(linked.map((r) => r.contributionId));

      const where: any = { collectorId: collectorId!, tenantId: ctxTenantId, reversedAt: null };
      if (params.periodStart) where.collectionDate = { ...(where.collectionDate || {}), gte: new Date(params.periodStart) };
      if (params.periodEnd) where.collectionDate = { ...(where.collectionDate || {}), lte: new Date(params.periodEnd) };

      let eligible = await tx.contribution.findMany({ where });
      eligible = eligible.filter((c) => !linkedIds.has(c.id));

      let selected = eligible;
      if (params.contributionIds?.length) {
        const allowed = new Set(params.contributionIds);
        selected = eligible.filter((c) => allowed.has(c.id));
        if (selected.length !== params.contributionIds.length) throw new Error("INVALID_CONTRIBUTIONS");
      }

      const expectedAmount = Math.round(selected.reduce((sum, c) => sum + Number(c.amount), 0) * 100) / 100;
      if (selected.length > 0 && declared > expectedAmount + 0.0001) throw new Error("OVER_REMITTANCE");

      const referenceId = `REM-${randomBytes(8).toString("hex")}`;
      const remittance = await tx.collectorRemittance.create({
        data: {
          tenantId: ctxTenantId,
          collectorId: collectorId!,
          expectedAmount,
          remittedAmount: declared,
          declaredAmount: declared,
          variance: expectedAmount - declared,
          status: "submitted",
          method,
          provider: params.provider?.trim() || null,
          transactionReference: params.transactionReference?.trim() || null,
          transactionAt: params.transactionAt ? new Date(params.transactionAt) : null,
          evidenceRef: params.evidenceRef?.trim() || null,
          declarationNote: params.notes?.trim() || null,
          declaredById: ctxUserId,
          submittedAt: new Date(),
          recordedById: ctxUserId,
          referenceId,
          idempotencyKey,
          requestHash,
          notes: params.notes?.trim() || null,
          outstandingAmount: Math.max(0, expectedAmount - declared),
          reconciliationStatus: "pending",
        },
      });

      for (const c of selected) {
        await tx.remittanceContribution.create({
          data: { tenantId: ctxTenantId, remittanceId: remittance.id, contributionId: c.id, amount: c.amount },
        });
      }

      if (Math.abs(expectedAmount - declared) > 0.0001) {
        await tx.remittanceDiscrepancy.create({
          data: {
            tenantId: ctxTenantId,
            remittanceId: remittance.id,
            type: "declaration_variance",
            expectedAmount,
            declaredAmount: declared,
            variance: expectedAmount - declared,
            reason: "Declared amount differs from system-calculated expected amount",
            status: "open",
          },
        });
      }

      await createAuditLogTx(tx, {
        userId: ctxUserId,
        tenantId: ctxTenantId,
        action: "susu.remittance_declared",
        entityType: "remittance",
        entityId: remittance.id,
        details: { collectorId, expectedAmount, declaredAmount: declared, method, contributionCount: selected.length },
      });

      return remittance;
    });

    revalidatePath("/susu/admin/remittances");
    return { success: true, data: remittance };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "IDEMPOTENCY_CONFLICT") {
        const existing = await db.collectorRemittance.findFirst({ where: { tenantId: ctxTenantId, idempotencyKey } });
        if (existing && existing.requestHash !== requestHash) {
          return { success: false, error: "This idempotency key was already used with different remittance details." };
        }
        if (existing) return { success: true, data: existing };
      }
      if (error.message === "INVALID_CONTRIBUTIONS") return { success: false, error: "One or more contributions are not eligible" };
      if (error.message === "OVER_REMITTANCE") return { success: false, error: "Declared amount exceeds eligible expected amount" };
    }
    if (typeof error === "object" && error !== null && "code" in error && (error as any).code === "P2002" && idempotencyKey) {
      const existing = await db.collectorRemittance.findFirst({ where: { tenantId: ctxTenantId, idempotencyKey } });
      if (existing) return { success: true, data: existing };
    }
    return { success: false, error: "Remittance declaration failed" };
  }
}

export async function getRemittanceById(id: string) {
  const ctx = await requireTenantAdminSusu();
  return db.collectorRemittance.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      collector: { include: { user: { select: { fullName: true } } } },
      contributions: { include: { contribution: true } },
      discrepancies: true,
    },
  });
}

export async function acknowledgeRemittanceReceipt(params: {
  remittanceId: string;
  receivedAmount: number;
  method?: string;
  note?: string;
  evidenceRef?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const amount = validateRemittanceAmount(params.receivedAmount);
  if (!amount.ok) return { success: false, error: amount.error };
  const received = amount.value;

  const remittance = await db.collectorRemittance.findFirst({ where: { id: params.remittanceId, tenantId: ctx.tenantId } });
  if (!remittance) return { success: false, error: "Remittance not found" };
  if (remittance.reversedAt) return { success: false, error: "Remittance is reversed" };

  const result = await db.$transaction(async (tx) => {
    await lockAccountForUpdate(tx, `collector-remittance:${remittance.collectorId}`);
    const updated = await tx.collectorRemittance.update({
      where: { id: remittance.id },
      data: {
        receivedAmount: received,
        receivedAt: new Date(),
        receivedById: ctx.userId,
        receiptNote: params.note?.trim() || null,
        receiptEvidenceRef: params.evidenceRef?.trim() || null,
        method: params.method || remittance.method,
      },
    });

    if (Math.abs(received - Number(remittance.remittedAmount)) > 0.0001) {
      await tx.remittanceDiscrepancy.create({
        data: {
          tenantId: ctx.tenantId,
          remittanceId: remittance.id,
          type: "receipt_variance",
          expectedAmount: Number(remittance.expectedAmount),
          declaredAmount: Number(remittance.remittedAmount),
          receivedAmount: received,
          variance: Number(remittance.remittedAmount) - received,
          reason: "Received amount differs from declared amount",
          status: "open",
        },
      });
      await tx.collectorRemittance.update({
        where: { id: remittance.id },
        data: { status: "disputed", reconciliationStatus: "disputed", outstandingAmount: Math.max(0, Number(remittance.expectedAmount) - received) },
      });
    } else {
      await tx.collectorRemittance.update({
        where: { id: remittance.id },
        data: {
          status: received >= Number(remittance.expectedAmount) ? "received" : "partially_received",
          outstandingAmount: Math.max(0, Number(remittance.expectedAmount) - received),
        },
      });
    }

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.remittance_receipt_acknowledged",
      entityType: "remittance",
      entityId: remittance.id,
      details: { receivedAmount: received },
    });

    return updated;
  });

  revalidatePath("/susu/admin/remittances");
  return { success: true, data: result };
}

export async function verifyRemittance(params: {
  remittanceId: string;
  verifiedAmount: number;
  approve?: boolean;
  note?: string;
  evidenceRef?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const amount = validateRemittanceAmount(params.verifiedAmount);
  if (!amount.ok) return { success: false, error: amount.error };
  const verified = amount.value;

  const remittance = await db.collectorRemittance.findFirst({ where: { id: params.remittanceId, tenantId: ctx.tenantId } });
  if (!remittance) return { success: false, error: "Remittance not found" };

  if (remittance.declaredById && remittance.declaredById === ctx.userId) {
    return { success: false, error: "The declaring user cannot verify the same remittance" };
  }
  if (remittance.receivedById && remittance.receivedById === ctx.userId) {
    return { success: false, error: "The receiving user cannot independently verify the same remittance" };
  }

  const received = Number(remittance.receivedAmount ?? remittance.remittedAmount);
  const result = await db.$transaction(async (tx) => {
    await lockAccountForUpdate(tx, `collector-remittance:${remittance.collectorId}`);
    const hasMismatch = Math.abs(verified - received) > 0.0001;
    const updated = await tx.collectorRemittance.update({
      where: { id: remittance.id },
      data: {
        verifiedAmount: verified,
        verifiedAt: new Date(),
        verifiedById: ctx.userId,
        verificationNote: params.note?.trim() || null,
        verificationEvidenceRef: params.evidenceRef?.trim() || null,
        status: params.approve === false ? "returned" : (hasMismatch ? "disputed" : "verified"),
        outstandingAmount: Math.max(0, Number(remittance.expectedAmount) - verified),
        reconciliationStatus: hasMismatch ? "disputed" : "reconciled",
      },
    });

    if (hasMismatch) {
      await tx.remittanceDiscrepancy.create({
        data: {
          tenantId: ctx.tenantId,
          remittanceId: remittance.id,
          type: "verification_variance",
          expectedAmount: Number(remittance.expectedAmount),
          declaredAmount: Number(remittance.remittedAmount),
          receivedAmount: received,
          verifiedAmount: verified,
          variance: received - verified,
          reason: params.note?.trim() || "Verified amount differs from received amount",
          status: "open",
        },
      });
    }

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: params.approve === false ? "susu.remittance_verification_returned" : "susu.remittance_verified",
      entityType: "remittance",
      entityId: remittance.id,
      details: { verifiedAmount: verified, mismatch: hasMismatch },
    });

    return updated;
  });

  revalidatePath("/susu/admin/remittances");
  return { success: true, data: result };
}

export async function resolveRemittanceDiscrepancy(params: {
  discrepancyId: string;
  resolutionNotes: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const discrepancy = await db.remittanceDiscrepancy.findFirst({ where: { id: params.discrepancyId, tenantId: ctx.tenantId } });
  if (!discrepancy) return { success: false, error: "Discrepancy not found" };

  const updated = await db.remittanceDiscrepancy.update({
    where: { id: discrepancy.id },
    data: {
      status: "resolved",
      resolutionActorId: ctx.userId,
      resolutionAt: new Date(),
      resolutionNotes: params.resolutionNotes?.trim() || null,
    },
  });

  await db.collectorRemittance.updateMany({
    where: { id: discrepancy.remittanceId, tenantId: ctx.tenantId },
    data: { reconciliationStatus: "reconciled" },
  });

  revalidatePath("/susu/admin/remittances");
  return { success: true, data: updated };
}

export async function reverseRemittanceDeclaration(params: {
  remittanceId: string;
  reason: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const remittance = await db.collectorRemittance.findFirst({ where: { id: params.remittanceId, tenantId: ctx.tenantId } });
  if (!remittance) return { success: false, error: "Remittance not found" };
  if (remittance.reversedAt) return { success: false, error: "Already reversed" };

  const updated = await db.collectorRemittance.update({
    where: { id: remittance.id },
    data: {
      status: "reversed",
      reversedAt: new Date(),
      reversedById: ctx.userId,
      reversalReason: params.reason?.trim() || null,
      reconciliationStatus: "closed",
    },
  });

  await db.remittanceContribution.deleteMany({ where: { remittanceId: remittance.id } });

  revalidatePath("/susu/admin/remittances");
  return { success: true, data: updated };
}
