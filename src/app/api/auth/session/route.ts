import { NextResponse } from "next/server";
import {
  getAnyAuthUser,
  refreshSession,
  isSessionCurrent,
  SESSION_COOKIES,
  SESSION_POLICY,
  type ModuleName,
  type JwtPayload,
} from "@/lib/auth";

/**
 * GET /api/auth/session — returns current session timing status.
 * The client polls this to display inactivity/absolute warnings.
 *
 * POST /api/auth/session — refreshes the session's lastActivityAt
 * timestamp so the inactivity timer resets.  Only refreshes on
 * genuine authenticated requests, not artificial heartbeats.
 */

export async function GET() {
  const user = await getAnyAuthUser();
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  if (!(await isSessionCurrent(user))) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  const lastActivity = user.lastActivityAt ?? user.iat ?? now;

  return NextResponse.json({
    authenticated: true,
    userId: user.userId,
    role: user.role,
    secondsUntilInactivity: Math.max(
      0,
      SESSION_POLICY.INACTIVITY_TIMEOUT_SECONDS - (now - lastActivity)
    ),
    secondsUntilAbsolute: Math.max(
      0,
      (user.exp ?? now + SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS) - now
    ),
  });
}

export async function POST() {
  const user = await getAnyAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!(await isSessionCurrent(user))) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Determine which module cookie to refresh
  const modules: ModuleName[] = ["admin", "momo", "susu"];
  for (const mod of modules) {
    const refreshed = await refreshSession(mod);
    if (refreshed) break;
  }

  return NextResponse.json({ success: true });
}
