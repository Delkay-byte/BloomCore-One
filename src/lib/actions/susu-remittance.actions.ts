/**
 * Susu remittance lifecycle (Phase 3, integrated).
 *
 * The chain this module owns:
 *   Contribution -> declaration (this remittance) -> RemittanceContribution
 *   links -> custody/handover at a branch -> receipt -> independent finance
 *   verification -> outstanding balance -> discrepancies -> resolution.
 *
 * Rules enforced server-side, not in the UI:
 *   * A declaration never creates or edits a customer contribution.
 *   * Only cash actually received settles a contribution, and a contribution
 *     can never be settled beyond its own amount.
 *   * Receipt/custody is a separate act from finance verification;
 *     acknowledging a receipt NEVER sets a verification.
 *   * A verifier may not verify a remittance they declared or received.
 *   * Reversing a declaration keeps every link and actor as audit evidence;
 *     the reversed declaration is simply excluded from settlement.
 */

"use server";

import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { createHash, randomBytes } from "crypto";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { lockAccountForUpdate } from "@/lib/db-lock";
import { validateRemittanceAmount } from "@/lib/finance/remittance";
import {
  allocateToContributions,
  computeCollectorObligation,
  money,
} from "@/lib/finance/remittance-settlement";
import { requireTenantAdminSusu, requireTenantCollector, type TenantContext } from "@/lib/tenant";
import {
  LEGACY_UNASSIGNED_BRANCH,
  assertBranchAccess,
  isBranchlessTenant,
  resolveBranchScope,
} from "@/lib/branch";

type ActionResponse = { success: boolean; error?: string; data?: unknown };

const VALID_METHODS = new Set(["cash", "momo", "bank", "other"]);

const STATUS = {
  submitted: "submitted",
  received: "received",
  verified: "verified",
  returned: "returned",
  disputed: "disputed",
  reversed: "reversed",
} as const;

/**
 * Resolve the acting staff identity for a remittance action. Collectors may
 * only declare their own cash; every other action is tenant-administrator work
 * (branch managers and finance verifiers are administrators with a membership).
 */
async function resolveActor(): Promise<{ ctx: TenantContext; kind: "admin" | "collector" }> {
  try {
    return { ctx: await requireTenantAdminSusu(), kind: "admin" };
  } catch {
    return { ctx: await requireTenantCollector(), kind: "collector" };
  }
}

/**
 * Finance-verification authority for one branch.
 *
 * `company`  - a tenant administrator with no scope-reducing membership.
 * `branch`   - an administrator holding an active `finance` membership there.
 *
 * A branch_manager-only membership is NOT finance authority: receiving cash at
 * a branch and independently verifying it are different duties.
 */
async function financeAuthority(
  ctx: TenantContext,
  branchId: string | null | undefined
): Promise<"company" | "branch" | null> {
  if (ctx.role !== "admin") return null;
  const scope = await resolveBranchScope(ctx);
  if (scope.kind === "all") return "company";
  if (!branchId || branchId === LEGACY_UNASSIGNED_BRANCH) return null;
  if (!scope.branchIds.includes(branchId)) return null;
  return scope.roles.includes("finance") ? "branch" : null;
}

async function requireCompanyWideAdmin(ctx: TenantContext): Promise<boolean> {
  return ctx.role === "admin" && (await resolveBranchScope(ctx)).kind === "all";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDate(value: string | Date | undefined, label: string): Date | null {
  if (value === undefined || value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`INVALID_${label}`);
  return parsed;
}

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
  let actor: { ctx: TenantContext; kind: "admin" | "collector" };
  try {
    actor = await resolveActor();
  } catch {
    return { success: false, error: "Not authorised" };
  }
  const { ctx, kind } = actor;

  let collectorId = params.collectorId;
  if (kind === "collector") {
    const own = await db.collector.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId },
      select: { id: true, status: true },
    });
    if (!own) return { success: false, error: "Active collector record not found" };
    if (own.status !== "active") {
      return { success: false, error: "A suspended or inactive collector cannot declare a remittance" };
    }
    if (collectorId && collectorId !== own.id) {
      return { success: false, error: "Collectors can only declare their own collections" };
    }
    collectorId = own.id;
  } else if (!collectorId) {
    return { success: false, error: "Collector is required" };
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
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        collectorId,
        declared,
        method,
        ids: params.contributionIds || [],
        start: params.periodStart ?? null,
        end: params.periodEnd ?? null,
      })
    )
    .digest("hex");

  const rate = await consumeRateLimit(
    "finance:remittance_declare",
    `${ctx.tenantId}:${ctx.userId}`,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) return { success: false, error: "Too many financial actions. Please wait and try again." };

  const collector = await db.collector.findFirst({
    where: { id: collectorId!, tenantId: ctx.tenantId },
    select: { id: true, userId: true, status: true, branchId: true },
  });
  if (!collector) return { success: false, error: "Collector not found" };
  if (collector.status !== "active") {
    return { success: false, error: "A suspended or inactive collector cannot declare a remittance" };
  }

  if (collector.branchId) {
    if (!(await assertBranchAccess(ctx, collector.branchId, "write"))) {
      return { success: false, error: "This collector is outside your branch scope" };
    }
  } else if (!(await isBranchlessTenant(ctx))) {
    return { success: false, error: "Assign the collector to a branch before declaring a remittance" };
  }
  const branchId = collector.branchId ?? null;

  try {
    const remittance = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `collector-remittance:${collectorId}`);

      if (idempotencyKey) {
        const existing = await tx.collectorRemittance.findFirst({
          where: { tenantId: ctx.tenantId, idempotencyKey },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
          return existing;
        }
      }

      const obligation = await computeCollectorObligation(tx, ctx.tenantId, collectorId!);
      const expectedAmount = obligation.outstanding;

      // An optional explicit selection narrows which contributions are linked,
      // but the obligation itself is always the full unsettled balance.
      if (params.contributionIds?.length) {
        const ids = new Set(params.contributionIds);
        const found = await tx.contribution.findMany({
          where: {
            id: { in: params.contributionIds },
            tenantId: ctx.tenantId,
            collectorId: collectorId!,
            reversedAt: null,
          },
          select: { id: true },
        });
        if (found.length !== ids.size) throw new Error("INVALID_CONTRIBUTIONS");
      }

      const periodStart = parseDate(params.periodStart, "PERIOD_START");
      const periodEnd = parseDate(params.periodEnd, "PERIOD_END");
      if (periodStart && periodEnd && periodStart > periodEnd) throw new Error("INVALID_PERIOD");

      const variance = round(expectedAmount - declared);
      const referenceId = `REM-${randomBytes(8).toString("hex")}`;

      const created = await tx.collectorRemittance.create({
        data: {
          tenantId: ctx.tenantId,
          branchId,
          collectorId: collectorId!,
          expectedAmount,
          remittedAmount: declared,
          declaredAmount: declared,
          variance,
          status: STATUS.submitted,
          method,
          provider: params.provider?.trim() || null,
          transactionReference: params.transactionReference?.trim() || null,
          transactionAt: parseDate(params.transactionAt, "TRANSACTION_DATE"),
          evidenceRef: params.evidenceRef?.trim() || null,
          declarationNote: params.notes?.trim() || null,
          declaredById: ctx.userId,
          submittedAt: new Date(),
          recordedById: ctx.userId,
          referenceId,
          idempotencyKey,
          requestHash,
          notes: params.notes?.trim() || null,
          outstandingAmount: Math.max(0, variance),
          reconciliationStatus: "pending",
        },
      });

      // Cash received beyond what the collector's contributions justify is a
      // real variance for finance to explain, not a settlement.
      if (declared > expectedAmount + 0.0001) {
        await tx.remittanceDiscrepancy.create({
          data: {
            tenantId: ctx.tenantId,
            remittanceId: created.id,
            type: "over_remittance",
            expectedAmount,
            declaredAmount: declared,
            variance: round(declared - expectedAmount),
            reason: "Declared amount exceeds the collector's outstanding collections",
            status: "open",
          },
        });
      }

      await allocateToContributions(tx, {
        tenantId: ctx.tenantId,
        collectorId: collectorId!,
        remittanceId: created.id,
        amount: declared,
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId,
        action: "susu.remittance_declared",
        entityType: "remittance",
        entityId: created.id,
        details: {
          collectorId,
          expectedAmount,
          declaredAmount: declared,
          outstandingBefore: expectedAmount,
          outstandingAfter: Math.max(0, variance),
          method,
        },
      });

      return created;
    });

    revalidatePath("/susu/admin/remittances");
    revalidatePath("/susu/collector/dashboard");
    return { success: true, data: remittance };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "IDEMPOTENCY_CONFLICT") {
        const existing = await db.collectorRemittance.findFirst({
          where: { tenantId: ctx.tenantId, idempotencyKey },
        });
        if (existing && existing.requestHash !== requestHash) {
          return { success: false, error: "This idempotency key was already used with different remittance details." };
        }
      }
      if (error.message === "INVALID_CONTRIBUTIONS") return { success: false, error: "One or more contributions are not eligible" };
      if (error.message === "INVALID_PERIOD") return { success: false, error: "The reporting period is invalid" };
      if (error.message === "INVALID_PERIOD_START" || error.message === "INVALID_PERIOD_END" || error.message === "INVALID_TRANSACTION_DATE") {
        return { success: false, error: "A supplied date is invalid" };
      }
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002" &&
      idempotencyKey
    ) {
      const existing = await db.collectorRemittance.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey },
      });
      if (existing) return { success: true, data: existing };
    }
    return { success: false, error: "Remittance declaration failed" };
  }
}

export async function getCollectorRemittancePosition(collectorId?: string) {
  const actor = await resolveActor();
  let target = collectorId;
  if (actor.kind === "collector") {
    const own = await db.collector.findFirst({
      where: { tenantId: actor.ctx.tenantId, userId: actor.ctx.userId },
      select: { id: true },
    });
    if (!own) return null;
    target = own.id;
  }
  if (!target) return null;

  const collector = await db.collector.findFirst({
    where: { id: target, tenantId: actor.ctx.tenantId },
    select: { id: true, branchId: true, status: true },
  });
  if (!collector) return null;
  if (!(await assertBranchAccess(actor.ctx, collector.branchId, "read"))) return null;

  return computeCollectorObligation(
    db as unknown as Parameters<typeof computeCollectorObligation>[0],
    actor.ctx.tenantId,
    collector.id
  );
}

export async function getRemittanceById(id: string) {
  const ctx = await requireTenantAdminSusu();
  const remittance = await db.collectorRemittance.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      collector: { include: { user: { select: { fullName: true } } } },
      contributions: { include: { contribution: true } },
      discrepancies: true,
    },
  });
  if (!remittance) return null;
  if (!(await assertBranchAccess(ctx, remittance.branchId, "read"))) return null;
  return remittance;
}

export async function acknowledgeRemittanceReceipt(params: {
  remittanceId: string;
  receivedAmount: number;
  method?: string;
  note?: string;
  evidenceRef?: string;
  receivingBranchId?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const amount = validateRemittanceAmount(params.receivedAmount);
  if (!amount.ok) return { success: false, error: amount.error };
  const received = amount.value;

  const remittance = await db.collectorRemittance.findFirst({
    where: { id: params.remittanceId, tenantId: ctx.tenantId },
  });
  if (!remittance) return { success: false, error: "Remittance not found" };
  if (remittance.reversedAt) return { success: false, error: "Remittance is reversed" };
  if (remittance.receivedAt) return { success: false, error: "This remittance has already been acknowledged" };
  if (remittance.status !== STATUS.submitted) {
    return { success: false, error: "Only a submitted declaration can be acknowledged" };
  }

  const receivingBranchId = params.receivingBranchId ?? remittance.branchId;
  if (receivingBranchId) {
    if (!(await assertBranchAccess(ctx, receivingBranchId, "write"))) {
      return { success: false, error: "You are not authorised to receive cash at this branch" };
    }
  } else if (!(await isBranchlessTenant(ctx))) {
    return { success: false, error: "A receiving branch is required" };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `collector-remittance:${remittance.collectorId}`);

      const declared = money(remittance.remittedAmount);
      const now = new Date();
      const variance = round(declared - received);

      // Conditional update: two simultaneous acknowledgements cannot both win.
      const claimed = await tx.collectorRemittance.updateMany({
        where: {
          id: remittance.id,
          tenantId: ctx.tenantId,
          status: STATUS.submitted,
          receivedAt: null,
          reversedAt: null,
        },
        data: {
          receivedAmount: received,
          receivedAt: now,
          receivedById: ctx.userId,
          receiptNote: params.note?.trim() || null,
          receiptEvidenceRef: params.evidenceRef?.trim() || null,
          method: params.method || remittance.method,
          handoverAmount: declared,
          handoverAt: now,
          receiverId: ctx.userId,
          receivingBranchId: receivingBranchId ?? null,
          custodyConfirmedAt: now,
          custodyConfirmedById: ctx.userId,
          status: STATUS.received,
          reconciliationStatus: "pending",
          outstandingAmount: Math.max(0, round(money(remittance.expectedAmount) - received)),
        },
      });
      if (claimed.count !== 1) throw new Error("ALREADY_ACKNOWLEDGED");

      if (variance > 0.0001) {
        await tx.remittanceDiscrepancy.create({
          data: {
            tenantId: ctx.tenantId,
            remittanceId: remittance.id,
            type: "receipt_shortfall",
            expectedAmount: declared,
            declaredAmount: declared,
            receivedAmount: received,
            variance,
            reason: "Cash received is less than the amount declared",
            status: "open",
          },
        });
      } else if (variance < -0.0001) {
        await tx.remittanceDiscrepancy.create({
          data: {
            tenantId: ctx.tenantId,
            remittanceId: remittance.id,
            type: "receipt_overage",
            expectedAmount: declared,
            declaredAmount: declared,
            receivedAmount: received,
            variance,
            reason: "Cash received is more than the amount declared",
            status: "open",
          },
        });
      }

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: receivingBranchId ?? null,
        action: "susu.remittance_received",
        entityType: "remittance",
        entityId: remittance.id,
        details: { declaredAmount: declared, receivedAmount: received, variance },
      });

      return tx.collectorRemittance.findUnique({ where: { id: remittance.id } });
    });

    revalidatePath("/susu/admin/remittances");
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_ACKNOWLEDGED") {
      return { success: false, error: "This remittance has already been acknowledged" };
    }
    return { success: false, error: "Receipt acknowledgement failed" };
  }
}

export async function verifyRemittance(params: {
  remittanceId: string;
  verifiedAmount: number;
  approve?: boolean;
  note?: string;
  evidenceRef?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const remittance = await db.collectorRemittance.findFirst({
    where: { id: params.remittanceId, tenantId: ctx.tenantId },
  });
  if (!remittance) return { success: false, error: "Remittance not found" };
  if (remittance.reversedAt) return { success: false, error: "Remittance is reversed" };
  if (remittance.verifiedAt) return { success: false, error: "This remittance has already been verified" };
  if (!remittance.receivedAt || !remittance.custodyConfirmedAt) {
    return { success: false, error: "Custody of the cash must be confirmed before finance verification" };
  }
  if (remittance.status !== STATUS.received) {
    return { success: false, error: "Only a remittance in custody can be verified" };
  }

  const authority = await financeAuthority(ctx, remittance.receivingBranchId ?? remittance.branchId);
  if (!authority) return { success: false, error: "You are not an authorised finance verifier for this branch" };

  // Separation of duties: the person who declared or received the cash cannot
  // be the person who independently verifies it.
  if (remittance.declaredById === ctx.userId || remittance.receivedById === ctx.userId || remittance.receiverId === ctx.userId) {
    return { success: false, error: "Separation of duties: you cannot verify a remittance you declared or received" };
  }

  const approve = params.approve !== false;
  const amount = validateRemittanceAmount(params.verifiedAmount);
  if (!amount.ok) return { success: false, error: amount.error };
  const verified = amount.value;

  try {
    const result = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `collector-remittance:${remittance.collectorId}`);

      const received = money(remittance.receivedAmount ?? 0);
      const declared = money(remittance.remittedAmount);
      const mismatch = Math.abs(verified - received) > 0.0001 || Math.abs(verified - declared) > 0.0001;
      const now = new Date();
      const nextStatus = !approve ? STATUS.returned : mismatch ? STATUS.disputed : STATUS.verified;

      const claimed = await tx.collectorRemittance.updateMany({
        where: { id: remittance.id, tenantId: ctx.tenantId, status: STATUS.received, verifiedAt: null },
        data: {
          verifiedAmount: approvedAmountForStore(approve, verified),
          verifiedAt: now,
          verifiedById: ctx.userId,
          verificationNote: params.note?.trim() || null,
          verificationEvidenceRef: params.evidenceRef?.trim() || null,
          status: nextStatus,
          reconciliationStatus: !approve ? "disputed" : mismatch ? "disputed" : "reconciled",
          disputedAmount: mismatch ? round(Math.abs(declared - verified)) : 0,
        },
      });
      if (claimed.count !== 1) throw new Error("ALREADY_VERIFIED");

      if (!approve) {
        await tx.remittanceDiscrepancy.create({
          data: {
            tenantId: ctx.tenantId,
            remittanceId: remittance.id,
            type: "verification_returned",
            expectedAmount: declared,
            declaredAmount: declared,
            receivedAmount: received,
            verifiedAmount: verified,
            variance: round(declared - verified),
            reason: params.note?.trim() || "Returned by finance for correction",
            status: "open",
          },
        });
      } else if (mismatch) {
        await tx.remittanceDiscrepancy.create({
          data: {
            tenantId: ctx.tenantId,
            remittanceId: remittance.id,
            type: "verification_variance",
            expectedAmount: declared,
            declaredAmount: declared,
            receivedAmount: received,
            verifiedAmount: verified,
            variance: round(declared - verified),
            reason: params.note?.trim() || "Verified amount differs from the cash received",
            status: "open",
          },
        });
      }

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: remittance.receivingBranchId ?? remittance.branchId,
        action: approve ? "susu.remittance_verified" : "susu.remittance_verification_returned",
        entityType: "remittance",
        entityId: remittance.id,
        details: { verifiedAmount: verified, receivedAmount: received, declaredAmount: declared, mismatch, authority },
      });

      return tx.collectorRemittance.findUnique({ where: { id: remittance.id } });
    });

    revalidatePath("/susu/admin/remittances");
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_VERIFIED") {
      return { success: false, error: "This remittance has already been verified" };
    }
    return { success: false, error: "Remittance verification failed" };
  }
}

/** A returned declaration keeps its verified figure for audit but is not a
 * settlement, so the field is only written when finance approved it. */
function approvedAmountForStore(approve: boolean, verified: number): number | null {
  return approve ? verified : null;
}

export async function resolveRemittanceDiscrepancy(params: {
  discrepancyId: string;
  resolutionNotes: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const notes = params.resolutionNotes?.trim();
  if (!notes || notes.length < 5) {
    return { success: false, error: "A resolution explanation is required" };
  }

  const discrepancy = await db.remittanceDiscrepancy.findFirst({
    where: { id: params.discrepancyId, tenantId: ctx.tenantId },
    include: { remittance: true },
  });
  if (!discrepancy) return { success: false, error: "Discrepancy not found" };
  if (discrepancy.status !== "open") return { success: false, error: "This discrepancy is already resolved" };

  const authority = await financeAuthority(
    ctx,
    discrepancy.remittance.receivingBranchId ?? discrepancy.remittance.branchId
  );
  if (!authority) return { success: false, error: "You are not an authorised finance verifier for this branch" };

  try {
    const result = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `collector-remittance:${discrepancy.remittance.collectorId}`);

      const claimed = await tx.remittanceDiscrepancy.updateMany({
        where: { id: discrepancy.id, tenantId: ctx.tenantId, status: "open" },
        data: {
          status: "resolved",
          resolutionActorId: ctx.userId,
          resolutionAt: new Date(),
          resolutionNotes: notes,
        },
      });
      if (claimed.count !== 1) throw new Error("ALREADY_RESOLVED");

      const open = await tx.remittanceDiscrepancy.count({
        where: { remittanceId: discrepancy.remittanceId, status: "open" },
      });
      await tx.collectorRemittance.updateMany({
        where: { id: discrepancy.remittanceId, tenantId: ctx.tenantId },
        data: { reconciliationStatus: open === 0 ? "reconciled" : "disputed" },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: discrepancy.remittance.receivingBranchId ?? discrepancy.remittance.branchId,
        action: "susu.remittance_discrepancy_resolved",
        entityType: "remittance",
        entityId: discrepancy.remittanceId,
        details: { discrepancyId: discrepancy.id, type: discrepancy.type, notes, openAfter: open },
      });

      return tx.remittanceDiscrepancy.findUnique({ where: { id: discrepancy.id } });
    });

    revalidatePath("/susu/admin/remittances");
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_RESOLVED") {
      return { success: false, error: "This discrepancy is already resolved" };
    }
    return { success: false, error: "Discrepancy resolution failed" };
  }
}

export async function reverseRemittanceDeclaration(params: {
  remittanceId: string;
  reason: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const reason = params.reason?.trim();
  if (!reason || reason.length < 5) return { success: false, error: "A reversal reason is required" };

  const remittance = await db.collectorRemittance.findFirst({
    where: { id: params.remittanceId, tenantId: ctx.tenantId },
  });
  if (!remittance) return { success: false, error: "Remittance not found" };
  if (remittance.reversedAt) return { success: false, error: "This remittance is already reversed" };

  const authority = await financeAuthority(ctx, remittance.receivingBranchId ?? remittance.branchId);
  if (!authority) return { success: false, error: "You are not authorised to reverse this remittance" };
  if (remittance.verifiedAt && !(await requireCompanyWideAdmin(ctx))) {
    return { success: false, error: "Only a company-wide administrator can reverse a verified remittance" };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `collector-remittance:${remittance.collectorId}`);

      // Links are deliberately NOT deleted: they are the evidence that this
      // money was matched to those contributions and they are excluded from
      // settlement by the reversed status, not by erasure.
      const claimed = await tx.collectorRemittance.updateMany({
        where: { id: remittance.id, tenantId: ctx.tenantId, reversedAt: null },
        data: {
          status: STATUS.reversed,
          reversedAt: new Date(),
          reversedById: ctx.userId,
          reversalReason: reason,
          reconciliationStatus: "closed",
        },
      });
      if (claimed.count !== 1) throw new Error("ALREADY_REVERSED");

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: remittance.receivingBranchId ?? remittance.branchId,
        action: "susu.remittance_declaration_reversed",
        entityType: "remittance",
        entityId: remittance.id,
        details: { reason, declaredAmount: Number(remittance.remittedAmount), authority },
      });

      return tx.collectorRemittance.findUnique({ where: { id: remittance.id } });
    });

    revalidatePath("/susu/admin/remittances");
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_REVERSED") {
      return { success: false, error: "This remittance is already reversed" };
    }
    return { success: false, error: "Remittance reversal failed" };
  }
}