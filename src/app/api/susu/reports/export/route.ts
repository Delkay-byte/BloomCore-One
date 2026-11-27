import { NextRequest, NextResponse } from "next/server";
import { getApiTenantContext } from "@/lib/tenant";
import { exportSusuReport } from "@/lib/actions/susu-reporting.actions";
import { exportRateLimitResponse } from "@/lib/security/export-rate-limit";

export async function GET(request: NextRequest) {
  const ctx = await getApiTenantContext("admin", "susu");
  if (!ctx || ctx.role !== "admin") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const read = (key: string) => params.get(key)?.trim() || undefined;

  const result = await exportSusuReport({
    report: (read("report") || "contributions") as "contributions" | "collectors" | "branches" | "cycles",
    branchId: read("branchId"),
    dateFrom: read("dateFrom"),
    dateTo: read("dateTo"),
    collectorId: read("collectorId"),
    accountId: read("accountId"),
    cycleId: read("cycleId"),
    channel: read("channel"),
    reversalStatus: (read("reversalStatus") as "all" | "reversed" | "notReversed") || "all",
    status: read("status") as string | undefined,
  });

  if (!result.success) {
    if (result.error === "EXPORT_RATE_LIMITED") {
      return exportRateLimitResponse({
        error: "Too many export requests. Try again shortly.",
        status: 429,
        retryAfter: result.retryAfter ?? 1,
      });
    }
    if (result.error) {
      return new NextResponse("The export could not be generated.", { status: 400 });
    }
    return new NextResponse("The export could not be generated.", { status: 500 });
  }

  const report = result.data!;
  return new NextResponse(report.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
