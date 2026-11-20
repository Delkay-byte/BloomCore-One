import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext, type TenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import { consumeRateLimit, retryAfterSeconds } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { idempotencyKeyIsValid } from "@/lib/offline/payload";
import { normalizeOfflineRequest } from "@/lib/offline/request-payload";

/**
 * POST /api/offline/sync-request
 *
 * Accepts an offline capture that would move money and stores it as a REQUEST.
 * Nothing is posted here: a withdrawal, a cash handover or a reversal needs a
 * live administrator decision, so the record waits in the offline request queue
 * until one is made.
 *
 * The route mirrors the contribution sync's guarantees: same-origin, session
 * resolved tenant, enrolled device, per-user rate limit, and an idempotency key
 * bound to the exact normalized payload so a retry cannot change the request and
 * a replay cannot create a second one.
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
      (await getApiTenantContext("susu", "susu")) ??
      (await getApiTenantContext("admin", "susu")) ??
      (await getApiTenantContext("momo", "susu"));
    if (!ctx) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });
    }

    const rate = await consumeRateLimit("offline:sync", ctx.userId, RATE_LIMITS.offlineSync);
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
        action: "offline.request_rejected",
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
      await createAuditLog({
        userId: ctx.userId,
        action: "offline.request_rejected",
        entityType: "device",
        entityId: device.id,
        details: { reason: "Offline authorization expired", deviceId },
      });
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
      return NextResponse.json({ success: false, error: "Invalid request payload" }, { status: 400 });
    }

    const normalized = normalizeOfflineRequest(rawPayload);
    if (!normalized.ok) {
      return NextResponse.json({ success: false, error: normalized.error }, { status: 400 });
    }

    // The stored key carries the digest, so a retry with a changed payload is
    // refused instead of silently rewriting the request behind the reviewer.
    const storedKey = `${idempotencyKey}:${normalized.hash.slice(0, 16)}`;
    const existing = await db.offlineActionRequest.findFirst({
      where: { tenantId: ctx.tenantId, idempotencyKey: storedKey },
    });
    if (existing) {
      if (existing.requestedById !== ctx.userId) {
        return NextResponse.json(
          { success: false, error: "Request key is not available" },
          { status: 409 }
        );
      }
      return NextResponse.json({
        success: true,
        requestId: existing.id,
        status: existing.status,
        message: "This request was already received",
      });
    }

    // The subject must exist inside this tenant before a request about it is
    // stored: a foreign id would otherwise queue work against another business.
    if (normalized.request.kind === "withdrawal") {
      const account = await db.susuAccount.findFirst({
        where: { id: normalized.request.subjectId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!account) {
        return NextResponse.json({ success: false, error: "Account not found" }, { status: 404 });
      }
    } else if (normalized.request.kind === "remittance") {
      const collector = await db.collector.findFirst({
        where: { id: normalized.request.subjectId, tenantId: ctx.tenantId },
        select: { id: true, userId: true },
      });
      if (!collector) {
        return NextResponse.json({ success: false, error: "Collector not found" }, { status: 404 });
      }
      // A collector may only ask to hand in their own money.
      if (ctx.role !== "admin" && collector.userId !== ctx.userId) {
        return NextResponse.json(
          { success: false, error: "Not authorized for this collector" },
          { status: 403 }
        );
      }
    }

    const created = await db.offlineActionRequest.create({
      data: {
        tenantId: ctx.tenantId,
        kind: normalized.request.kind,
        payloadJson: JSON.stringify(normalized.request),
        status: "pending",
        deviceId,
        requestedById: ctx.userId,
        idempotencyKey: storedKey,
      },
      select: { id: true },
    });

    await createAuditLog({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "offline.request_captured",
      entityType: "offlineActionRequest",
      entityId: created.id,
      details: {
        kind: normalized.request.kind,
        amountMinor: normalized.request.amountMinor,
        deviceId,
        financialMutation: false,
        note: "Queued for online authorisation; nothing was posted.",
      },
    });

    return NextResponse.json({
      success: true,
      requestId: created.id,
      status: "pending",
      // Explicit: the capture is stored, not applied.
      posted: false,
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "The request could not be received" },
      { status: 500 }
    );
  }
}
