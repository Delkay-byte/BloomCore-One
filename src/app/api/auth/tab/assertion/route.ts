import { NextResponse } from "next/server";
import { createTabAssertion } from "@/lib/security/tab-assertion";
import { verifyTabProof } from "@/lib/security/tab-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/tab/assertion
 *
 * Refresh the 120-second route-gating assertion using the tab's
 * proof-of-possession key. The assertion is not a data credential; this route
 * still requires a valid signed proof and live SessionRecord.
 */
export async function POST(): Promise<Response> {
  const verified = await verifyTabProof("any");
  if (!verified) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const assertion = await createTabAssertion({
    sessionId: verified.sessionId,
    module: verified.module,
    payload: verified.payload,
  });
  return NextResponse.json(
    {
      assertion,
      assertionExpiresIn: 120,
      module: verified.module,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
