"use server";

import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getAdminSession, getMomoSession } from "@/lib/auth";
import {
  enforcePaidOperations,
  getTenantContext,
  requireTenantContext,
  requireTenantAdminMomo,
  type TenantContext,
} from "@/lib/tenant";
import { claimStepUpGrant, stepUpSessionBinding, StepUpDeniedError } from "@/lib/security/step-up";
import { createAuditLogTx } from "@/lib/audit";
import { createNotification } from "@/lib/notifications/notifications";
import {
  BRANCH_ASSET_TYPES,
  branchBalanceSchema,
  branchTransferSchema,
  canTransition,
  computeVariance,
  describeTransferVariance,
  generateTransferReference,
  isBranchAssetType,
  networkForAsset,
  minorToCedi,
  planPartialSettlement,
  requiresStepUpForApproval,
  TRANSFER_STATUS_LABELS,
  type BranchAssetType,
  type BranchTransferStatus,
} from "@/lib/branch-transfers";
import {
  loadBranchPositionBoard,
  loadLocationPositions,
  positionFor,
  type BranchPositionBoard,
} from "@/lib/branch-transfers-service";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export interface TransferActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

const DENIED = "You do not have access to this record.";

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function serializationConflict(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: string }).code
      : undefined;
  const message = error instanceof Error ? error.message : "";
  return (
    code === "P2034" ||
    code === "P2028" ||
    code === "P1008" ||
    /database is locked|SQLITE_BUSY|timed out|transaction already closed/i.test(message)
  );
}

/**
 * Balance reservations are read-then-write. PostgreSQL must run them at
 * Serializable isolation, and a serialization failure is safe to retry because
 * the whole reservation rolled back.
 */
async function withSerializableRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt < 2 && serializationConflict(error)) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

function evidenceText(value: string | undefined): string | null {
  return value?.trim() || null;
}

async function requireTransferActor(): Promise<TenantContext> {
  const ctx =
    (await getTenantContext("momo", "momo")) ??
    (await getTenantContext("admin", "momo"));
  if (!ctx) return requireTenantContext("momo", "momo");
  if (!ctx.modules.includes("momo")) redirect("/unauthorized");
  await enforcePaidOperations(ctx.tenantId, "/unauthorized?reason=payment_required");
  return ctx;
}

async function actorName(tenantId: string, userId: string): Promise<string | null> {
  const user = await db.user.findFirst({
    where: { id: userId, tenantId },
    select: { fullName: true },
  });
  return user?.fullName ?? null;
}

async function actorSession(): Promise<{ jti?: string | null; iat?: number } | null> {
  return (await getMomoSession()) ?? (await getAdminSession());
}

async function appendEvent(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    transferId: string;
    action: string;
    actorId: string;
    note?: string | null;
  }
) {
  await tx.branchTransferEvent.create({
    data: {
      tenantId: input.tenantId,
      transferId: input.transferId,
      action: input.action,
      actorId: input.actorId,
      actorName: await actorName(input.tenantId, input.actorId),
      note: input.note ?? null,
    },
  });
}

function revalidateTransfers() {
  revalidatePath("/admin/transfers");
  revalidatePath("/worker/transfers");
  revalidatePath("/admin/dashboard");
}

// ---------------------------------------------------------------------------
// Declared balances
// ---------------------------------------------------------------------------

export async function declareBranchBalance(input: {
  locationId: string;
  assetType: string;
  declaredBalance: number;
  note?: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTenantAdminMomo();

  const parsed = branchBalanceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;
  if (!isBranchAssetType(values.assetType)) {
    return { success: false, error: "Choose a valid asset." };
  }

  const location = await db.location.findFirst({
    where: { id: values.locationId, tenantId: ctx.tenantId },
    select: { id: true, status: true },
  });
  if (!location) return { success: false, error: DENIED };
  if (location.status !== "active") {
    return { success: false, error: "This location is not active." };
  }

  const now = new Date();
  try {
    await db.$transaction(async (tx) => {
      const balance = await tx.branchAssetBalance.upsert({
        where: {
          tenantId_locationId_assetType: {
            tenantId: ctx.tenantId,
            locationId: values.locationId,
            assetType: values.assetType,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          locationId: values.locationId,
          assetType: values.assetType,
          declaredBalance: values.declaredBalance,
          declaredAt: now,
          declaredById: ctx.userId,
          note: values.note?.trim() || null,
        },
        update: {
          declaredBalance: values.declaredBalance,
          declaredAt: now,
          declaredById: ctx.userId,
          note: values.note?.trim() || null,
        },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_balance.declared",
        entityType: "branchAssetBalance",
        entityId: balance.id,
        details: {
          locationId: values.locationId,
          assetType: values.assetType,
          declaredBalance: values.declaredBalance,
          source: "manual_declaration",
        },
      });
    });
  } catch {
    return { success: false, error: "The balance declaration could not be saved." };
  }

  revalidateTransfers();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Transfer creation and lifecycle
// ---------------------------------------------------------------------------

export async function createBranchTransfer(
  input: {
    sourceLocationId: string;
    destinationLocationId: string;
    assetType: string;
    amount: number;
    purpose?: string;
    notes?: string;
    idempotencyKey: string;
  },
  options: { asDraft?: boolean } = {}
): Promise<TransferActionResponse> {
  const ctx = await requireTransferActor();
  const parsed = branchTransferSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;

  if (ctx.role !== "admin") {
    const user = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true },
    });
    if (!user?.locationId || user.locationId !== values.sourceLocationId) {
      return {
        success: false,
        error: "You can only request a transfer from your assigned location.",
      };
    }
  }

  const locations = await db.location.findMany({
    where: {
      id: { in: [values.sourceLocationId, values.destinationLocationId] },
      tenantId: ctx.tenantId,
    },
    select: { id: true, status: true },
  });
  if (locations.length !== 2) return { success: false, error: DENIED };
  if (locations.some((location) => location.status !== "active")) {
    return { success: false, error: "Both locations must be active." };
  }

  const existing = await db.branchTransfer.findFirst({
    where: { tenantId: ctx.tenantId, idempotencyKey: values.idempotencyKey },
    select: { id: true, status: true },
  });
  if (existing) {
    return { success: true, data: { transferId: existing.id, duplicate: true } };
  }

  const status: BranchTransferStatus = options.asDraft ? "draft" : "requested";
  const now = new Date();

  try {
    const created = await withSerializableRetry(() =>
      db.$transaction(
        async (tx) => {
      // Availability is computed inside the transaction. PostgreSQL runs this
      // at Serializable isolation, and the post-insert recheck below also
      // catches a concurrent request that slipped in on SQLite.
      const position = await positionFor(
        tx,
        ctx.tenantId,
        values.sourceLocationId,
        values.assetType as BranchAssetType
      );
      if (position.declared === null) {
        throw new Error("NO_DECLARED_BALANCE");
      }
      if (values.amount > (position.effective ?? 0)) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const row = await tx.branchTransfer.create({
        data: {
          tenantId: ctx.tenantId,
          reference: generateTransferReference(now, randomBytes(3).toString("hex").toUpperCase()),
          assetType: values.assetType,
          network: networkForAsset(values.assetType as BranchAssetType),
          sourceLocationId: values.sourceLocationId,
          destinationLocationId: values.destinationLocationId,
          amount: values.amount,
          status,
          purpose: values.purpose?.trim() || null,
          notes: values.notes?.trim() || null,
          initiatedById: ctx.userId,
          requestedAt: status === "requested" ? now : null,
          idempotencyKey: values.idempotencyKey,
        },
      });

      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: row.id,
        action: status === "requested" ? "requested" : "draft_created",
        actorId: ctx.userId,
        note: values.purpose?.trim() || null,
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.created",
        entityType: "branchTransfer",
        entityId: row.id,
        details: {
          reference: row.reference,
          assetType: values.assetType,
          amount: values.amount,
          sourceLocationId: values.sourceLocationId,
          destinationLocationId: values.destinationLocationId,
          status,
        },
      });

      if (status === "requested") {
        const after = await positionFor(
          tx,
          ctx.tenantId,
          values.sourceLocationId,
          values.assetType as BranchAssetType
        );
        if (after.effective !== null && after.effective < 0) {
          throw new Error("INSUFFICIENT_BALANCE");
        }
      }
      return row;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
    );

    revalidateTransfers();
    return {
      success: true,
      data: { transferId: created.id, reference: created.reference, status: created.status },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "NO_DECLARED_BALANCE") {
      return {
        success: false,
        error:
          "Declare the sending location's balance for this asset before requesting a transfer.",
      };
    }
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      return {
        success: false,
        error:
          "The declared balance is not enough for this transfer after open transfers are reserved.",
      };
    }
    if (uniqueViolation(error)) {
      const replay = await db.branchTransfer.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey: values.idempotencyKey },
        select: { id: true, reference: true, status: true },
      });
      if (replay) {
        return {
          success: true,
          data: { transferId: replay.id, reference: replay.reference, status: replay.status, duplicate: true },
        };
      }
      return { success: false, error: "That transfer submission was already used." };
    }
    return { success: false, error: "The transfer could not be created." };
  }
}

export async function requestBranchTransfer(id: string): Promise<TransferActionResponse> {
  const ctx = await requireTransferActor();
  const transfer = await db.branchTransfer.findFirst({
    where: { id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (ctx.role !== "admin" && transfer.initiatedById !== ctx.userId) {
    return { success: false, error: DENIED };
  }
  if (transfer.status !== "draft") {
    return { success: false, error: "Only a draft transfer can be submitted." };
  }

  try {
    await withSerializableRetry(() =>
      db.$transaction(
        async (tx) => {
      const position = await positionFor(
        tx,
        ctx.tenantId,
        transfer.sourceLocationId,
        transfer.assetType as BranchAssetType
      );
      if (position.declared === null) throw new Error("NO_DECLARED_BALANCE");
      if (money(transfer.amount) > (position.effective ?? 0)) {
        throw new Error("INSUFFICIENT_BALANCE");
      }
      const updated = await tx.branchTransfer.updateMany({
        where: { id, tenantId: ctx.tenantId, status: "draft" },
        data: { status: "requested", requestedAt: new Date() },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: id,
        action: "requested",
        actorId: ctx.userId,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.requested",
        entityType: "branchTransfer",
        entityId: id,
        details: { reference: transfer.reference, amount: money(transfer.amount) },
      });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NO_DECLARED_BALANCE") {
      return { success: false, error: "Declare the sending location's balance first." };
    }
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      return { success: false, error: "The available declared balance is too low." };
    }
    return { success: false, error: "The transfer could not be requested." };
  }

  revalidateTransfers();
  return { success: true };
}

async function claimTransferStepUp(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  token: string | undefined,
  purpose: "finance.branch_transfer.approve" | "finance.branch_transfer.resolve",
  transferId: string,
  amountMinor: number
) {
  const session = await actorSession();
  const grant = await claimStepUpGrant(tx, {
    token,
    subjectType: "user",
    subjectId: ctx.userId,
    sessionId: stepUpSessionBinding(session, ctx.userId),
    purpose,
    targetType: "branchTransfer",
    targetId: transferId,
    context: { amountMinor },
  });
  if (!grant.ok) throw new StepUpDeniedError(grant.error);
}

export async function approveBranchTransfer(input: {
  id: string;
  stepUpToken?: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const transfer = await db.branchTransfer.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (transfer.status !== "requested") {
    return { success: false, error: "Only a requested transfer can be approved." };
  }
  // Separation of duties: the person who asked for the money cannot also
  // release it, even when they administer both locations.
  if (transfer.initiatedById === ctx.userId) {
    return {
      success: false,
      error:
        "A transfer must be approved by a different administrator from the person who requested it.",
    };
  }

  const amountMinor = Math.round(money(transfer.amount) * 100);
  try {
    await db.$transaction(async (tx) => {
      if (requiresStepUpForApproval(amountMinor)) {
        await claimTransferStepUp(
          tx,
          ctx,
          input.stepUpToken,
          "finance.branch_transfer.approve",
          transfer.id,
          amountMinor
        );
      }
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: "requested" },
        data: {
          status: "approved",
          approvedById: ctx.userId,
          approvedAt: new Date(),
        },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: "approved",
        actorId: ctx.userId,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.approved",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: {
          reference: transfer.reference,
          amount: money(transfer.amount),
          approverDifferentFromInitiator: true,
          stepUpRequired: requiresStepUpForApproval(amountMinor),
        },
      });
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "The transfer could not be approved." };
  }

  revalidateTransfers();
  return { success: true };
}

export async function rejectBranchTransfer(input: {
  id: string;
  reason: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 5 || reason.length > 500) {
    return { success: false, error: "Enter a rejection reason of at least 5 characters." };
  }
  const transfer = await db.branchTransfer.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (transfer.initiatedById === ctx.userId) {
    return {
      success: false,
      error: "The person who requested a transfer cannot also reject it.",
    };
  }
  if (!canTransition(transfer.status as BranchTransferStatus, "rejected")) {
    return { success: false, error: "This transfer cannot be rejected in its current state." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: transfer.status },
        data: {
          status: "rejected",
          rejectedById: ctx.userId,
          rejectedAt: new Date(),
          rejectionReason: reason,
        },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: "rejected",
        actorId: ctx.userId,
        note: reason,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.rejected",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: { reference: transfer.reference, reason },
      });
    });
  } catch {
    return { success: false, error: "The transfer could not be rejected." };
  }

  revalidateTransfers();
  return { success: true };
}

export async function dispatchBranchTransfer(
  id: string,
  evidence?: string
): Promise<TransferActionResponse> {
  const ctx = await requireTransferActor();
  const dispatchEvidence = evidenceText(evidence);
  if (dispatchEvidence && dispatchEvidence.length > 300) {
    return { success: false, error: "Dispatch evidence must be 300 characters or fewer." };
  }
  const transfer = await db.branchTransfer.findFirst({
    where: { id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (ctx.role !== "admin") {
    const user = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true },
    });
    if (!user?.locationId || user.locationId !== transfer.sourceLocationId) {
      return {
        success: false,
        error: "Only an employee at the sending location can confirm dispatch.",
      };
    }
  }
  if (transfer.status !== "approved") {
    return { success: false, error: "Only an approved transfer can be dispatched." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: "approved" },
        data: {
          status: "dispatched",
          dispatchedById: ctx.userId,
          dispatchedAt: new Date(),
          dispatchEvidence,
        },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: "dispatched",
        actorId: ctx.userId,
        note: dispatchEvidence ? `Dispatch evidence: ${dispatchEvidence}` : null,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.dispatched",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: {
          reference: transfer.reference,
          amount: money(transfer.amount),
          evidence: dispatchEvidence,
        },
      });
    });
  } catch {
    return { success: false, error: "The transfer could not be dispatched." };
  }

  revalidateTransfers();
  return { success: true };
}

export async function receiveBranchTransfer(input: {
  id: string;
  actualAmountReceived: number;
  note?: string;
  evidence?: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTransferActor();
  const receiptEvidence = evidenceText(input.evidence);
  if (receiptEvidence && receiptEvidence.length > 300) {
    return { success: false, error: "Receipt evidence must be 300 characters or fewer." };
  }
  const transfer = await db.branchTransfer.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (ctx.role !== "admin") {
    const user = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true },
    });
    if (!user?.locationId || user.locationId !== transfer.destinationLocationId) {
      return {
        success: false,
        error: "Only an employee at the receiving location can confirm receipt.",
      };
    }
  }
  if (transfer.status !== "dispatched" && transfer.status !== "received") {
    return { success: false, error: "Only a dispatched transfer can be received." };
  }

  const actual = Number(input.actualAmountReceived);
  if (!Number.isFinite(actual) || actual < 0 || actual > 999_999_999.99) {
    return { success: false, error: "Enter a valid amount received." };
  }
  if (Math.round((actual + Number.EPSILON) * 100) / 100 !== actual) {
    return { success: false, error: "Use no more than two decimal places." };
  }
  const note = input.note?.trim() || null;
  const variance = computeVariance(transfer.amount, actual);
  if (variance !== 0 && (!note || note.length < 5)) {
    return {
      success: false,
      error: "Explain the difference between the dispatched and received amount.",
    };
  }

  if (transfer.status === "received") {
    return {
      success: false,
      error: "Receipt has already been confirmed for this transfer.",
    };
  }

  const nextStatus: BranchTransferStatus =
    variance === 0 ? "received" : "variance_investigation";

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: "dispatched" },
        data: {
          status: nextStatus,
          receivedById: ctx.userId,
          receivedAt: new Date(),
          actualAmountReceived: actual,
          receiptEvidence,
          variance,
          varianceReason: variance === 0 ? null : note,
        },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: variance === 0 ? "received" : "variance_recorded",
        actorId: ctx.userId,
        note:
          variance === 0
            ? note
            : `${describeTransferVariance(variance)}: ${note ?? "no reason supplied"}`,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action:
          variance === 0
            ? "branch_transfer.received"
            : "branch_transfer.variance_recorded",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: {
          reference: transfer.reference,
          dispatchedAmount: money(transfer.amount),
          actualAmountReceived: actual,
          variance,
          reason: note,
          evidence: receiptEvidence,
        },
      });
    });
  } catch {
    return { success: false, error: "The receipt could not be recorded." };
  }

  if (variance !== 0) {
    await createNotification({
      tenantId: ctx.tenantId,
      audience: "tenant",
      kind: "system",
      severity: "attention",
      title: `Transfer variance on ${transfer.reference}`,
      body: `Dispatched GH₵${money(transfer.amount).toFixed(2)} but received GH₵${actual.toFixed(
        2
      )} (${describeTransferVariance(variance).toLowerCase()}). A supervisor must investigate.`,
      href: "/admin/transfers",
      dedupeKey: `branch_transfer_variance:${transfer.id}`,
    }).catch(() => null);
  }

  revalidateTransfers();
  return { success: true, data: { variance, status: nextStatus } };
}

export async function completeBranchTransfer(id: string): Promise<TransferActionResponse> {
  const ctx = await requireTransferActor();
  const transfer = await db.branchTransfer.findFirst({
    where: { id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (transfer.status !== "received") {
    return { success: false, error: "Only a received transfer can be completed." };
  }
  if (transfer.variance !== null && money(transfer.variance) !== 0) {
    return {
      success: false,
      error: "A transfer with a variance must be resolved by an administrator.",
    };
  }
  if (ctx.role !== "admin") {
    const user = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true },
    });
    if (user?.locationId !== transfer.destinationLocationId) {
      return { success: false, error: "Only the receiving location can complete it." };
    }
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: "received" },
        data: { status: "completed", resolvedAt: new Date(), resolvedById: ctx.userId },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: "completed",
        actorId: ctx.userId,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.completed",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: { reference: transfer.reference },
      });
    });
  } catch {
    return { success: false, error: "The transfer could not be completed." };
  }

  revalidateTransfers();
  return { success: true };
}

export async function cancelBranchTransfer(input: {
  id: string;
  reason: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTransferActor();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 5 || reason.length > 500) {
    return { success: false, error: "Enter a cancellation reason of at least 5 characters." };
  }
  const transfer = await db.branchTransfer.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (ctx.role !== "admin" && transfer.initiatedById !== ctx.userId) {
    return { success: false, error: DENIED };
  }
  if (!canTransition(transfer.status as BranchTransferStatus, "cancelled")) {
    return { success: false, error: "This transfer can no longer be cancelled." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: transfer.status },
        data: {
          status: "cancelled",
          cancelledById: ctx.userId,
          cancelledAt: new Date(),
          cancellationReason: reason,
        },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: "cancelled",
        actorId: ctx.userId,
        note: reason,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.cancelled",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: { reference: transfer.reference, reason },
      });
    });
  } catch {
    return { success: false, error: "The transfer could not be cancelled." };
  }
  revalidateTransfers();
  return { success: true };
}

export async function disputeBranchTransfer(input: {
  id: string;
  reason: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTransferActor();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 5 || reason.length > 500) {
    return { success: false, error: "Explain the dispute in at least 5 characters." };
  }
  const transfer = await db.branchTransfer.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (!canTransition(transfer.status as BranchTransferStatus, "disputed")) {
    return { success: false, error: "This transfer cannot be disputed in its current state." };
  }
  if (ctx.role !== "admin") {
    const user = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true },
    });
    if (
      user?.locationId !== transfer.destinationLocationId &&
      user?.locationId !== transfer.sourceLocationId
    ) {
      return { success: false, error: DENIED };
    }
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: transfer.status },
        data: { status: "disputed", varianceReason: reason },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: "disputed",
        actorId: ctx.userId,
        note: reason,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.disputed",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: { reference: transfer.reference, reason },
      });
    });
  } catch {
    return { success: false, error: "The dispute could not be recorded." };
  }

  await createNotification({
    tenantId: ctx.tenantId,
    audience: "tenant",
    kind: "system",
    severity: "attention",
    title: `Transfer disputed: ${transfer.reference}`,
    body: reason.slice(0, 500),
    href: "/admin/transfers",
    dedupeKey: `branch_transfer_dispute:${transfer.id}`,
  }).catch(() => null);

  revalidateTransfers();
  return { success: true };
}

export async function resolveBranchTransfer(input: {
  id: string;
  resolution: "completed" | "disputed";
  note: string;
  stepUpToken?: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const note = input.note?.trim() ?? "";
  if (note.length < 10 || note.length > 500) {
    return {
      success: false,
      error: "Record an investigation conclusion of at least 10 characters.",
    };
  }
  if (input.resolution !== "completed" && input.resolution !== "disputed") {
    return { success: false, error: "Choose a valid resolution." };
  }
  const transfer = await db.branchTransfer.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (!canTransition(transfer.status as BranchTransferStatus, input.resolution)) {
    return {
      success: false,
      error: "This transfer is not awaiting an investigation decision.",
    };
  }

  const amountMinor = Math.round(money(transfer.amount) * 100);
  try {
    await db.$transaction(async (tx) => {
      await claimTransferStepUp(
        tx,
        ctx,
        input.stepUpToken,
        "finance.branch_transfer.resolve",
        transfer.id,
        amountMinor
      );
      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: transfer.status },
        data: {
          status: input.resolution,
          resolvedById: ctx.userId,
          resolvedAt: new Date(),
          resolutionNote: note,
        },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action: input.resolution === "completed" ? "resolved_completed" : "resolved_disputed",
        actorId: ctx.userId,
        note,
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.resolved",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: {
          reference: transfer.reference,
          resolution: input.resolution,
          variance: money(transfer.variance ?? 0),
          note,
        },
      });
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "The resolution could not be recorded." };
  }

  revalidateTransfers();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Partial settlement
// ---------------------------------------------------------------------------

/**
 * Settle a short receipt.
 *
 * A dispatcher sends GH₵1,000, the destination counts GH₵900. The correct
 * treatment is not a silent reduction: the original transfer keeps its
 * dispatched amount, GH₵900 is recorded as the accepted value, and the remaining
 * GH₵100 is either carried into a follow-up transfer or explicitly written back
 * with a reason. Only an administrator may settle, and a high-value settlement
 * requires a fresh step-up grant.
 */
export async function settlePartialTransfer(input: {
  id: string;
  settledAmount: number;
  resolution: "follow_up_transfer" | "write_back";
  note: string;
  stepUpToken?: string;
}): Promise<TransferActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const note = input.note?.trim() ?? "";
  if (note.length < 10 || note.length > 500) {
    return { success: false, error: "Record a settlement reason of at least 10 characters." };
  }
  if (input.resolution !== "follow_up_transfer" && input.resolution !== "write_back") {
    return { success: false, error: "Choose how the outstanding balance is settled." };
  }

  const transfer = await db.branchTransfer.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!transfer) return { success: false, error: DENIED };
  if (transfer.status !== "variance_investigation" && transfer.status !== "disputed") {
    return {
      success: false,
      error: "Only a transfer under variance investigation can be partially settled.",
    };
  }
  if (
    transfer.settlementStatus === "partial_settled" ||
    transfer.settlementStatus === "written_back"
  ) {
    return { success: false, error: "This transfer has already been settled." };
  }

  const dispatchedMinor = Math.round(money(transfer.amount) * 100);
  const receivedValue =
    input.settledAmount === undefined || input.settledAmount === null
      ? money(transfer.actualAmountReceived ?? 0)
      : input.settledAmount;
  if (!Number.isFinite(receivedValue) || receivedValue < 0) {
    return { success: false, error: "Enter a valid accepted amount." };
  }
  const receivedMinor = Math.round(receivedValue * 100);
  if (Math.abs(receivedMinor / 100 - receivedValue) > 1e-9) {
    return { success: false, error: "Use no more than two decimal places." };
  }
  if (receivedMinor >= dispatchedMinor) {
    return {
      success: false,
      error: "A partial settlement must be below the dispatched amount. Resolve a full receipt instead.",
    };
  }

  const plan = planPartialSettlement({ dispatchedMinor, receivedMinor });
  const now = new Date();

  try {
    const result = await db.$transaction(async (tx) => {
      // A high-value settlement moves material value out of the original
      // transfer, so it needs the same fresh proof as a high-value approval.
      if (requiresStepUpForApproval(dispatchedMinor)) {
        await claimTransferStepUp(
          tx,
          ctx,
          input.stepUpToken,
          "finance.branch_transfer.resolve",
          transfer.id,
          dispatchedMinor
        );
      }

      let followUpId: string | null = null;
      if (input.resolution === "follow_up_transfer" && plan.outstandingMinor > 0) {
        // The follow-up is a NEW transfer for the remainder. It inherits the same
        // asset and route and starts as a draft, so it must still be requested,
        // approved and dispatched through the normal controls.
        const reference = generateTransferReference(
          now,
          randomBytes(4).toString("hex").toUpperCase()
        );
        const created = await tx.branchTransfer.create({
          data: {
            tenantId: ctx.tenantId,
            reference,
            assetType: transfer.assetType,
            network: transfer.network,
            sourceLocationId: transfer.sourceLocationId,
            destinationLocationId: transfer.destinationLocationId,
            amount: minorToCedi(plan.outstandingMinor),
            status: "draft",
            purpose: `Outstanding balance of ${transfer.reference}`,
            notes: note,
            initiatedById: ctx.userId,
            idempotencyKey: `followup:${transfer.id}`,
            parentTransferId: transfer.id,
          },
          select: { id: true, reference: true },
        });
        followUpId = created.id;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          transferId: created.id,
          action: "created_follow_up",
          actorId: ctx.userId,
          note: `Settles the outstanding balance of ${transfer.reference}`,
        });
      }

      const updated = await tx.branchTransfer.updateMany({
        where: { id: transfer.id, tenantId: ctx.tenantId, status: transfer.status },
        data: {
          status: input.resolution === "follow_up_transfer" ? "received" : "completed",
          actualAmountReceived: minorToCedi(receivedMinor),
          variance: minorToCedi(plan.varianceMinor),
          settlementStatus:
            input.resolution === "follow_up_transfer" ? "partial_settled" : "written_back",
          settledAmount: minorToCedi(plan.settledMinor),
          outstandingAmount: minorToCedi(plan.outstandingMinor),
          followUpTransferId: followUpId,
          settledById: ctx.userId,
          settledAt: now,
          resolvedById: ctx.userId,
          resolvedAt: now,
          resolutionNote: note,
        },
      });
      if (updated.count !== 1) throw new Error("TRANSFER_CONFLICT");

      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        transferId: transfer.id,
        action:
          input.resolution === "follow_up_transfer"
            ? "partial_settlement_follow_up"
            : "partial_settlement_written_back",
        actorId: ctx.userId,
        note: `${minorToCedi(plan.settledMinor).toFixed(2)} accepted, ${minorToCedi(
          plan.outstandingMinor
        ).toFixed(2)} outstanding. ${note}`,
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_transfer.partial_settlement",
        entityType: "branchTransfer",
        entityId: transfer.id,
        details: {
          reference: transfer.reference,
          dispatchedAmount: minorToCedi(dispatchedMinor),
          settledAmount: minorToCedi(plan.settledMinor),
          outstandingAmount: minorToCedi(plan.outstandingMinor),
          resolution: input.resolution,
          followUpTransferId: followUpId,
          note,
        },
      });

      return { followUpId, plan };
    });

    revalidateTransfers();
    return {
      success: true,
      data: {
        settled: minorToCedi(result.plan.settledMinor),
        outstanding: minorToCedi(result.plan.outstandingMinor),
        followUpTransferId: result.followUpId,
      },
    };
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "The partial settlement could not be recorded." };
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface BranchTransferView {
  id: string;
  reference: string;
  assetType: string;
  network: string;
  status: string;
  statusLabel: string;
  amount: number;
  sourceLocationId: string;
  sourceLocationName: string;
  destinationLocationId: string;
  destinationLocationName: string;
  purpose: string | null;
  notes: string | null;
  initiatedById: string;
  initiatedByName: string | null;
  requestedAt: string | null;
  approvedById: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  dispatchedById: string | null;
  dispatchedByName: string | null;
  dispatchedAt: string | null;
  receivedById: string | null;
  receivedByName: string | null;
  receivedAt: string | null;
  actualAmountReceived: number | null;
  dispatchEvidence: string | null;
  receiptEvidence: string | null;
  variance: number | null;
  varianceReason: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  events: Array<{
    id: string;
    action: string;
    actorId: string;
    actorName: string | null;
    note: string | null;
    createdAt: string;
  }>;
}

async function nameMap(tenantId: string, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((user) => [user.id, user.fullName]));
}

function transferView(
  row: {
    id: string;
    reference: string;
    assetType: string;
    network: string;
    status: string;
    amount: unknown;
    sourceLocationId: string;
    destinationLocationId: string;
    purpose: string | null;
    notes: string | null;
    initiatedById: string;
    requestedAt: Date | null;
    approvedById: string | null;
    approvedAt: Date | null;
    dispatchedById: string | null;
    dispatchedAt: Date | null;
    receivedById: string | null;
    receivedAt: Date | null;
    actualAmountReceived: unknown;
    dispatchEvidence: string | null;
    receiptEvidence: string | null;
    variance: unknown;
    varianceReason: string | null;
    rejectionReason: string | null;
    cancellationReason: string | null;
    resolutionNote: string | null;
    resolvedAt: Date | null;
    createdAt: Date;
    source: { name: string };
    destination: { name: string };
    events: Array<{
      id: string;
      action: string;
      actorId: string;
      actorName: string | null;
      note: string | null;
      createdAt: Date;
    }>;
  },
  names: Map<string, string>
): BranchTransferView {
  const label = TRANSFER_STATUS_LABELS[row.status as BranchTransferStatus] ?? row.status;
  return {
    id: row.id,
    reference: row.reference,
    assetType: row.assetType,
    network: row.network,
    status: row.status,
    statusLabel: label,
    amount: money(row.amount),
    sourceLocationId: row.sourceLocationId,
    sourceLocationName: row.source.name,
    destinationLocationId: row.destinationLocationId,
    destinationLocationName: row.destination.name,
    purpose: row.purpose,
    notes: row.notes,
    initiatedById: row.initiatedById,
    initiatedByName: names.get(row.initiatedById) ?? null,
    requestedAt: row.requestedAt?.toISOString() ?? null,
    approvedById: row.approvedById,
    approvedByName: row.approvedById ? names.get(row.approvedById) ?? null : null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    dispatchedById: row.dispatchedById,
    dispatchedByName: row.dispatchedById ? names.get(row.dispatchedById) ?? null : null,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    receivedById: row.receivedById,
    receivedByName: row.receivedById ? names.get(row.receivedById) ?? null : null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    actualAmountReceived:
      row.actualAmountReceived === null ? null : money(row.actualAmountReceived),
    dispatchEvidence: row.dispatchEvidence,
    receiptEvidence: row.receiptEvidence,
    variance: row.variance === null ? null : money(row.variance),
    varianceReason: row.varianceReason,
    rejectionReason: row.rejectionReason,
    cancellationReason: row.cancellationReason,
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    events: row.events.map((event) => ({
      id: event.id,
      action: event.action,
      actorId: event.actorId,
      actorName: event.actorName,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export interface BranchTransferBoardView {
  board: BranchPositionBoard;
  transfers: BranchTransferView[];
  counts: {
    awaitingApproval: number;
    inTransit: number;
    awaitingReceipt: number;
    discrepancies: number;
    open: number;
    completed: number;
  };
  locations: Array<{ id: string; name: string; code: string }>;
}

export async function getBranchTransferBoard(filters?: {
  status?: string;
  assetType?: string;
  locationId?: string;
}): Promise<BranchTransferBoardView> {
  const ctx = await requireTenantAdminMomo();
  const board = await loadBranchPositionBoard(ctx.tenantId);

  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (filters?.status && filters.status !== "all") where.status = filters.status;
  if (filters?.assetType && isBranchAssetType(filters.assetType)) {
    where.assetType = filters.assetType;
  }
  if (filters?.locationId) {
    where.OR = [
      { sourceLocationId: filters.locationId },
      { destinationLocationId: filters.locationId },
    ];
  }

  const rows = await db.branchTransfer.findMany({
    where,
    include: {
      source: { select: { name: true } },
      destination: { select: { name: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const names = await nameMap(ctx.tenantId, [
    ...rows.flatMap((row) => [
      row.initiatedById,
      row.approvedById,
      row.dispatchedById,
      row.receivedById,
    ]),
    ...rows.flatMap((row) => row.events.map((event) => event.actorId)),
  ]);

  const transfers = rows.map((row) => transferView(row, names));
  const counts = {
    awaitingApproval: transfers.filter((row) => row.status === "requested").length,
    inTransit: transfers.filter((row) => row.status === "dispatched").length,
    awaitingReceipt: transfers.filter((row) => row.status === "approved").length,
    discrepancies: transfers.filter(
      (row) => row.status === "variance_investigation" || row.status === "disputed"
    ).length,
    open: transfers.filter((row) =>
      ["requested", "approved", "dispatched", "received"].includes(row.status)
    ).length,
    completed: transfers.filter((row) => row.status === "completed").length,
  };

  return { board, transfers, counts, locations: board.locations.map((location) => ({ id: location.locationId, name: location.locationName, code: location.locationCode })) };
}

export async function getBranchTransferDetail(
  id: string
): Promise<BranchTransferView | null> {
  const ctx = await requireTransferActor();
  const row = await db.branchTransfer.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      source: { select: { name: true } },
      destination: { select: { name: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!row) return null;
  if (ctx.role !== "admin") {
    const user = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true },
    });
    if (
      user?.locationId !== row.sourceLocationId &&
      user?.locationId !== row.destinationLocationId
    ) {
      return null;
    }
  }
  const names = await nameMap(ctx.tenantId, [
    row.initiatedById,
    row.approvedById,
    row.dispatchedById,
    row.receivedById,
    ...row.events.map((event) => event.actorId),
  ]);
  return transferView(row, names);
}

export interface WorkerTransferView {
  locationId: string | null;
  locationName: string | null;
  positions: Awaited<ReturnType<typeof loadLocationPositions>>;
  transfers: BranchTransferView[];
  canInitiate: boolean;
}

export async function getWorkerTransferView(): Promise<WorkerTransferView> {
  const ctx = await requireTransferActor();
  const user = await db.user.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    select: { locationId: true, location: { select: { name: true } } },
  });
  if (!user?.locationId) {
    return { locationId: null, locationName: null, positions: [], transfers: [], canInitiate: false };
  }

  const [positions, rows] = await Promise.all([
    loadLocationPositions(ctx.tenantId, user.locationId),
    db.branchTransfer.findMany({
      where: {
        tenantId: ctx.tenantId,
        OR: [
          { sourceLocationId: user.locationId },
          { destinationLocationId: user.locationId },
        ],
      },
      include: {
        source: { select: { name: true } },
        destination: { select: { name: true } },
        events: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const names = await nameMap(ctx.tenantId, [
    ...rows.flatMap((row) => [
      row.initiatedById,
      row.approvedById,
      row.dispatchedById,
      row.receivedById,
    ]),
    ...rows.flatMap((row) => row.events.map((event) => event.actorId)),
  ]);

  return {
    locationId: user.locationId,
    locationName: user.location?.name ?? null,
    positions,
    transfers: rows.map((row) => transferView(row, names)),
    canInitiate: true,
  };
}

export async function getTransferLocationOptions() {
  const ctx = await requireTransferActor();
  const [locations, balances] = await Promise.all([
    db.location.findMany({
      where: { tenantId: ctx.tenantId, status: "active" },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    db.branchAssetBalance.findMany({
      where: { tenantId: ctx.tenantId },
      select: { locationId: true, assetType: true },
    }),
  ]);
  return {
    locations,
    declared: balances.map((row) => `${row.locationId}:${row.assetType}`),
    assetTypes: BRANCH_ASSET_TYPES,
  };
}

export type { BranchPositionBoard };
