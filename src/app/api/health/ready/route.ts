import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Readiness probe: proves the instance can reach the database it was configured
 * with. Returns 503 when it cannot, so a broken deployment is visible.
 *
 * SEC-10: the public response contains only a status. Database latency,
 * connection information, environment names and commit SHAs stay out of it. The
 * sanitized failure reason goes to the server log so an operator can diagnose
 * without leaking internals to anonymous callers.
 */

export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 5000;

export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("database probe timed out")), DB_TIMEOUT_MS);
    });

    await Promise.race([db.$queryRaw`SELECT 1`, timeout]);

    return NextResponse.json(
      { status: "ready" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // Server-side only; the class name is enough for an operator to triage and
    // carries no connection string, credential or stack trace.
    console.error("readiness_probe_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { status: "not_ready" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
