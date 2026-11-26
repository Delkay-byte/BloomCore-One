import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { collectAnomalyFindings, persistAnomalyFindings } from "@/lib/anomaly-scan";

/**
 * Scheduled anomaly scan.
 *
 * Monitoring used to run only when someone opened the screen and pressed scan,
 * which is the opposite of monitoring. This route is the trigger: a scheduler calls
 * it with a shared secret, it scans each business in turn, and every run is
 * recorded so a failure is visible.
 *
 * It is disabled until `ANOMALY_SCAN_TOKEN` is set, refuses every request without
 * it, and does bounded work per call: at most `limit` businesses and a 30-day
 * window each, so one slow business cannot stall the fleet.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function dayKey(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export async function POST(request: NextRequest): Promise<Response> {
  const secret = (process.env.ANOMALY_SCAN_TOKEN ?? "").trim();
  if (!secret) return new Response("Not configured", { status: 503 });

  const provided =
    request.headers.get("x-scan-token") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(provided.trim(), secret)) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 10)), 50);
  const period = { from: dayKey(29), to: dayKey(0) };

  const tenants = await db.businessTenant.findMany({
    where: { status: "ACTIVE", momoEnabled: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const results: Array<{
    tenantId: string;
    scanned: number;
    created: number;
    reopened: number;
    suppressed: number;
    notified: number;
  }> = [];
  const failures: Array<{ tenantId: string; error: string }> = [];

  for (const tenant of tenants) {
    try {
      const now = new Date();
      const findings = await collectAnomalyFindings(tenant.id, period, now);
      const summary = await persistAnomalyFindings({
        tenantId: tenant.id,
        actorId: null,
        trigger: "scheduled",
        period,
        findings,
        now,
      });
      results.push({
        tenantId: tenant.id,
        scanned: summary.scanned,
        created: summary.created,
        reopened: summary.reopened,
        suppressed: summary.suppressed,
        notified: summary.notified,
      });
    } catch (error) {
      // Never persist or return a raw exception: Prisma errors can carry query
      // metadata, identifiers and values. The error class is enough for triage.
      const name = error instanceof Error ? error.name : "UnknownError";
      const message = `Scan failed (${name})`;
      failures.push({ tenantId: tenant.id, error: message });
      await db.anomalyScanRun.create({
        data: {
          tenantId: tenant.id,
          trigger: "scheduled",
          status: "failed",
          finishedAt: new Date(),
          periodFrom: period.from,
          periodTo: period.to,
          error: message.slice(0, 300),
        },
      });
    }
  }

  return NextResponse.json({
    ok: failures.length === 0,
    period,
    tenants: tenants.length,
    scanned: results.length,
    created: results.reduce((sum, row) => sum + row.created, 0),
    reopened: results.reduce((sum, row) => sum + row.reopened, 0),
    suppressed: results.reduce((sum, row) => sum + row.suppressed, 0),
    notified: results.reduce((sum, row) => sum + row.notified, 0),
    results,
    failures,
  });
}
