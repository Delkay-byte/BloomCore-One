import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext } from "@/lib/tenant";

/**
 * GET /api/user/[id]
 *
 * Isolation: the target user must belong to the authenticated tenant. Workers
 * and collectors may only read their own record; tenant administrators may read
 * staff within their own business. A user id from another tenant resolves to
 * 404 regardless of the caller's role.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx =
    (await getApiTenantContext("admin")) ??
    (await getApiTenantContext("momo")) ??
    (await getApiTenantContext("susu"));

  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  // Non-administrators may only read their own record.
  if (ctx.role !== "admin" && ctx.userId !== id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const user = await db.user.findFirst({
    where: { id, tenantId: ctx.tenantId },
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      locationId: true,
      location: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(user);
}
