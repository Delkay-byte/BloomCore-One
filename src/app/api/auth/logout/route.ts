import { NextResponse } from "next/server";
import { getAnyAuthUser, revokeSessionToken } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";

/**
 * POST /api/auth/logout
 *
 * Revoke only the session presented by THIS tab's transport header. The client
 * then clears its own worker mapping. Other tabs keep their own sessions.
 *
 * There is no ambient cookie credential, and the custom header is not sent by
 * cross-site forms, so a cross-site request cannot log the user out.
 */
export async function POST() {
  const session = await getAnyAuthUser();
  if (session) {
    await revokeSessionToken(session, "logout");
    await createAuditLog({
      userId: session.userId,
      action: "auth.logout",
      entityType: session.role === "customer" ? "customer" : "user",
      entityId: session.userId,
    });
  }
  return NextResponse.json(
    { success: true },
    { headers: { "cache-control": "no-store" } }
  );
}
