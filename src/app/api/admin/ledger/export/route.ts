import { NextRequest, NextResponse } from "next/server";
import { getApiTenantContext } from "@/lib/tenant";
import { exportLedgerCsv } from "@/lib/actions/momo-ledger.actions";

/**
 * Tenant-scoped ledger CSV export.
 *
 * The tenant is resolved from the verified administrator session; query
 * parameters only narrow the scope within that tenant. A missing or non-admin
 * session is refused rather than redirected so a download never returns HTML.
 */
export async function GET(request: NextRequest) {
  const ctx = await getApiTenantContext("admin", "momo");
  if (!ctx || ctx.role !== "admin") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const read = (key: string) => params.get(key)?.trim() || undefined;

  try {
    const result = await exportLedgerCsv({
      locationId: read("locationId"),
      workerId: read("workerId"),
      type: read("type"),
      network: read("network"),
      status: read("status"),
      dateFrom: read("dateFrom"),
      dateTo: read("dateTo"),
    });
    return new NextResponse(result.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new NextResponse("The export could not be generated.", { status: 500 });
  }
}
