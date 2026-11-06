import { SignJWT, jwtVerify } from "jose";
import type { JwtPayload } from "@/lib/auth";
import type { TabSurface } from "./tab-proof";

/**
 * Edge-safe tab assertion.
 *
 * This is a 120-second, route-gating assertion only. It is never accepted as a
 * data credential: every protected server operation also verifies the
 * proof-of-possession header. The assertion is held in service-worker memory,
 * not persisted in browser storage.
 */
export const TAB_ASSERTION_HEADER = "x-bloomcore-tab-assertion";
export const TAB_ASSERTION_AUDIENCE = "bloomcore-one:tab-assertion";
const TAB_ASSERTION_SECONDS = 120;

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET environment variable is required.");
  return new TextEncoder().encode(value);
}

export interface TabAssertionClaims {
  sid: string;
  module: TabSurface;
  role?: string;
  kind?: string;
  adminId?: string;
  amr?: string;
  forcePasswordReset?: boolean;
}

export async function createTabAssertion(input: {
  sessionId: string;
  module: TabSurface;
  payload: JwtPayload;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sid: input.sessionId,
    module: input.module,
    role: input.payload.role,
    kind: input.payload.kind,
    adminId: input.payload.adminId,
    amr: input.payload.amr,
    forcePasswordReset: input.payload.forcePasswordReset,
    iat: now,
    exp: now + TAB_ASSERTION_SECONDS,
  } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(`${TAB_ASSERTION_SECONDS}s`)
    .setIssuer("bloomcore-one")
    .setAudience(TAB_ASSERTION_AUDIENCE)
    .sign(secret());
}

export async function verifyTabAssertion(
  token: string | null | undefined
): Promise<TabAssertionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: "bloomcore-one",
      audience: TAB_ASSERTION_AUDIENCE,
    });
    const claims = payload as Record<string, unknown>;
    if (typeof claims.sid !== "string" || typeof claims.module !== "string") {
      return null;
    }
    return {
      sid: claims.sid,
      module: claims.module as TabSurface,
      role: typeof claims.role === "string" ? claims.role : undefined,
      kind: typeof claims.kind === "string" ? claims.kind : undefined,
      adminId: typeof claims.adminId === "string" ? claims.adminId : undefined,
      amr: typeof claims.amr === "string" ? claims.amr : undefined,
      forcePasswordReset: Boolean(claims.forcePasswordReset),
    };
  } catch {
    return null;
  }
}
