import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Readiness endpoint — proves the running instance can actually reach the
 * PostgreSQL database it was configured with.
 *
 *   curl https://<host>/api/health/ready
 *
 * `/api/health` stays a pure liveness probe (fast, never touches the pool) so
 * a database outage cannot put the Render service into a restart loop. This
 * endpoint is the one to use when verifying a database move.
 *
 * Returns 200 with `database: "ok"` when a trivial query succeeds, 503 with
 * `database: "error"` when it does not. No connection details are exposed.
 */

export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 5000;

function deployedCommitSha(): string | null {
  return (
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.SOURCE_VERSION ||
    null
  );
}

export async function GET() {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("database probe timed out")), DB_TIMEOUT_MS);
    });

    await Promise.race([db.$queryRaw`SELECT 1`, timeout]);

    return NextResponse.json(
      {
        status: "ready",
        database: "ok",
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        app: "bik-prestige",
        env: process.env.APP_ENV || process.env.NODE_ENV || "unknown",
        commit: deployedCommitSha(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      {
        status: "not_ready",
        database: "error",
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        app: "bik-prestige",
        commit: deployedCommitSha(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
