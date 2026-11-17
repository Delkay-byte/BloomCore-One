import { NextResponse } from "next/server";

/**
 * Public liveness probe.
 *
 * Render uses this as the health check path, so it must stay honest and cheap:
 * it returns 200 while the process can answer requests, and it never touches the
 * database (a database blip must not restart the service).
 *
 * SEC-10: the response carries no commit SHA, no environment name, no
 * configuration and no diagnostics. Deployment identity is available from the
 * Render deploy record and from server-side logs. A private, authenticated
 * operator endpoint can expose detail; the public surface must not.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "ok" },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
