import { NextRequest, NextResponse } from "next/server";
import { exportAssociationReport } from "@/lib/actions/association-governance.actions";
import { isAssociationExportType } from "@/lib/association-governance";
import { getApiTenantContext } from "@/lib/tenant";
import {
  enforceExportRateLimit,
  exportRateLimitResponse,
} from "@/lib/security/export-rate-limit";

/**
 * Association report export.
 *
 * The report is built by the same server action the screen calls, so it is
 * tenant-scoped by construction. The route only chooses the format.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const type = request.nextUrl.searchParams.get("type") ?? "";
  if (!isAssociationExportType(type)) {
    return NextResponse.json({ error: "Unknown report." }, { status: 400 });
  }

  // Authorise before consuming any quota. The bucket is the authenticated
  // actor plus the server-resolved tenant; `type` cannot change its scope.
  const ctx = await getApiTenantContext("admin");
  if (!ctx || ctx.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const limited = await enforceExportRateLimit("association", ctx.userId, ctx.tenantId);
  if (limited) return exportRateLimitResponse(limited);

  try {
    const result = await exportAssociationReport(type);
    if (!result.success || !result.csv) {
      return NextResponse.json(
        { error: result.error ?? "The report could not be built." },
        { status: 403 }
      );
    }
    return new Response(result.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename ?? `association-${type}.csv`}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
}
