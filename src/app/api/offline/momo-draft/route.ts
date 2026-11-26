import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext, type TenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import { consumeRateLimit, retryAfterSeconds } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { idempotencyKeyIsValid } from "@/lib/offline/payload";
import {
  isStaleBusinessDate,
  normalizeMomoDay,
  summarizeMomoDay,
} from "@/lib/offline/momo-draft";

/**
 * POST /api/offline/momo-draft
 *
 * Parks a MoMo day captured on a device without a connection.
 *
 * This route posts nothing. No ledger row, transaction, balance or daily account is
 * created, edited or submitted: the draft is a record of what the agent saw, so the
 * day can be completed online and an owner can see that it was captured late.
 *
 * The guarantees mirror the contribution sync: same-origin, tenant resolved from the
 * session, enrolled and recently authorised device, per-user rate limit, and an
 * idempotency key bound to the exact canonical payload so a retry cannot change the
 * figures and a replay cannot create a second draft.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) return crossOriginDenied();

    const body = await request.json();
    const { idempotencyKey, payload, deviceId } = body ?? {};
    if (!idempotencyKey || !payload || !deviceId) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    const ctx: TenantContext | null =
      (await getApiTenantContext("momo", "momo")) ??
      (await getApiTenantContext("admin", "momo"));
    if (!ctx) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });
    }

    const rate = await consumeRateLimit("offline:momo-draft", ctx.userId, RATE_LIMITS.offlineSync);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Too many synchronization attempts. Please wait and try again.",
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": retryAfterSeconds(rate) } }
      );
    }

    const device = await db.deviceEnrollment.findFirst({
      where: { deviceId, userId: ctx.userId, tenantId: ctx.tenantId, status: "active" },
    });
    if (!device) {
      await createAuditLog({
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "offline.momo_draft_rejected",
        entityType: "device",
        entityId: deviceId,
        details: { reason: "Device not enrolled or revoked", deviceId },
      });
      return NextResponse.json(
        { success: false, error: "Device not enrolled or revoked", code: "device_revoked" },
        { status: 403 }
      );
    }

    const OFFLINE_AUTH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
    const authorizedAt = device.authorizedAt ?? device.createdAt;
    if (Date.now() - new Date(authorizedAt).getTime() > OFFLINE_AUTH_TIMEOUT_MS) {
      return NextResponse.json(
        {
          success: false,
          error: "Offline authorization expired. Please reconnect and sign in again.",
          code: "offline_auth_expired",
        },
        { status: 403 }
      );
    }

    if (!idempotencyKeyIsValid(idempotencyKey)) {
      return NextResponse.json(
        { success: false, error: "Invalid idempotency key" },
        { status: 400 }
      );
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(payload);
    } catch {
      return NextResponse.json({ success: false, error: "Invalid capture payload" }, { status: 400 });
    }

    const normalized = normalizeMomoDay(rawPayload);
    if (!normalized.ok) {
      return NextResponse.json({ success: false, error: normalized.error }, { status: 400 });
    }

    // The branch must belong to this business, and the caller must be assigned to it.
    // A captured location id from another tenant would otherwise park work elsewhere.
    const location = await db.location.findFirst({
      where: { id: normalized.day.locationId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!location) {
      return NextResponse.json(
        { success: false, error: "That branch does not belong to this business." },
        { status: 403 }
      );
    }
    const caller = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true, role: true },
    });
    if (!caller || (caller.role !== "admin" && caller.locationId !== location.id)) {
      return NextResponse.json(
        { success: false, error: "You are not assigned to that branch." },
        { status: 403 }
      );
    }

    // The plain key is stored so one key can only ever mean one capture. A retry that
    // carries different figures is refused, not merged and not duplicated.
    const existing = await db.momoOfflineDraft.findFirst({
      where: { tenantId: ctx.tenantId, idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== ctx.userId) {
        return NextResponse.json(
          { success: false, error: "Capture key is not available" },
          { status: 409 }
        );
      }
      if (existing.payloadHash !== normalized.hash) {
        return NextResponse.json(
          {
            success: false,
            error: "This capture was already received with different figures. Nothing was changed.",
            code: "payload_mismatch",
          },
          { status: 409 }
        );
      }
      return NextResponse.json({
        success: true,
        draftId: existing.id,
        status: existing.status,
        message: "This capture was already received",
      });
    }

    const businessDate = new Date(`${normalized.day.businessDate}T00:00:00.000Z`);

    // A day that already exists on the server is a conflict the reviewer must see: the
    // device may have captured figures while another device changed the same day.
    const account = await db.dailyAccount.findFirst({
      where: {
        tenantId: ctx.tenantId,
        locationId: location.id,
        businessDate,
      },
      select: { id: true, workerId: true, status: true, updatedAt: true },
    });
    const stale = isStaleBusinessDate(normalized.day.businessDate);
    const conflictReason = account
      ? account.workerId === ctx.userId
        ? account.status === "draft"
          ? `A daily account already exists for ${normalized.day.businessDate} and is still a draft. Open it online instead of applying this capture.`
          : `The daily account for ${normalized.day.businessDate} was already submitted. This capture is kept for review and cannot be applied.`
        : `Another employee already opened ${normalized.day.businessDate}. This capture is kept for review.`
      : stale
        ? `This capture is older than the allowed window and needs a reviewer.`
        : null;

    const created = await db.momoOfflineDraft.create({
      data: {
        tenantId: ctx.tenantId,
        locationId: location.id,
        userId: ctx.userId,
        deviceId,
        businessDate,
        payloadJson: normalized.canonical,
        payloadHash: normalized.hash,
        idempotencyKey,
        status: conflictReason ? "needs_review" : "pending",
        conflictReason,
      },
    });

    const totals = summarizeMomoDay(normalized.day);
    await createAuditLog({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "offline.momo_draft_received",
      entityType: "momoOfflineDraft",
      entityId: created.id,
      details: {
        businessDate: normalized.day.businessDate,
        locationId: location.id,
        deviceId,
        status: created.status,
        conflict: Boolean(conflictReason),
        activityCount: totals.activityCount,
        // The capture is not a posting, and this row says so.
        financialMutation: false,
        posted: false,
      },
    });

    return NextResponse.json({
      success: true,
      draftId: created.id,
      status: created.status,
      conflictReason,
      // Stated explicitly for the device UI: nothing was posted.
      posted: false,
      message: conflictReason
        ? "Captured. A reviewer needs to look at this day before it can be applied."
        : "Captured. Complete the day online when you reconnect.",
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "The capture could not be stored." },
      { status: 500 }
    );
  }
}
