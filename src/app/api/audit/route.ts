import { NextRequest, NextResponse } from "next/server";
import { getApiTenantContext } from "@/lib/tenant";
import { db } from "@/lib/db";

/**
 * GET /api/audit
 *
 * Tenant-scoped audit history for the authenticated business administrator.
 *
 * Isolation: results are filtered by the tenant resolved from the server
 * session. A tenant administrator can never read another business's audit
 * trail, and the platform audit trail (PlatformAuditLog) is a separate table
 * that is never exposed here.
 *
 * Previously this endpoint returned every audit row in the database and did
 * not re-validate the session against the database. Both are fixed.
 */
export async function GET(request: NextRequest) {
  const ctx = await getApiTenantContext("admin");
  if (!ctx) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("limit") || "30", 10) || 30)
  );
  const skip = (page - 1) * limit;

  const where = { tenantId: ctx.tenantId };

  const [logs, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.auditLog.count({ where }),
  ]);

  return NextResponse.json({ logs, total, page, limit });
}
