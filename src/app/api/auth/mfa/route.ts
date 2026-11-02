import { NextResponse } from "next/server";
import { getAdminSession, isSessionCurrent } from "@/lib/auth";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { db } from "@/lib/db";

/**
 * GET /api/auth/mfa — report whether the signed-in account has MFA enabled.
 * Used only to render the settings card; it exposes no secret material.
 */
export async function GET() {
  const admin = await getAdminSession();
  if (admin && (await isSessionCurrent(admin))) {
    const user = await db.user.findUnique({
      where: { id: admin.userId },
      select: { mfaEnabled: true },
    });
    return NextResponse.json(
      { enabled: Boolean(user?.mfaEnabled) },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const platform = await getPlatformAdminOrNull();
  if (platform) {
    const adminRow = await db.platformSuperAdmin.findUnique({
      where: { id: platform.adminId },
      select: { mfaEnabled: true },
    });
    return NextResponse.json(
      { enabled: Boolean(adminRow?.mfaEnabled) },
      { headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
}
