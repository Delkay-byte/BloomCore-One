"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireTenantWorker, requireTenantAdmin } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { normalizeMomoDay, summarizeMomoDay, type NormalizedMomoDay } from "@/lib/offline/momo-draft";

/**
 * Completing an offline MoMo capture.
 *
 * A draft becomes `applied` only when the worker has actually saved the real daily
 * account online: these actions never write a financial figure themselves. The saved
 * account was produced by the ordinary daily-account path, with its ordinary
 * authorisation, validation and audit; this module only records that the capture was
 * folded into it, or that a reviewer rejected it.
 */

export interface MomoDraftView {
  id: string;
  businessDate: string;
  locationName: string;
  status: "pending" | "applied" | "rejected" | "needs_review";
  conflictReason: string | null;
  capturedAt: string;
  capturedBy: string;
  deviceId: string;
  appliedAccountId: string | null;
  reviewNote: string | null;
  totals: {
    cashIn: number;
    cashOut: number;
    commission: number;
    expense: number;
    activityCount: number;
  };
  day: NormalizedMomoDay | null;
}

export interface MomoDraftResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

function decode(payloadJson: string): NormalizedMomoDay | null {
  // The stored payload is the canonical day; parse defensively so one corrupt row
  // cannot break a whole list.
  const parsed = normalizeMomoDay(parseCanonical(payloadJson));
  return parsed.ok ? parsed.day : null;
}

/**
 * The canonical string is not JSON. It is decoded back into the same shape the
 * normaliser produced so the screen can show individual activities.
 */
function parseCanonical(canonical: string): unknown {
  const parts = canonical.split("|");
  if (parts.length < 9) return null;
  const [businessDate, locationId, oc, of, cc, cf, captureSource, note, activitiesRaw] = parts;
  const activities = (activitiesRaw ?? "")
    .split("|")
    .filter(Boolean)
    .map((row) => {
      const [kind, network, amountMinor, reference, activityNote, evidenceRef] = row.split("~");
      return {
        kind,
        network,
        amount: Number(amountMinor) / 100,
        reference: reference || null,
        note: activityNote || null,
        evidenceRef: evidenceRef || null,
      };
    });
  return {
    businessDate,
    locationId,
    openingCash: Number(oc) / 100,
    openingFloat: Number(of) / 100,
    closingCash: Number(cc) / 100,
    closingFloat: Number(cf) / 100,
    captureSource,
    note: note || null,
    activities,
  };
}

function toView(row: {
  id: string;
  businessDate: Date;
  status: string;
  conflictReason: string | null;
  createdAt: Date;
  deviceId: string;
  appliedAccountId: string | null;
  reviewNote: string | null;
  payloadJson: string;
  user?: { fullName: string | null } | null;
  locationName?: string | null;
}): MomoDraftView {
  const day = decode(row.payloadJson);
  const totals = day
    ? summarizeMomoDay(day)
    : { cashInMinor: 0, cashOutMinor: 0, commissionMinor: 0, expenseMinor: 0, activityCount: 0 };
  return {
    id: row.id,
    businessDate: row.businessDate.toISOString().slice(0, 10),
    locationName: row.locationName ?? "Branch",
    status: row.status as MomoDraftView["status"],
    conflictReason: row.conflictReason,
    capturedAt: row.createdAt.toISOString(),
    capturedBy: row.user?.fullName ?? "Employee",
    deviceId: row.deviceId,
    appliedAccountId: row.appliedAccountId,
    reviewNote: row.reviewNote,
    totals: {
      cashIn: totals.cashInMinor,
      cashOut: totals.cashOutMinor,
      commission: totals.commissionMinor,
      expense: totals.expenseMinor,
      activityCount: totals.activityCount,
    },
    day,
  };
}

/** Branch names for a set of location ids, scoped to one business. */
async function locationNameMap(tenantId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db.location.findMany({
    where: { tenantId, id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The worker's own captures, newest first. */
export async function getMyMomoDrafts(): Promise<MomoDraftResponse<MomoDraftView[]>> {
  const ctx = await requireTenantWorker();
  const rows = await db.momoOfflineDraft.findMany({
    where: { tenantId: ctx.tenantId, userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const locationNames = await locationNameMap(ctx.tenantId, rows.map((r) => r.locationId));
  return {
    success: true,
    data: rows.map((row) =>
      toView({ ...row, user: null, locationName: locationNames.get(row.locationId) ?? null })
    ),
  };
}

/** The administrator's review queue across the business. */
export async function getMomoDraftsForReview(
  status?: string
): Promise<MomoDraftResponse<MomoDraftView[]>> {
  const ctx = await requireTenantAdmin();
  const filter = ["pending", "applied", "rejected", "needs_review"].includes(status ?? "")
    ? status
    : undefined;
  const rows = await db.momoOfflineDraft.findMany({
    where: { tenantId: ctx.tenantId, ...(filter ? { status: filter } : {}) },
    orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  const locationNames = await locationNameMap(ctx.tenantId, rows.map((r) => r.locationId));
  const names = new Map(
    (
      await db.user.findMany({
        where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: { id: true, fullName: true },
      })
    ).map((u) => [u.id, u.fullName])
  );
  return {
    success: true,
    data: rows.map((row) =>
      toView({
        ...row,
        user: { fullName: names.get(row.userId) ?? null },
        locationName: locationNames.get(row.locationId) ?? null,
      })
    ),
  };
}

/**
 * Record that a capture has been folded into a real, saved daily account.
 *
 * The checks are deliberately strict, because this is the only place that can claim a
 * draft was applied: the account must exist in this business, belong to the caller,
 * cover the same branch and business day, and have been saved after the capture was
 * made. Otherwise the draft stays exactly where it was.
 */
export async function applyMomoDraft(input: {
  draftId: string;
  accountId: string;
}): Promise<MomoDraftResponse<{ draftId: string; status: string }>> {
  const ctx = await requireTenantWorker();

  const draft = await db.momoOfflineDraft.findFirst({
    where: { id: input.draftId, tenantId: ctx.tenantId },
  });
  if (!draft) return { success: false, error: "That capture was not found." };
  if (draft.userId !== ctx.userId) {
    return { success: false, error: "This capture belongs to another employee." };
  }
  if (draft.status === "applied") {
    return { success: true, data: { draftId: draft.id, status: draft.status } };
  }
  if (draft.status === "rejected") {
    return { success: false, error: "A reviewer rejected this capture. It cannot be applied." };
  }
  if (draft.status === "needs_review") {
    return {
      success: false,
      error:
        draft.conflictReason ??
        "A reviewer must resolve this capture before it can be applied.",
    };
  }

  const account = await db.dailyAccount.findFirst({
    where: { id: input.accountId, tenantId: ctx.tenantId },
    select: {
      id: true,
      workerId: true,
      locationId: true,
      businessDate: true,
      status: true,
      updatedAt: true,
    },
  });
  if (!account) return { success: false, error: "Daily account not found." };
  if (account.workerId !== ctx.userId) {
    return { success: false, error: "You cannot apply a capture to another employee's day." };
  }
  if (account.locationId !== draft.locationId) {
    return { success: false, error: "That account is for a different branch." };
  }
  if (account.businessDate.getTime() !== draft.businessDate.getTime()) {
    return { success: false, error: "That account is for a different business day." };
  }
  if (account.updatedAt.getTime() < draft.createdAt.getTime()) {
    return {
      success: false,
      error: "Save today's figures first, then apply the capture.",
    };
  }

  await db.$transaction(async (tx) => {
    await tx.momoOfflineDraft.update({
      where: { id: draft.id },
      data: {
        status: "applied",
        appliedAccountId: account.id,
        appliedAt: new Date(),
      },
    });
    await createAuditLogTx(
      tx,
      {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "offline.momo_draft_applied",
        entityType: "momoOfflineDraft",
        entityId: draft.id,
        details: {
          accountId: account.id,
          businessDate: draft.businessDate.toISOString().slice(0, 10),
          accountStatus: account.status,
          // The account was written by the ordinary daily-account path; this action
          // only links the capture to it.
          financialMutation: false,
        },
      }
    );
  });

  revalidatePath("/worker/daily");
  return { success: true, data: { draftId: draft.id, status: "applied" } };
}

/** An administrator rejects a capture with a reason. Nothing financial changes. */
export async function rejectMomoDraft(input: {
  draftId: string;
  reason: string;
}): Promise<MomoDraftResponse<{ draftId: string; status: string }>> {
  const ctx = await requireTenantAdmin();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }

  const draft = await db.momoOfflineDraft.findFirst({
    where: { id: input.draftId, tenantId: ctx.tenantId },
  });
  if (!draft) return { success: false, error: "That capture was not found." };
  if (draft.status === "applied") {
    return {
      success: false,
      error: "This capture was already applied to a saved account and cannot be rejected.",
    };
  }
  if (draft.status === "rejected") {
    return { success: true, data: { draftId: draft.id, status: draft.status } };
  }

  await db.$transaction(async (tx) => {
    await tx.momoOfflineDraft.update({
      where: { id: draft.id },
      data: {
        status: "rejected",
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
        reviewNote: reason,
      },
    });
    await createAuditLogTx(
      tx,
      {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "offline.momo_draft_rejected_by_review",
        entityType: "momoOfflineDraft",
        entityId: draft.id,
        details: {
          reason,
          businessDate: draft.businessDate.toISOString().slice(0, 10),
          financialMutation: false,
        },
      }
    );
  });

  return { success: true, data: { draftId: draft.id, status: "rejected" } };
}

/**
 * An administrator clears a conflict after checking the day, so the employee can
 * apply the capture. The reason is required and audited; nothing financial changes.
 */
export async function clearMomoDraftConflict(input: {
  draftId: string;
  reason: string;
}): Promise<MomoDraftResponse<{ draftId: string; status: string }>> {
  const ctx = await requireTenantAdmin();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }

  const draft = await db.momoOfflineDraft.findFirst({
    where: { id: input.draftId, tenantId: ctx.tenantId },
  });
  if (!draft) return { success: false, error: "That capture was not found." };
  if (draft.status !== "needs_review") {
    return { success: false, error: "This capture has no conflict to clear." };
  }

  await db.$transaction(async (tx) => {
    await tx.momoOfflineDraft.update({
      where: { id: draft.id },
      data: {
        status: "pending",
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
        reviewNote: reason,
        conflictReason: null,
      },
    });
    await createAuditLogTx(
      tx,
      {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "offline.momo_draft_conflict_cleared",
        entityType: "momoOfflineDraft",
        entityId: draft.id,
        details: { reason, financialMutation: false },
      }
    );
  });

  return { success: true, data: { draftId: draft.id, status: "pending" } };
}
