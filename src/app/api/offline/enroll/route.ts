import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";

/**
 * POST /api/offline/enroll
 * Register a device for offline operation.
 * Idempotent — re-enrolling the same device is safe.
 *
 * Isolation fixes:
 *   * The tenant is resolved from the session, and the requested module must be
 *     entitled for that tenant (a Susu-only agency cannot enroll a MoMo device).
 *   * The upsert is scoped by (deviceId, tenantId). Previously the update branch
 *     matched on deviceId alone and never verified ownership, so any
 *     authenticated user could re-activate a device belonging to another
 *     business by replaying its deviceId (a straight IDOR).
 */
export async function POST(request: NextRequest) {
  try {
    const { deviceId, module: mod, deviceName } = await request.json();

    if (!deviceId || !mod) {
      return NextResponse.json(
        { error: "Missing deviceId or module" },
        { status: 400 }
      );
    }
    if (mod !== "momo" && mod !== "susu") {
      return NextResponse.json({ error: "Invalid module" }, { status: 400 });
    }

    // Resolve the tenant with the requested module required, so module
    // entitlement is enforced from the tenant record, not the request body.
    const ctx = await getApiTenantContext("momo", mod as "momo" | "susu");
    const susuCtx =
      ctx ?? (await getApiTenantContext("susu", mod as "momo" | "susu"));
    const adminCtx =
      susuCtx ?? (await getApiTenantContext("admin", mod as "momo" | "susu"));
    const effective = ctx ?? susuCtx ?? adminCtx;

    if (!effective) {
      return NextResponse.json(
        { error: "Not authenticated or module not enabled" },
        { status: 401 }
      );
    }

    // Existing enrollment for THIS tenant only.
    const existing = await db.deviceEnrollment.findFirst({
      where: { deviceId, tenantId: effective.tenantId },
    });

    // A deviceId enrolled to a different business cannot be taken over.
    if (!existing) {
      const foreign = await db.deviceEnrollment.findUnique({
        where: { deviceId },
        select: { id: true },
      });
      if (foreign) {
        return NextResponse.json(
          { error: "Device is enrolled to another business" },
          { status: 409 }
        );
      }
    }

    const device = existing
      ? await db.deviceEnrollment.update({
          where: { id: existing.id },
          data: {
            status: "active",
            lastSyncAt: new Date(),
            authorizedAt: new Date(),
          },
        })
      : await db.deviceEnrollment.create({
          data: {
            tenantId: effective.tenantId,
            userId: effective.userId,
            deviceId,
            deviceName: deviceName || null,
            module: mod,
            status: "active",
            authorizedAt: new Date(),
          },
        });

    await createAuditLog({
      userId: effective.userId,
      action: "offline.device_enrolled",
      entityType: "device",
      entityId: device.id,
      details: { deviceId, module: mod },
    });

    return NextResponse.json({ success: true, deviceId: device.deviceId });
  } catch (err) {
    console.error("[offline-enroll]", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/offline/enroll
 * Check if a device is enrolled for the authenticated tenant.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");

  if (!deviceId) {
    return NextResponse.json({ error: "Missing deviceId" }, { status: 400 });
  }

  const ctx =
    (await getApiTenantContext("momo")) ??
    (await getApiTenantContext("susu")) ??
    (await getApiTenantContext("admin"));

  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const device = await db.deviceEnrollment.findFirst({
    where: {
      deviceId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      status: "active",
    },
    select: { deviceId: true, lastSyncAt: true, createdAt: true },
  });

  return NextResponse.json({ enrolled: !!device, device });
}
