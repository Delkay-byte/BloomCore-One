"use server";

import { db } from "@/lib/db";
import { getAdminSession, getMomoSession } from "@/lib/auth";
import { getTenantContext, enforcePaidOperations, requireTenantContext, type TenantContext } from "@/lib/tenant";
import { claimStepUpGrant, stepUpSessionBinding, StepUpDeniedError } from "@/lib/security/step-up";
import { createAuditLogTx } from "@/lib/audit";
import {
  deriveDirection,
  isMomoNetwork,
  isMomoTransactionType,
  isWithinBusinessDate,
  momoTransactionInputSchema,
  projectLedgerPosition,
  summariseLedger,
  transactionDefinition,
  type LedgerProjection,
  type LedgerSummary,
  type MomoTransactionType,
  type OpeningCarryForward,
} from "@/lib/momo-ledger";
import { resolveOpeningCarryForward } from "@/lib/momo-ledger-service";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";

export interface LedgerActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

const DENIED = "You do not have access to this record.";

/**
 * Resolve the acting staff member from either a MoMo worker tab or an
 * administrator tab. The tenant is always derived from the verified session,
 * never from client input.
 */
async function requireLedgerActor(): Promise<TenantContext> {
  const ctx =
    (await getTenantContext("momo", "momo")) ??
    (await getTenantContext("admin", "momo"));
  if (!ctx) {
    return requireTenantContext("momo", "momo");
  }
  if (!ctx.modules.includes("momo")) redirect("/unauthorized");
  await enforcePaidOperations(ctx.tenantId, "/unauthorized?reason=payment_required");
  return ctx;
}

async function actorSession(): Promise<{ jti?: string | null; iat?: number } | null> {
  return (await getMomoSession()) ?? (await getAdminSession());
}

async function workerLocationId(tenantId: string, userId: string): Promise<string | null> {
  const user = await db.user.findFirst({
    where: { id: userId, tenantId },
    select: { locationId: true },
  });
  return user?.locationId ?? null;
}

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

function revalidateLedger(accountId?: string) {
  revalidatePath("/admin/ledger");
  revalidatePath("/admin/dashboard");
  revalidatePath("/worker/dashboard");
  if (accountId) revalidatePath(`/worker/daily/${accountId}`);
}

export interface LedgerEntryView {
  id: string;
  type: string;
  typeLabel: string;
  network: string;
  networkLabel: string;
  direction: string;
  verificationStatus: string;
  verificationLabel: string;
  recordedDeviceId: string | null;
  recordedDeviceName: string | null;
  supportingEvidence: string | null;
  cashEffect: number;
  floatEffect: number;
  amount: number;
  commissionAmount: number;
  businessDate: string;
  occurredAt: string;
  reference: string;
  externalReference: string | null;
  recordingSource: string;
  status: string;
  reversesTransactionId: string | null;
  correctsTransactionId: string | null;
  correctionReason: string | null;
  note: string | null;
  recordedById: string;
  recordedByName: string | null;
  createdAt: string;
  locationName?: string;
  locationCode?: string;
  workerName?: string;
}

const VERIFICATION_LABEL: Record<string, string> = {
  operator_recorded: "Operator-recorded",
  statement_imported: "Imported statement",
  provider_confirmed: "Provider-confirmed",
  disputed: "Disputed",
};

const NETWORK_LABEL: Record<string, string> = {
  mtn: "MTN MoMo",
  telecel: "Telecel Cash",
  at_money: "AT Money",
  other: "Other network",
  unassigned: "Not network-specific",
};

function entryView(row: {
  id: string;
  type: string;
  network: string;
  direction: string;
  verificationStatus: string;
  recordedDeviceId: string | null;
  recordedDeviceName: string | null;
  supportingEvidence: string | null;
  amount: unknown;
  commissionAmount: unknown;
  businessDate: Date;
  occurredAt: Date;
  reference: string;
  externalReference: string | null;
  recordingSource: string;
  status: string;
  reversesTransactionId: string | null;
  correctsTransactionId: string | null;
  correctionReason: string | null;
  note: string | null;
  recordedById: string;
  createdAt: Date;
  location?: { name: string; code: string } | null;
  worker?: { fullName: string } | null;
}): LedgerEntryView {
  const definition = isMomoTransactionType(row.type)
    ? transactionDefinition(row.type)
    : null;
  return {
    id: row.id,
    type: row.type,
    typeLabel: definition ? definition.shortLabel : row.type,
    network: row.network,
    networkLabel: NETWORK_LABEL[row.network] ?? row.network,
    direction: row.direction,
    verificationStatus: row.verificationStatus,
    verificationLabel:
      VERIFICATION_LABEL[row.verificationStatus] ?? row.verificationStatus,
    recordedDeviceId: row.recordedDeviceId,
    recordedDeviceName: row.recordedDeviceName,
    supportingEvidence: row.supportingEvidence,
    cashEffect: definition
      ? definition.cashEffect *
        money(row.amount) *
        (row.direction === "reversal" ? -1 : 1)
      : 0,
    floatEffect: definition
      ? definition.floatEffect *
        money(row.amount) *
        (row.direction === "reversal" ? -1 : 1)
      : 0,
    amount: money(row.amount),
    commissionAmount: money(row.commissionAmount),
    businessDate: row.businessDate.toISOString(),
    occurredAt: row.occurredAt.toISOString(),
    reference: row.reference,
    externalReference: row.externalReference,
    recordingSource: row.recordingSource,
    status: row.status,
    reversesTransactionId: row.reversesTransactionId,
    correctsTransactionId: row.correctsTransactionId,
    correctionReason: row.correctionReason,
    note: row.note,
    recordedById: row.recordedById,
    recordedByName: row.worker?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    locationName: row.location?.name,
    locationCode: row.location?.code,
    workerName: row.worker?.fullName,
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export async function recordMomoTransaction(
  accountId: string,
  input: {
    type: string;
    network?: string;
    amount: number;
    commissionAmount?: number;
    occurredAt: string;
    reference: string;
    externalReference?: string | null;
    note?: string;
    supportingEvidence?: string;
    idempotencyKey: string;
  }
): Promise<LedgerActionResponse> {
  const ctx = await requireLedgerActor();
  if (!accountId) return { success: false, error: "Select a daily account." };

  const parsed = momoTransactionInputSchema.safeParse({
    ...input,
    commissionAmount: input.commissionAmount ?? 0,
    externalReference: input.externalReference?.trim() || null,
    supportingEvidence: input.supportingEvidence?.trim() || undefined,
  });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    select: {
      id: true,
      tenantId: true,
      locationId: true,
      workerId: true,
      businessDate: true,
      status: true,
      ledgerMode: true,
    },
  });
  if (!account) return { success: false, error: DENIED };
  if (account.status !== "draft") {
    return {
      success: false,
      error: "Only a draft daily account can receive new transactions.",
    };
  }
  if (account.ledgerMode !== "ledger") {
    return {
      success: false,
      error:
        "Switch this day to the transaction ledger before recording individual transactions.",
    };
  }

  if (ctx.role !== "admin") {
    if (account.workerId !== ctx.userId) return { success: false, error: DENIED };
    const locationId = await workerLocationId(ctx.tenantId, ctx.userId);
    if (!locationId || locationId !== account.locationId) {
      return { success: false, error: DENIED };
    }
  }

  const occurredAt = new Date(values.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    return { success: false, error: "Enter a valid transaction time." };
  }
  if (!isWithinBusinessDate(occurredAt, account.businessDate)) {
    return {
      success: false,
      error:
        "The transaction time must fall inside the business day of this daily account.",
    };
  }

  // Replay with the same key returns the already-recorded entry unchanged.
  const existing = await db.momoTransaction.findFirst({
    where: { tenantId: ctx.tenantId, idempotencyKey: values.idempotencyKey },
    include: { location: { select: { name: true, code: true } }, worker: { select: { fullName: true } } },
  });
  if (existing) {
    if (existing.dailyAccountId !== accountId) {
      return { success: false, error: "This submission key was already used." };
    }
    return { success: true, data: { entry: entryView(existing), duplicate: true } };
  }

  const duplicateReference = await db.momoTransaction.findFirst({
    where: { tenantId: ctx.tenantId, reference: values.reference },
    select: { id: true },
  });
  if (duplicateReference) {
    return {
      success: false,
      error: "That business reference is already recorded for this business.",
    };
  }
  if (values.externalReference) {
    const duplicateExternal = await db.momoTransaction.findFirst({
      where: {
        tenantId: ctx.tenantId,
        network: values.network,
        externalReference: values.externalReference,
      },
      select: { id: true },
    });
    if (duplicateExternal) {
      return {
        success: false,
        error: "That provider reference is already recorded for this network.",
      };
    }
  }

  try {
    const created = await db.$transaction(async (tx) => {
      const row = await tx.momoTransaction.create({
        data: {
          tenantId: ctx.tenantId,
          locationId: account.locationId,
          dailyAccountId: account.id,
          workerId: account.workerId,
          type: values.type,
          network: values.network,
          direction: deriveDirection(values.type as MomoTransactionType),
          amount: values.amount,
          commissionAmount: values.commissionAmount,
          businessDate: account.businessDate,
          occurredAt,
          reference: values.reference,
          externalReference: values.externalReference ?? null,
          recordingSource: "manual_operator",
          verificationStatus: "operator_recorded",
          status: "recorded",
          idempotencyKey: values.idempotencyKey,
          note: values.note?.trim() || null,
          supportingEvidence: values.supportingEvidence?.trim() || null,
          recordedById: ctx.userId,
        },
        include: {
          location: { select: { name: true, code: true } },
          worker: { select: { fullName: true } },
        },
      });

      // The audit row is written in the same transaction: a committed
      // transaction can never exist without its audit event.
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "momo.transaction_recorded",
        entityType: "momoTransaction",
        entityId: row.id,
        details: {
          dailyAccountId: account.id,
          locationId: account.locationId,
          type: values.type,
          network: values.network,
          amount: values.amount,
          commissionAmount: values.commissionAmount,
          reference: values.reference,
          recordingSource: "manual_operator",
          verificationStatus: "operator_recorded",
          supportingEvidence: values.supportingEvidence?.trim() || null,
        },
      });
      return row;
    });

    revalidateLedger(accountId);
    return { success: true, data: { entry: entryView(created), duplicate: false } };
  } catch (error) {
    if (uniqueViolation(error)) {
      const replay = await db.momoTransaction.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey: values.idempotencyKey },
        include: {
          location: { select: { name: true, code: true } },
          worker: { select: { fullName: true } },
        },
      });
      if (replay && replay.dailyAccountId === accountId) {
        return { success: true, data: { entry: entryView(replay), duplicate: true } };
      }
      return {
        success: false,
        error: "That reference or submission key was already used.",
      };
    }
    return { success: false, error: "The transaction could not be recorded." };
  }
}

// ---------------------------------------------------------------------------
// Reversal and correction
// ---------------------------------------------------------------------------

async function claimAdminStepUp(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  token: string | undefined,
  transactionId: string,
  amountMinor: number
): Promise<void> {
  const session = await actorSession();
  const grant = await claimStepUpGrant(tx, {
    token,
    subjectType: "user",
    subjectId: ctx.userId,
    sessionId: stepUpSessionBinding(session, ctx.userId),
    purpose: "finance.momo_transaction.reverse",
    targetType: "momoTransaction",
    targetId: transactionId,
    context: { amountMinor },
  });
  if (!grant.ok) throw new StepUpDeniedError(grant.error);
}

export async function reverseMomoTransaction(input: {
  transactionId: string;
  reason: string;
  stepUpToken?: string;
}): Promise<LedgerActionResponse> {
  const ctx = await requireLedgerActor();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    return {
      success: false,
      error: "Enter a reversal reason of at least 10 characters.",
    };
  }

  const original = await db.momoTransaction.findFirst({
    where: { id: input.transactionId, tenantId: ctx.tenantId },
    include: { dailyAccount: { select: { id: true, status: true } } },
  });
  if (!original) return { success: false, error: DENIED };

  if (ctx.role !== "admin") {
    if (original.workerId !== ctx.userId) return { success: false, error: DENIED };
    const locationId = await workerLocationId(ctx.tenantId, ctx.userId);
    if (!locationId || locationId !== original.locationId) {
      return { success: false, error: DENIED };
    }
    if (original.dailyAccount?.status !== "draft") {
      return {
        success: false,
        error: "Ask an administrator to reverse a transaction after submission.",
      };
    }
  }

  // A retried submission returns the reversal that already exists.
  const alreadyReversed = await db.momoTransaction.findFirst({
    where: { tenantId: ctx.tenantId, reversesTransactionId: original.id },
    select: { id: true },
  });
  if (alreadyReversed) {
    return { success: true, data: { reversalId: alreadyReversed.id, duplicate: true } };
  }
  if (original.status !== "recorded") {
    return {
      success: false,
      error: "This transaction has already been reversed or corrected.",
    };
  }

  const afterSubmission = original.dailyAccount?.status !== "draft";

  try {
    const reversal = await db.$transaction(async (tx) => {
      if (ctx.role === "admin" && afterSubmission) {
        await claimAdminStepUp(
          tx,
          ctx,
          input.stepUpToken,
          original.id,
          Math.round(money(original.amount) * 100)
        );
      }

      const updated = await tx.momoTransaction.updateMany({
        where: {
          id: original.id,
          tenantId: ctx.tenantId,
          status: "recorded",
        },
        data: { status: "reversed" },
      });
      if (updated.count !== 1) throw new Error("REVERSAL_CONFLICT");

      const row = await tx.momoTransaction.create({
        data: {
          tenantId: ctx.tenantId,
          locationId: original.locationId,
          dailyAccountId: original.dailyAccountId,
          workerId: original.workerId,
          type: original.type,
          network: original.network,
          direction: "reversal",
          amount: original.amount,
          commissionAmount: original.commissionAmount,
          businessDate: original.businessDate,
          occurredAt: new Date(),
          reference: `REV-${original.reference}`.slice(0, 64),
          externalReference: null,
          recordingSource: "manual_operator",
          verificationStatus: "operator_recorded",
          supportingEvidence: original.supportingEvidence,
          status: "reversal",
          idempotencyKey: `reversal:${original.id}`.slice(0, 120),
          reversesTransactionId: original.id,
          correctionReason: reason,
          note: `Reversal of ${original.reference}: ${reason}`.slice(0, 300),
          recordedById: ctx.userId,
        },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "momo.transaction_reversed",
        entityType: "momoTransaction",
        entityId: original.id,
        details: {
          reversalId: row.id,
          dailyAccountId: original.dailyAccountId,
          reference: original.reference,
          type: original.type,
          amount: money(original.amount),
          reason,
        },
      });
      return row;
    });

    revalidateLedger(original.dailyAccountId ?? undefined);
    return { success: true, data: { reversalId: reversal.id } };
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    if (error instanceof Error && error.message === "REVERSAL_CONFLICT") {
      return {
        success: false,
        error: "This transaction changed while you were reversing it. Reload and try again.",
      };
    }
    return { success: false, error: "The reversal could not be recorded." };
  }
}

export async function correctMomoTransaction(input: {
  transactionId: string;
  amount: number;
  commissionAmount?: number;
  network?: string;
  occurredAt: string;
  reference: string;
  externalReference?: string | null;
  note?: string;
  supportingEvidence?: string;
  reason: string;
  idempotencyKey: string;
  stepUpToken?: string;
}): Promise<LedgerActionResponse> {
  const ctx = await requireLedgerActor();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    return {
      success: false,
      error: "Enter a correction reason of at least 10 characters.",
    };
  }

  const original = await db.momoTransaction.findFirst({
    where: { id: input.transactionId, tenantId: ctx.tenantId },
    include: { dailyAccount: { select: { id: true, status: true, businessDate: true } } },
  });
  if (!original) return { success: false, error: DENIED };

  const alreadyCorrected = await db.momoTransaction.findFirst({
    where: {
      tenantId: ctx.tenantId,
      correctsTransactionId: original.id,
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true },
  });
  if (alreadyCorrected) {
    return { success: true, data: { successorId: alreadyCorrected.id, duplicate: true } };
  }

  if (original.status !== "recorded") {
    return {
      success: false,
      error: "This transaction has already been reversed or corrected.",
    };
  }
  if (!original.dailyAccount) {
    return { success: false, error: "This transaction is not linked to a daily account." };
  }

  if (ctx.role !== "admin") {
    if (original.workerId !== ctx.userId) return { success: false, error: DENIED };
    const locationId = await workerLocationId(ctx.tenantId, ctx.userId);
    if (!locationId || locationId !== original.locationId) {
      return { success: false, error: DENIED };
    }
    if (original.dailyAccount.status !== "draft") {
      return {
        success: false,
        error: "Ask an administrator to correct a transaction after submission.",
      };
    }
  }

  const parsed = momoTransactionInputSchema.safeParse({
    type: original.type,
    network: input.network ?? original.network,
    amount: input.amount,
    commissionAmount: input.commissionAmount ?? 0,
    occurredAt: input.occurredAt,
    reference: input.reference,
    externalReference: input.externalReference?.trim() || null,
    note: input.note?.trim() || undefined,
    supportingEvidence:
      input.supportingEvidence?.trim() || original.supportingEvidence || undefined,
    idempotencyKey: input.idempotencyKey,
  });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;
  if (!isMomoNetwork(values.network)) return { success: false, error: "Choose a valid network." };

  const occurredAt = new Date(values.occurredAt);
  if (!isWithinBusinessDate(occurredAt, original.dailyAccount.businessDate)) {
    return {
      success: false,
      error:
        "The corrected transaction time must fall inside the original business day.",
    };
  }
  if (values.reference === original.reference) {
    return {
      success: false,
      error: "Give the corrected row a new business reference. The original stays preserved.",
    };
  }

  const duplicateReference = await db.momoTransaction.findFirst({
    where: { tenantId: ctx.tenantId, reference: values.reference },
    select: { id: true },
  });
  if (duplicateReference) {
    return { success: false, error: "That business reference is already recorded." };
  }

  const afterSubmission = original.dailyAccount.status !== "draft";

  try {
    const successor = await db.$transaction(async (tx) => {
      if (ctx.role === "admin" && afterSubmission) {
        await claimAdminStepUp(
          tx,
          ctx,
          input.stepUpToken,
          original.id,
          Math.round(money(original.amount) * 100)
        );
      }

      const updated = await tx.momoTransaction.updateMany({
        where: { id: original.id, tenantId: ctx.tenantId, status: "recorded" },
        data: { status: "corrected" },
      });
      if (updated.count !== 1) throw new Error("CORRECTION_CONFLICT");

      const row = await tx.momoTransaction.create({
        data: {
          tenantId: ctx.tenantId,
          locationId: original.locationId,
          dailyAccountId: original.dailyAccountId,
          workerId: original.workerId,
          type: original.type,
          network: values.network,
          direction: deriveDirection(original.type as MomoTransactionType),
          amount: values.amount,
          commissionAmount: values.commissionAmount,
          businessDate: original.businessDate,
          occurredAt,
          reference: values.reference,
          externalReference: values.externalReference ?? null,
          recordingSource: "manual_operator",
          verificationStatus: "operator_recorded",
          supportingEvidence: values.supportingEvidence ?? null,
          status: "recorded",
          idempotencyKey: values.idempotencyKey,
          correctsTransactionId: original.id,
          correctionReason: reason,
          note: values.note?.trim() || null,
          recordedById: ctx.userId,
        },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "momo.transaction_corrected",
        entityType: "momoTransaction",
        entityId: original.id,
        details: {
          successorId: row.id,
          dailyAccountId: original.dailyAccountId,
          previousReference: original.reference,
          previousAmount: money(original.amount),
          newReference: values.reference,
          newAmount: values.amount,
          reason,
        },
      });
      return row;
    });

    revalidateLedger(original.dailyAccountId ?? undefined);
    return { success: true, data: { successorId: successor.id } };
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    if (error instanceof Error && error.message === "CORRECTION_CONFLICT") {
      return {
        success: false,
        error: "This transaction changed while you were correcting it. Reload and try again.",
      };
    }
    if (uniqueViolation(error)) {
      return { success: false, error: "That reference or submission key was already used." };
    }
    return { success: false, error: "The correction could not be recorded." };
  }
}

// ---------------------------------------------------------------------------
// Ledger mode and opening roll-forward
// ---------------------------------------------------------------------------

export async function enableLedgerMode(accountId: string): Promise<LedgerActionResponse> {
  const ctx = await requireLedgerActor();
  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: { _count: { select: { expenses: true } } },
  });
  if (!account) return { success: false, error: DENIED };
  if (account.status !== "draft") {
    return {
      success: false,
      error: "Only a draft day can be switched to the transaction ledger.",
    };
  }
  if (ctx.role !== "admin") {
    if (account.workerId !== ctx.userId) return { success: false, error: DENIED };
    const locationId = await workerLocationId(ctx.tenantId, ctx.userId);
    if (!locationId || locationId !== account.locationId) {
      return { success: false, error: DENIED };
    }
  }
  if (account.ledgerMode === "ledger") {
    return { success: true, data: { alreadyEnabled: true } };
  }

  // Cutover guard: aggregate figures must be empty. Converting a day that
  // already carries manual commission/expenses would either double count or
  // silently discard them.
  const hasAggregate =
    Number(account.commission) !== 0 ||
    Number(account.debtsCollected) !== 0 ||
    Number(account.otherIncome) !== 0 ||
    Number(account.totalExpenses) !== 0 ||
    Number(account.totalAirtimeSold) !== 0 ||
    account._count.expenses > 0;
  if (hasAggregate) {
    return {
      success: false,
      error:
        "This day already contains manual commission, debts, airtime or expenses. Record the closing with the manual form, or clear those figures before switching to the ledger.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.dailyAccount.updateMany({
        where: {
          id: accountId,
          tenantId: ctx.tenantId,
          status: "draft",
          ledgerMode: "aggregate",
        },
        data: { ledgerMode: "ledger", ledgerCutoverAt: new Date() },
      });
      if (updated.count !== 1) throw new Error("LEDGER_SWITCH_CONFLICT");

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "momo.ledger_enabled",
        entityType: "dailyAccount",
        entityId: accountId,
        details: {
          locationId: account.locationId,
          businessDate: account.businessDate.toISOString(),
          policy:
            "Aggregate snapshot preserved. No historical transactions were invented. Commission, debts, other income and expenses will derive from ledger entries from this point.",
        },
      });
    });
  } catch {
    return { success: false, error: "This day changed while switching. Reload and try again." };
  }

  revalidateLedger(accountId);
  return { success: true };
}

export async function disableLedgerMode(accountId: string): Promise<LedgerActionResponse> {
  const ctx = await requireLedgerActor();
  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: { _count: { select: { momoTransactions: true } } },
  });
  if (!account) return { success: false, error: DENIED };
  if (account.status !== "draft") {
    return { success: false, error: "Only a draft day can be switched back." };
  }
  if (ctx.role !== "admin" && account.workerId !== ctx.userId) {
    return { success: false, error: DENIED };
  }
  if (account._count.momoTransactions > 0) {
    return {
      success: false,
      error:
        "This day already has ledger entries. They stay in the audit history, so the day cannot switch back to the aggregate form.",
    };
  }
  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.dailyAccount.updateMany({
        where: { id: accountId, tenantId: ctx.tenantId, status: "draft", ledgerMode: "ledger" },
        data: {
          ledgerMode: "aggregate",
          ledgerCutoverAt: null,
          commission: 0,
          debtsCollected: 0,
          otherIncome: 0,
          totalExpenses: 0,
          totalAirtimeSold: 0,
        },
      });
      if (updated.count !== 1) throw new Error("LEDGER_SWITCH_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "momo.ledger_disabled",
        entityType: "dailyAccount",
        entityId: accountId,
        details: { locationId: account.locationId },
      });
    });
  } catch {
    return { success: false, error: "This day changed while switching. Reload and try again." };
  }
  revalidateLedger(accountId);
  return { success: true };
}

export async function applyOpeningCarryForward(
  accountId: string
): Promise<LedgerActionResponse> {
  const ctx = await requireLedgerActor();
  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
  });
  if (!account) return { success: false, error: DENIED };
  if (account.status !== "draft") {
    return { success: false, error: "Opening balances are locked after submission." };
  }
  if (ctx.role !== "admin") {
    if (account.workerId !== ctx.userId) return { success: false, error: DENIED };
    const locationId = await workerLocationId(ctx.tenantId, ctx.userId);
    if (!locationId || locationId !== account.locationId) {
      return { success: false, error: DENIED };
    }
  }
  if (Number(account.openingCash) !== 0 || Number(account.openingMomoFloat) !== 0) {
    return {
      success: false,
      error:
        "Opening balances are already entered. Clear them first if you want to carry the prior close.",
    };
  }

  const carry = await resolveOpeningCarryForward({
    tenantId: ctx.tenantId,
    locationId: account.locationId,
    businessDate: account.businessDate,
    excludeAccountId: account.id,
  });
  if (!carry.available) {
    return {
      success: false,
      error:
        carry.reason === "prior_unapproved"
          ? "The previous day has not been reviewed by an administrator yet."
          : carry.reason === "prior_unresolved"
            ? "The previous day is not balanced. Enter the opening manually and explain it."
            : "There is no earlier closing to carry forward for this location.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.dailyAccount.updateMany({
        where: {
          id: account.id,
          tenantId: ctx.tenantId,
          status: "draft",
          openingCash: 0,
          openingMomoFloat: 0,
        },
        data: {
          openingCash: carry.openingCash ?? 0,
          openingMomoFloat: carry.openingMomoFloat ?? 0,
          openingBalanceSource: "carried",
          carriedFromAccountId: carry.sourceAccountId,
          openingAdjustmentReason: null,
        },
      });
      if (updated.count !== 1) throw new Error("CARRY_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "momo.opening_carried",
        entityType: "dailyAccount",
        entityId: account.id,
        details: {
          fromAccountId: carry.sourceAccountId,
          businessDate: carry.businessDate,
          openingCash: carry.openingCash,
          openingMomoFloat: carry.openingMomoFloat,
        },
      });
    });
  } catch {
    return { success: false, error: "This day changed while carrying the opening. Reload and try again." };
  }

  revalidateLedger(account.id);
  return { success: true, data: carry };
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface AccountLedgerView {
  accountId: string;
  ledgerMode: string;
  status: string;
  businessDate: string;
  openingBalanceSource: string;
  carriedFromAccountId: string | null;
  openingAdjustmentReason: string | null;
  summary: LedgerSummary;
  projection: LedgerProjection;
  carryForward: OpeningCarryForward;
  entries: LedgerEntryView[];
  commissionSourceNote: string;
}

function commissionSourceNote(summary: LedgerSummary): string {
  if (summary.commissionBasis === "day_total") {
    return "Commission is taken from the day-total commission entries. Per-transaction commission amounts are reference only.";
  }
  if (summary.commissionBasis === "per_transaction") {
    return "Commission is summed from the commission amount recorded on each transaction.";
  }
  return "No commission has been recorded in the ledger yet.";
}

/** Worker view: only the worker's own account at their own location. */
export async function getAccountLedgerView(
  accountId: string
): Promise<AccountLedgerView | null> {
  const ctx = await requireLedgerActor();
  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
  });
  if (!account) return null;
  if (ctx.role !== "admin") {
    if (account.workerId !== ctx.userId) return null;
    const locationId = await workerLocationId(ctx.tenantId, ctx.userId);
    if (!locationId || locationId !== account.locationId) return null;
  }

  const [rows, carry] = await Promise.all([
    db.momoTransaction.findMany({
      where: { dailyAccountId: account.id, tenantId: ctx.tenantId },
      include: {
        location: { select: { name: true, code: true } },
        worker: { select: { fullName: true } },
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
    resolveOpeningCarryForward({
      tenantId: ctx.tenantId,
      locationId: account.locationId,
      businessDate: account.businessDate,
      excludeAccountId: account.id,
    }),
  ]);

  const summary = summariseLedger(
    rows.map((row) => ({
      type: row.type,
      amount: row.amount,
      commissionAmount: row.commissionAmount,
      status: row.status,
    }))
  );

  return {
    accountId: account.id,
    ledgerMode: account.ledgerMode,
    status: account.status,
    businessDate: account.businessDate.toISOString(),
    openingBalanceSource: account.openingBalanceSource,
    carriedFromAccountId: account.carriedFromAccountId,
    openingAdjustmentReason: account.openingAdjustmentReason,
    summary,
    projection: projectLedgerPosition(summary, {
      openingCash: account.openingCash,
      openingFloat: account.openingMomoFloat,
    }),
    carryForward: carry,
    entries: rows.map(entryView),
    commissionSourceNote: commissionSourceNote(summary),
  };
}

export interface AdminLedgerFilters {
  locationId?: string;
  workerId?: string;
  type?: string;
  network?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}

export async function getAdminLedgerView(filters: AdminLedgerFilters = {}) {
  const ctx = await requireTenantContext("admin", "momo");
  if (ctx.role !== "admin") redirect("/unauthorized");
  return queryLedger(ctx.tenantId, filters);
}

async function queryLedger(tenantId: string, filters: AdminLedgerFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(10, filters.limit ?? 25));
  const where: Record<string, unknown> = { tenantId };

  if (filters.locationId) {
    const location = await db.location.findFirst({
      where: { id: filters.locationId, tenantId },
      select: { id: true },
    });
    if (!location) {
      return { entries: [], total: 0, page, limit, summary: summariseLedger([]), filters: await filterOptions(tenantId) };
    }
    where.locationId = filters.locationId;
  }
  if (filters.workerId) {
    const worker = await db.user.findFirst({
      where: { id: filters.workerId, tenantId },
      select: { id: true },
    });
    if (!worker) {
      return { entries: [], total: 0, page, limit, summary: summariseLedger([]), filters: await filterOptions(tenantId) };
    }
    where.workerId = filters.workerId;
  }
  if (filters.type && isMomoTransactionType(filters.type)) where.type = filters.type;
  if (filters.network && isMomoNetwork(filters.network)) where.network = filters.network;
  if (filters.status) {
    if (!["recorded", "reversed", "corrected", "reversal"].includes(filters.status)) {
      where.status = "recorded";
    } else {
      where.status = filters.status;
    }
  }
  if (filters.dateFrom || filters.dateTo) {
    where.businessDate = {
      ...(filters.dateFrom ? { gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) } : {}),
      ...(filters.dateTo ? { lte: new Date(`${filters.dateTo}T23:59:59.999Z`) } : {}),
    };
  }

  const [rows, total, allRows, options] = await Promise.all([
    db.momoTransaction.findMany({
      where,
      include: {
        location: { select: { name: true, code: true } },
        worker: { select: { fullName: true } },
      },
      orderBy: [{ businessDate: "desc" }, { occurredAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.momoTransaction.count({ where }),
    db.momoTransaction.findMany({
      where,
      select: { type: true, amount: true, commissionAmount: true, status: true },
    }),
    filterOptions(tenantId),
  ]);

  return {
    entries: rows.map(entryView),
    total,
    page,
    limit,
    summary: summariseLedger(allRows),
    filters: options,
  };
}

async function filterOptions(tenantId: string) {
  const [locations, workers] = await Promise.all([
    db.location.findMany({
      where: { tenantId },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    db.user.findMany({
      where: { tenantId, role: { in: ["worker", "admin", "collector"] }, status: "active" },
      select: { id: true, fullName: true, role: true },
      orderBy: { fullName: "asc" },
    }),
  ]);
  return { locations, workers };
}

export async function getLedgerEntry(transactionId: string) {
  const ctx = await requireTenantContext("admin", "momo");
  if (ctx.role !== "admin") redirect("/unauthorized");
  const row = await db.momoTransaction.findFirst({
    where: { id: transactionId, tenantId: ctx.tenantId },
    include: {
      location: { select: { name: true, code: true } },
      worker: { select: { fullName: true } },
    },
  });
  if (!row) return null;

  const history = await db.momoTransaction.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: [
        { id: row.id },
        { correctsTransactionId: row.correctsTransactionId ?? row.id },
        { reversesTransactionId: row.id },
      ],
    },
    include: {
      location: { select: { name: true, code: true } },
      worker: { select: { fullName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    entry: entryView(row),
    history: history.map(entryView),
  };
}

/**
 * CSV export for the filtered ledger. Built from the same tenant-scoped query
 * as the screen, so it cannot expose another tenant's rows. Formula-leading
 * cells are neutralised to prevent spreadsheet injection.
 */
/**
 * CSV export. The tenant always comes from the verified session, never from a
 * caller-supplied id, so this cannot be used to read another business's ledger.
 */
export async function exportLedgerCsv(filters: AdminLedgerFilters = {}) {
  const ctx = await requireTenantContext("admin", "momo");
  if (ctx.role !== "admin") redirect("/unauthorized");
  const view = await queryLedger(ctx.tenantId, { ...filters, page: 1, limit: 100 });
  const header = [
    "Business date",
    "Recorded at",
    "Location",
    "Worker",
    "Type",
    "Network",
    "Direction",
    "Cash effect (GHS)",
    "Float effect (GHS)",
    "Verification",
    "Recorded device",
    "Supporting evidence",
    "Amount (GHS)",
    "Commission (GHS)",
    "Reference",
    "Provider reference",
    "Source",
    "Status",
  ];
  const escape = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [header.map(escape).join(",")];
  for (const entry of view.entries) {
    lines.push(
      [
        entry.businessDate.slice(0, 10),
        entry.occurredAt,
        `${entry.locationName ?? ""} (${entry.locationCode ?? ""})`,
        entry.workerName ?? "",
        entry.typeLabel,
        entry.networkLabel,
        entry.direction,
        entry.cashEffect.toFixed(2),
        entry.floatEffect.toFixed(2),
        entry.verificationStatus,
        entry.recordedDeviceName ?? entry.recordedDeviceId ?? "",
        entry.supportingEvidence ?? "",
        entry.amount.toFixed(2),
        entry.commissionAmount.toFixed(2),
        entry.reference,
        entry.externalReference ?? "",
        entry.recordingSource,
        entry.status,
      ]
        .map(escape)
        .join(",")
    );
  }
  return { csv: lines.join("\n"), filename: `momo-ledger-${new Date().toISOString().slice(0, 10)}.csv` };
}
