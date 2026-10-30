import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";

/**
 * GET /api/admin/devices
 * List enrolled devices for the authenticated tenant (admin only).
 *
 * Isolation: the device list is scoped to the tenant resolved from the server
 * session. The previous version used getAdminSession() without verifying the
 * account was still active or that its token version matched, and returned
 * every device on the platform.
 */
export async function GET() {
  const ctx = await getApiTenantContext("admin");
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const devices = await db.deviceEnrollment.findMany({
    where: { tenantId: ctx.tenantId },
    include: {
      user: {
        select: { id: true, fullName: true, email: true, role: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ devices });
}

/**
 * PATCH /api/admin/devices
 * Revoke or reactivate a device owned by the authenticated tenant.
 */
export async function PATCH(request: NextRequest) {
  const ctx = await getApiTenantContext("admin");
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { deviceId, action } = await request.json();

  if (!deviceId || !action) {
    return NextResponse.json(
      { error: "Missing deviceId or action" },
      { status: 400 }
    );
  }

  if (action !== "revoke" && action !== "activate") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  // Tenant-scoped lookup: a device belonging to another business is simply
  // "not found" here, so it can never be revoked by this tenant.
  const device = await db.deviceEnrollment.findFirst({
    where: { deviceId, tenantId: ctx.tenantId },
  });

  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const newStatus = action === "revoke" ? "revoked" : "active";

  await db.deviceEnrollment.update({
    where: { id: device.id },
    data: { status: newStatus },
  });

  await createAuditLog({
    userId: ctx.userId,
    action:
      action === "revoke" ? "offline.device_revoked" : "offline.device_activated",
    entityType: "device",
    entityId: device.id,
    details: {
      deviceId,
      targetUserId: device.userId,
      module: device.module,
      previousStatus: device.status,
      newStatus,
    },
  });

  return NextResponse.json({ success: true, status: newStatus });
}
