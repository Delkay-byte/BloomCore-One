"use server";

import { randomBytes } from "crypto";
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
  canShiftTransition,
  closeShiftSchema,
  computeHandoverVariance,
  confirmHandoverSchema,
  createShiftSchema,
  describeHandoverVariance,
  generateHandoverReference,
  generateShiftReference,
  resolveHandoverSchema,
  shiftOpeningIsMaterial,
  SHIFT_STATUS_LABELS,
  type ShiftStatus,
} from "@/lib/shifts";
import {
  resolveShiftOpeningCarry,
  shiftAggregateForDailyAccount,
  type DailyAccountShiftAggregate,
} from "@/lib/shift-service";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export interface ShiftActionResponse {
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

async function requireShiftActor(): Promise<TenantContext> {
  const ctx =
    (await getTenantContext("momo", "momo")) ??
    (await getTenantContext("admin", "momo"));
  if (!ctx) return requireTenantContext("momo", "momo");
  if (!ctx.modules.includes("momo")) redirect("/unauthorized");
  await enforcePaidOperations(ctx.tenantId, "/unauthorized?reason=payment_required");
  return ctx;
}

async function actorSession(): Promise<{ jti?: string | null; iat?: number } | null> {
  return (await getMomoSession()) ?? (await getAdminSession());
}

async function currentUser(tenantId: string, userId: string) {
  return db.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, fullName: true, role: true, locationId: true, status: true },
  });
}

function revalidateShifts() {
  revalidatePath("/admin/shifts");
  revalidatePath("/worker/shifts");
  revalidatePath("/admin/dashboard");
}

// ---------------------------------------------------------------------------
// Shift creation and opening
// ---------------------------------------------------------------------------

export async function createShift(input: {
  locationId: string;
  businessDate: string;
  name: string;
  label?: string;
  assignedUserId: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  openingCash: number;
  openingMomoFloat: number;
  openingAdjustmentReason?: string;
}): Promise<ShiftActionResponse> {
  const ctx = await requireShiftActor();
  const parsed = createShiftSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;

  const location = await db.location.findFirst({
    where: { id: values.locationId, tenantId: ctx.tenantId },
    select: { id: true, status: true },
  });
  if (!location) return { success: false, error: DENIED };
  if (location.status !== "active") {
    return { success: false, error: "This location is not active." };
  }

  if (ctx.role !== "admin" && values.locationId !== (await currentUser(ctx.tenantId, ctx.userId))?.locationId) {
    return { success: false, error: "You can only create a shift at your assigned location." };
  }

  const assigned = await currentUser(ctx.tenantId, values.assignedUserId);
  if (!assigned || assigned.status !== "active") {
    return { success: false, error: "Choose an active employee for this shift." };
  }
  if (assigned.locationId !== values.locationId) {
    return {
      success: false,
      error: "The assigned employee must belong to this location.",
    };
  }
  if (ctx.role !== "admin" && values.assignedUserId !== ctx.userId) {
    return { success: false, error: "You can only open a shift assigned to yourself." };
  }

  const businessDate = new Date(`${values.businessDate}T00:00:00.000Z`);
  if (Number.isNaN(businessDate.getTime())) {
    return { success: false, error: "Enter a valid business date." };
  }

  const dailyAccount = await db.dailyAccount.findFirst({
    where: { tenantId: ctx.tenantId, locationId: values.locationId, businessDate },
    select: { id: true },
  });

  const carry = await resolveShiftOpeningCarry({
    tenantId: ctx.tenantId,
    locationId: values.locationId,
    businessDate,
  });

  const manualOpening =
    money(values.openingCash) !== 0 || money(values.openingMomoFloat) !== 0;
  const openingCash = manualOpening ? money(values.openingCash) : carry.openingCash ?? 0;
  const openingMomoFloat = manualOpening
    ? money(values.openingMomoFloat)
    : carry.openingMomoFloat ?? 0;
  const openingSource = manualOpening
    ? carry.sourceShiftId && carry.openingCash !== null
      ? shiftOpeningIsMaterial(
          { cash: openingCash, float: openingMomoFloat },
          { cash: carry.openingCash, float: carry.openingMomoFloat }
        )
        ? "manual_adjusted"
        : "manual"
      : "manual"
    : carry.available
      ? "carried"
      : "manual";

  if (
    openingSource === "manual_adjusted" &&
    (values.openingAdjustmentReason?.trim().length ?? 0) < 10
  ) {
    return {
      success: false,
      error:
        "This opening differs from the previous shift close. Explain the difference in at least 10 characters.",
    };
  }

  const now = new Date();
  try {
    const shift = await db.$transaction(async (tx) => {
      const created = await tx.shift.create({
        data: {
          tenantId: ctx.tenantId,
          locationId: values.locationId,
          dailyAccountId: dailyAccount?.id ?? null,
          reference: generateShiftReference(now, randomBytes(3).toString("hex").toUpperCase()),
          businessDate,
          name: values.name,
          label: values.label?.trim() || null,
          assignedUserId: values.assignedUserId,
          status: "draft",
          scheduledStart: values.scheduledStart ? new Date(values.scheduledStart) : null,
          scheduledEnd: values.scheduledEnd ? new Date(values.scheduledEnd) : null,
          openingCash,
          openingMomoFloat,
          openingSource,
          carriedFromShiftId: carry.available ? carry.sourceShiftId : null,
          openingAdjustmentReason:
            openingSource === "manual_adjusted"
              ? values.openingAdjustmentReason?.trim() ?? null
              : null,
          createdById: ctx.userId,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "shift.created",
        entityType: "shift",
        entityId: created.id,
        details: {
          reference: created.reference,
          locationId: values.locationId,
          businessDate: values.businessDate,
          name: values.name,
          assignedUserId: values.assignedUserId,
          openingSource,
          openingCash,
          openingMomoFloat,
          dailyAccountId: dailyAccount?.id ?? null,
        },
      });
      return created;
    });

    revalidateShifts();
    return { success: true, data: { shiftId: shift.id, reference: shift.reference } };
  } catch (error) {
    if (uniqueViolation(error)) {
      return {
        success: false,
        error: "A shift with this name already exists at this location for that day.",
      };
    }
    return { success: false, error: "The shift could not be created." };
  }
}

export async function openShift(shiftId: string): Promise<ShiftActionResponse> {
  const ctx = await requireShiftActor();
  const shift = await db.shift.findFirst({
    where: { id: shiftId, tenantId: ctx.tenantId },
  });
  if (!shift) return { success: false, error: DENIED };
  if (ctx.role !== "admin" && shift.assignedUserId !== ctx.userId) {
    return { success: false, error: DENIED };
  }
  if (!canShiftTransition(shift.status as ShiftStatus, "open")) {
    return { success: false, error: "Only a draft shift can be opened." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.shift.updateMany({
        where: { id: shift.id, tenantId: ctx.tenantId, status: "draft" },
        data: { status: "open", openedById: ctx.userId, openedAt: new Date() },
      });
      if (updated.count !== 1) throw new Error("SHIFT_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "shift.opened",
        entityType: "shift",
        entityId: shift.id,
        details: { reference: shift.reference },
      });
    });
  } catch {
    return { success: false, error: "The shift could not be opened." };
  }
  revalidateShifts();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Two-sided handover
// ---------------------------------------------------------------------------

export async function closeShift(input: {
  shiftId: string;
  closingCash: number;
  closingMomoFloat: number;
  handoverToUserId: string;
  outstandingOperations?: string;
  outgoingNotes?: string;
}): Promise<ShiftActionResponse> {
  const ctx = await requireShiftActor();
  const parsed = closeShiftSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;

  const shift = await db.shift.findFirst({
    where: { id: values.shiftId, tenantId: ctx.tenantId },
  });
  if (!shift) return { success: false, error: DENIED };
  if (ctx.role !== "admin" && shift.assignedUserId !== ctx.userId) {
    return { success: false, error: DENIED };
  }
  if (shift.status !== "open") {
    return { success: false, error: "Only an open shift can be closed." };
  }
  if (values.handoverToUserId === shift.assignedUserId) {
    return {
      success: false,
      error:
        "The handover must go to a different employee. One person cannot confirm both sides.",
    };
  }
  const receiver = await currentUser(ctx.tenantId, values.handoverToUserId);
  if (!receiver || receiver.status !== "active") {
    return { success: false, error: "Choose an active employee to receive the handover." };
  }
  if (receiver.locationId !== shift.locationId) {
    return {
      success: false,
      error: "The receiving employee must belong to this shift's location.",
    };
  }

  const now = new Date();
  try {
    const handover = await db.$transaction(async (tx) => {
      const updated = await tx.shift.updateMany({
        where: { id: shift.id, tenantId: ctx.tenantId, status: "open" },
        data: {
          status: "awaiting_handover",
          closingCash: values.closingCash,
          closingMomoFloat: values.closingMomoFloat,
          closingNotes: values.outgoingNotes?.trim() || null,
          closedById: ctx.userId,
          closedAt: now,
        },
      });
      if (updated.count !== 1) throw new Error("SHIFT_CONFLICT");

      const row = await tx.shiftHandover.create({
        data: {
          tenantId: ctx.tenantId,
          shiftId: shift.id,
          reference: generateHandoverReference(now, randomBytes(3).toString("hex").toUpperCase()),
          outgoingUserId: shift.assignedUserId,
          outgoingCash: values.closingCash,
          outgoingMomoFloat: values.closingMomoFloat,
          outstandingOperations: values.outstandingOperations?.trim() || null,
          outgoingNotes: values.outgoingNotes?.trim() || null,
          incomingUserId: values.handoverToUserId,
          status: "awaiting_receipt",
        },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "shift.handover_submitted",
        entityType: "shiftHandover",
        entityId: row.id,
        details: {
          shiftId: shift.id,
          reference: row.reference,
          outgoingCash: values.closingCash,
          outgoingMomoFloat: values.closingMomoFloat,
          handoverToUserId: values.handoverToUserId,
        },
      });
      return row;
    });

    await createNotification({
      tenantId: ctx.tenantId,
      audience: "tenant",
      kind: "system",
      severity: "info",
      title: `Shift handover awaiting confirmation: ${shift.reference}`,
      body: `${receiver.fullName} must confirm the counted cash and float.`,
      href: "/admin/shifts",
      dedupeKey: `shift_handover_awaiting:${handover.id}`,
    }).catch(() => null);

    revalidateShifts();
    return { success: true, data: { handoverId: handover.id, reference: handover.reference } };
  } catch {
    return { success: false, error: "The handover could not be submitted." };
  }
}

export async function confirmShiftHandover(input: {
  handoverId: string;
  incomingCash: number;
  incomingMomoFloat: number;
  operationsAccepted: boolean;
  incomingNotes?: string;
}): Promise<ShiftActionResponse> {
  const ctx = await requireShiftActor();
  const parsed = confirmHandoverSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;

  const handover = await db.shiftHandover.findFirst({
    where: { id: values.handoverId, tenantId: ctx.tenantId },
    include: { shift: true },
  });
  if (!handover) return { success: false, error: DENIED };
  // Only the designated receiving employee may confirm. An administrator who
  // is not the receiver cannot silently complete the other side.
  if (handover.incomingUserId !== ctx.userId) {
    return {
      success: false,
      error: "Only the employee named as the receiver can confirm this handover.",
    };
  }
  if (handover.status !== "awaiting_receipt") {
    return { success: false, error: "This handover has already been confirmed." };
  }
  if (!values.operationsAccepted) {
    return {
      success: false,
      error:
        "You must accept the outstanding operations before confirming, or ask a supervisor to investigate.",
    };
  }

  const variance = computeHandoverVariance({
    outgoingCash: handover.outgoingCash,
    outgoingFloat: handover.outgoingMomoFloat,
    incomingCash: values.incomingCash,
    incomingFloat: values.incomingMomoFloat,
  });
  const note = values.incomingNotes?.trim() || null;
  if (!variance.balanced && (!note || note.length < 5)) {
    return {
      success: false,
      error: "Explain the difference between the declared and counted amounts.",
    };
  }
  const nextStatus = variance.balanced ? "confirmed" : "variance_open";

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.shiftHandover.updateMany({
        where: { id: handover.id, tenantId: ctx.tenantId, status: "awaiting_receipt" },
        data: {
          status: nextStatus,
          incomingCash: values.incomingCash,
          incomingMomoFloat: values.incomingMomoFloat,
          operationsAccepted: true,
          incomingNotes: note,
          cashVariance: variance.cashVariance,
          floatVariance: variance.floatVariance,
          varianceReason: variance.balanced ? null : note,
          confirmedAt: new Date(),
        },
      });
      if (updated.count !== 1) throw new Error("HANDOVER_CONFLICT");

      await tx.shift.updateMany({
        where: { id: handover.shiftId, tenantId: ctx.tenantId },
        data: { status: variance.balanced ? "closed" : "variance_open" },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: variance.balanced
          ? "shift.handover_confirmed"
          : "shift.handover_variance_recorded",
        entityType: "shiftHandover",
        entityId: handover.id,
        details: {
          shiftId: handover.shiftId,
          reference: handover.reference,
          outgoingCash: money(handover.outgoingCash),
          outgoingMomoFloat: money(handover.outgoingMomoFloat),
          incomingCash: values.incomingCash,
          incomingMomoFloat: values.incomingMomoFloat,
          cashVariance: variance.cashVariance,
          floatVariance: variance.floatVariance,
          reason: note,
        },
      });
    });
  } catch {
    return { success: false, error: "The handover confirmation could not be saved." };
  }

  if (!variance.balanced) {
    await createNotification({
      tenantId: ctx.tenantId,
      audience: "tenant",
      kind: "system",
      severity: "attention",
      title: `Handover variance on ${handover.reference}`,
      body: `${describeHandoverVariance(variance)}. The handover stays unresolved until an administrator investigates.`,
      href: "/admin/shifts",
      dedupeKey: `shift_handover_variance:${handover.id}`,
    }).catch(() => null);
  }

  revalidateShifts();
  return {
    success: true,
    data: {
      status: nextStatus,
      cashVariance: variance.cashVariance,
      floatVariance: variance.floatVariance,
    },
  };
}

export async function resolveShiftHandover(input: {
  handoverId: string;
  resolutionNote: string;
  stepUpToken?: string;
}): Promise<ShiftActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = resolveHandoverSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;

  const handover = await db.shiftHandover.findFirst({
    where: { id: values.handoverId, tenantId: ctx.tenantId },
  });
  if (!handover) return { success: false, error: DENIED };
  if (handover.status !== "variance_open") {
    return {
      success: false,
      error: "Only an open handover variance can be resolved.",
    };
  }

  const amountMinor =
    Math.round(money(handover.cashVariance ?? 0) * 100) +
    Math.round(money(handover.floatVariance ?? 0) * 100);
  const session = await actorSession();

  try {
    await db.$transaction(async (tx) => {
      const grant = await claimStepUpGrant(tx, {
        token: values.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "finance.shift_handover.resolve",
        targetType: "shiftHandover",
        targetId: handover.id,
        context: { amountMinor },
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      const updated = await tx.shiftHandover.updateMany({
        where: { id: handover.id, tenantId: ctx.tenantId, status: "variance_open" },
        data: {
          status: "resolved",
          resolvedById: ctx.userId,
          resolvedAt: new Date(),
          resolutionNote: values.resolutionNote,
        },
      });
      if (updated.count !== 1) throw new Error("HANDOVER_CONFLICT");

      await tx.shift.updateMany({
        where: { id: handover.shiftId, tenantId: ctx.tenantId },
        data: { status: "closed" },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "shift.handover_resolved",
        entityType: "shiftHandover",
        entityId: handover.id,
        details: {
          shiftId: handover.shiftId,
          reference: handover.reference,
          resolutionNote: values.resolutionNote,
          cashVariance: money(handover.cashVariance ?? 0),
          floatVariance: money(handover.floatVariance ?? 0),
        },
      });
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "The resolution could not be recorded." };
  }

  revalidateShifts();
  return { success: true };
}

export async function cancelShift(input: {
  shiftId: string;
  reason: string;
}): Promise<ShiftActionResponse> {
  const ctx = await requireShiftActor();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 5 || reason.length > 500) {
    return { success: false, error: "Enter a cancellation reason of at least 5 characters." };
  }
  const shift = await db.shift.findFirst({
    where: { id: input.shiftId, tenantId: ctx.tenantId },
    include: { handovers: { select: { id: true } } },
  });
  if (!shift) return { success: false, error: DENIED };
  if (ctx.role !== "admin" && shift.assignedUserId !== ctx.userId) {
    return { success: false, error: DENIED };
  }
  if (!["draft", "open"].includes(shift.status) || shift.handovers.length > 0) {
    return {
      success: false,
      error: "Only a draft or open shift without a submitted handover can be cancelled.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.shift.updateMany({
        where: { id: shift.id, tenantId: ctx.tenantId, status: shift.status },
        data: { status: "cancelled" },
      });
      if (updated.count !== 1) throw new Error("SHIFT_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "shift.cancelled",
        entityType: "shift",
        entityId: shift.id,
        details: { reference: shift.reference, reason },
      });
    });
  } catch {
    return { success: false, error: "The shift could not be cancelled." };
  }
  revalidateShifts();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface ShiftHandoverView {
  id: string;
  reference: string;
  status: string;
  outgoingUserId: string;
  outgoingUserName: string | null;
  outgoingCash: number;
  outgoingMomoFloat: number;
  outstandingOperations: string | null;
  outgoingNotes: string | null;
  incomingUserId: string | null;
  incomingUserName: string | null;
  incomingCash: number | null;
  incomingMomoFloat: number | null;
  operationsAccepted: boolean | null;
  incomingNotes: string | null;
  cashVariance: number | null;
  floatVariance: number | null;
  varianceReason: string | null;
  confirmedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export interface ShiftView {
  id: string;
  reference: string;
  businessDate: string;
  name: string;
  label: string;
  status: string;
  statusLabel: string;
  locationId: string;
  locationName: string;
  dailyAccountId: string | null;
  assignedUserId: string;
  assignedUserName: string | null;
  openingCash: number;
  openingMomoFloat: number;
  openingSource: string;
  openingAdjustmentReason: string | null;
  closingCash: number | null;
  closingMomoFloat: number | null;
  closingNotes: string | null;
  openedAt: string | null;
  closedAt: string | null;
  handovers: ShiftHandoverView[];
}

async function namesFor(
  tenantId: string,
  ids: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((user) => [user.id, user.fullName]));
}

function handoverView(
  row: {
    id: string;
    reference: string;
    status: string;
    outgoingUserId: string;
    outgoingCash: unknown;
    outgoingMomoFloat: unknown;
    outstandingOperations: string | null;
    outgoingNotes: string | null;
    incomingUserId: string | null;
    incomingCash: unknown;
    incomingMomoFloat: unknown;
    operationsAccepted: boolean | null;
    incomingNotes: string | null;
    cashVariance: unknown;
    floatVariance: unknown;
    varianceReason: string | null;
    confirmedAt: Date | null;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    createdAt: Date;
  },
  names: Map<string, string>
): ShiftHandoverView {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    outgoingUserId: row.outgoingUserId,
    outgoingUserName: names.get(row.outgoingUserId) ?? null,
    outgoingCash: money(row.outgoingCash),
    outgoingMomoFloat: money(row.outgoingMomoFloat),
    outstandingOperations: row.outstandingOperations,
    outgoingNotes: row.outgoingNotes,
    incomingUserId: row.incomingUserId,
    incomingUserName: row.incomingUserId ? names.get(row.incomingUserId) ?? null : null,
    incomingCash: row.incomingCash === null ? null : money(row.incomingCash),
    incomingMomoFloat:
      row.incomingMomoFloat === null ? null : money(row.incomingMomoFloat),
    operationsAccepted: row.operationsAccepted,
    incomingNotes: row.incomingNotes,
    cashVariance: row.cashVariance === null ? null : money(row.cashVariance),
    floatVariance: row.floatVariance === null ? null : money(row.floatVariance),
    varianceReason: row.varianceReason,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

function shiftView(
  row: {
    id: string;
    reference: string;
    businessDate: Date;
    name: string;
    label: string | null;
    status: string;
    locationId: string;
    dailyAccountId: string | null;
    assignedUserId: string;
    openingCash: unknown;
    openingMomoFloat: unknown;
    openingSource: string;
    openingAdjustmentReason: string | null;
    closingCash: unknown;
    closingMomoFloat: unknown;
    closingNotes: string | null;
    openedAt: Date | null;
    closedAt: Date | null;
    location: { name: string };
    handovers: Array<Parameters<typeof handoverView>[0]>;
  },
  names: Map<string, string>
): ShiftView {
  return {
    id: row.id,
    reference: row.reference,
    businessDate: row.businessDate.toISOString(),
    name: row.name,
    label: row.label ?? row.name,
    status: row.status,
    statusLabel: SHIFT_STATUS_LABELS[row.status as ShiftStatus] ?? row.status,
    locationId: row.locationId,
    locationName: row.location.name,
    dailyAccountId: row.dailyAccountId,
    assignedUserId: row.assignedUserId,
    assignedUserName: names.get(row.assignedUserId) ?? null,
    openingCash: money(row.openingCash),
    openingMomoFloat: money(row.openingMomoFloat),
    openingSource: row.openingSource,
    openingAdjustmentReason: row.openingAdjustmentReason,
    closingCash: row.closingCash === null ? null : money(row.closingCash),
    closingMomoFloat:
      row.closingMomoFloat === null ? null : money(row.closingMomoFloat),
    closingNotes: row.closingNotes,
    openedAt: row.openedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    handovers: row.handovers.map((handover) => handoverView(handover, names)),
  };
}

function shiftInclude() {
  return {
    location: { select: { name: true } },
    handovers: { orderBy: { createdAt: "desc" as const } },
  };
}

function collectNameIds(rows: Array<{
  assignedUserId: string;
  handovers: Array<{ outgoingUserId: string; incomingUserId: string | null }>;
}>): Array<string | null> {
  return rows.flatMap((row) => [
    row.assignedUserId,
    ...row.handovers.flatMap((handover) => [
      handover.outgoingUserId,
      handover.incomingUserId,
    ]),
  ]);
}

export interface WorkerShiftBoard {
  userId: string;
  locationId: string | null;
  locationName: string | null;
  shifts: ShiftView[];
  awaitingMyConfirmation: ShiftHandoverView[];
  colleagues: Array<{ id: string; fullName: string }>;
}

export async function getWorkerShiftBoard(): Promise<WorkerShiftBoard> {
  const ctx = await requireShiftActor();
  const user = await currentUser(ctx.tenantId, ctx.userId);
  if (!user?.locationId) {
    return {
      userId: ctx.userId,
      locationId: null,
      locationName: null,
      shifts: [],
      awaitingMyConfirmation: [],
      colleagues: [],
    };
  }

  const [shifts, awaiting, colleagues] = await Promise.all([
    db.shift.findMany({
      where: {
        tenantId: ctx.tenantId,
        locationId: user.locationId,
      },
      include: shiftInclude(),
      orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
      take: 40,
    }),
    db.shiftHandover.findMany({
      where: {
        tenantId: ctx.tenantId,
        incomingUserId: ctx.userId,
        status: "awaiting_receipt",
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.user.findMany({
      where: {
        tenantId: ctx.tenantId,
        locationId: user.locationId,
        status: "active",
        id: { not: ctx.userId },
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
  ]);

  const names = await namesFor(ctx.tenantId, [
    ...collectNameIds(shifts),
    ...awaiting.flatMap((row) => [row.outgoingUserId, row.incomingUserId]),
  ]);

  return {
    userId: ctx.userId,
    locationId: user.locationId,
    locationName: shifts[0]?.location.name ?? null,
    shifts: shifts.map((shift) => shiftView(shift, names)),
    awaitingMyConfirmation: awaiting.map((row) => handoverView(row, names)),
    colleagues,
  };
}

export interface ShiftDetailView {
  shift: ShiftView;
  locationName: string;
}

export async function getShiftDetail(shiftId: string): Promise<ShiftDetailView | null> {
  const ctx = await requireShiftActor();
  const shift = await db.shift.findFirst({
    where: { id: shiftId, tenantId: ctx.tenantId },
    include: shiftInclude(),
  });
  if (!shift) return null;
  if (ctx.role !== "admin") {
    const user = await currentUser(ctx.tenantId, ctx.userId);
    const isParty =
      shift.assignedUserId === ctx.userId ||
      shift.handovers.some((handover) => handover.incomingUserId === ctx.userId);
    if (!isParty || user?.locationId !== shift.locationId) return null;
  }
  const names = await namesFor(ctx.tenantId, collectNameIds([shift]));
  return { shift: shiftView(shift, names), locationName: shift.location.name };
}

export interface EmployeeShiftStats {
  userId: string;
  fullName: string;
  shiftCount: number;
  closedCount: number;
  openCount: number;
  varianceCount: number;
  totalCashVariance: number;
  totalFloatVariance: number;
  awaitingHandover: number;
}

export interface ShiftBoardView {
  shifts: ShiftView[];
  awaitingHandovers: ShiftHandoverView[];
  stats: EmployeeShiftStats[];
  locations: Array<{ id: string; name: string; code: string }>;
  totals: {
    shifts: number;
    open: number;
    awaitingHandover: number;
    varianceOpen: number;
    closed: number;
    cashVariance: number;
    floatVariance: number;
  };
}

export async function getAdminShiftBoard(filters?: {
  dateFrom?: string;
  dateTo?: string;
  locationId?: string;
  employeeId?: string;
  status?: string;
}): Promise<ShiftBoardView> {
  const ctx = await requireTenantAdminMomo();

  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (filters?.locationId) where.locationId = filters.locationId;
  if (filters?.employeeId) where.assignedUserId = filters.employeeId;
  if (filters?.status && filters.status !== "all") where.status = filters.status;
  if (filters?.dateFrom || filters?.dateTo) {
    where.businessDate = {
      ...(filters?.dateFrom ? { gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) } : {}),
      ...(filters?.dateTo ? { lte: new Date(`${filters.dateTo}T23:59:59.999Z`) } : {}),
    };
  }

  const [shifts, handovers, locations, employees] = await Promise.all([
    db.shift.findMany({
      where,
      include: shiftInclude(),
      orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
    db.shiftHandover.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.location.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    db.user.findMany({
      where: { tenantId: ctx.tenantId, status: "active" },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
  ]);

  const names = await namesFor(ctx.tenantId, [
    ...collectNameIds(shifts),
    ...handovers.flatMap((row) => [row.outgoingUserId, row.incomingUserId]),
  ]);

  const statsById = new Map<string, EmployeeShiftStats>();
  for (const employee of employees) {
    statsById.set(employee.id, {
      userId: employee.id,
      fullName: employee.fullName,
      shiftCount: 0,
      closedCount: 0,
      openCount: 0,
      varianceCount: 0,
      totalCashVariance: 0,
      totalFloatVariance: 0,
      awaitingHandover: 0,
    });
  }
  for (const shift of shifts) {
    const stat = statsById.get(shift.assignedUserId);
    if (!stat) continue;
    stat.shiftCount += 1;
    if (shift.status === "closed") stat.closedCount += 1;
    if (shift.status === "open") stat.openCount += 1;
    if (shift.status === "awaiting_handover") stat.awaitingHandover += 1;
    if (shift.status === "variance_open") stat.varianceCount += 1;
    for (const handover of shift.handovers) {
      stat.totalCashVariance += Number(handover.cashVariance ?? 0);
      stat.totalFloatVariance += Number(handover.floatVariance ?? 0);
    }
  }

  const shiftViews = shifts.map((shift) => shiftView(shift, names));
  const handoverViews = handovers.map((row) => handoverView(row, names));
  const totals = {
    shifts: shifts.length,
    open: shifts.filter((shift) => shift.status === "open").length,
    awaitingHandover: shifts.filter((shift) => shift.status === "awaiting_handover").length,
    varianceOpen: shifts.filter((shift) => shift.status === "variance_open").length,
    closed: shifts.filter((shift) => shift.status === "closed").length,
    cashVariance: handoverViews.reduce((sum, row) => sum + (row.cashVariance ?? 0), 0),
    floatVariance: handoverViews.reduce((sum, row) => sum + (row.floatVariance ?? 0), 0),
  };

  return {
    shifts: shiftViews,
    awaitingHandovers: handoverViews.filter((row) => row.status === "awaiting_receipt"),
    stats: Array.from(statsById.values()).filter((stat) => stat.shiftCount > 0),
    locations,
    totals,
  };
}

/**
 * Safe shift aggregation for one daily account: counts and variance totals
 * only. Shift cash/float balances are never summed into the daily close.
 */
export async function getDailyAccountShiftSummary(
  accountId: string
): Promise<DailyAccountShiftAggregate> {
  const ctx = await requireTenantAdminMomo();
  return shiftAggregateForDailyAccount(accountId, ctx.tenantId);
}

export async function getShiftEmployees() {
  const ctx = await requireShiftActor();
  const users = await db.user.findMany({
    where: { tenantId: ctx.tenantId, status: "active", role: { in: ["worker", "admin"] } },
    select: { id: true, fullName: true, role: true, locationId: true },
    orderBy: { fullName: "asc" },
  });
  return users;
}
