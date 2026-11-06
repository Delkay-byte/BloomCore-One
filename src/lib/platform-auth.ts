import { SignJWT, jwtVerify } from "jose";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomUUID } from "crypto";
import { db } from "./db";
import { hashPassword, verifyPassword, SESSION_POLICY } from "./auth";
import { mfaPolicy } from "./security/config";
import {
  createSessionRecord,
  isSessionRecordActive,
  revokeSession,
} from "./security/session-store";
import { allowLegacyCookieSessions } from "./security/tab-session";
import { verifyTabProof } from "./security/tab-proof";

/**
 * ============================================================================
 * PLATFORM SUPER ADMIN AUTHENTICATION
 * ============================================================================
 *
 * A completely separate authentication boundary from every tenant surface.
 *
 *   /platform/*            bik-platform-session   ← this module
 *   /admin/*               bik-admin-session
 *   /worker/*              bik-worker-session
 *   /collector/*           bik-collector-session
 *   /customer/*            bik-customer-session
 *
 * Guarantees enforced here and in middleware.ts:
 *
 *   1. A tenant session can NEVER authenticate a /platform/* request, even if
 *      the user is a tenant administrator. The platform guard reads only
 *      PLATFORM_COOKIE.
 *   2. A platform session can NEVER authenticate a tenant route. The tenant
 *      guards in lib/auth.ts and lib/tenant.ts read only their own module
 *      cookies.
 *   3. The token carries `kind: "platform"` and is rejected if that claim is
 *      missing, so a tenant JWT can never be replayed as a platform token even
 *      if it somehow landed in the platform cookie.
 *
 * The identity lives in its own table (PlatformSuperAdmin), not in User. A
 * Platform Super Admin is never a tenant administrator and vice versa.
 */

export const PLATFORM_COOKIE = "bik-platform-session";
/** Short-lived cookie marking a completed platform login challenge. */
const PLATFORM_LOGIN_KIND = "platform";
const PLATFORM_ISSUER = "bloomcore-one";
const PLATFORM_AUDIENCE = "bloomcore-one:platform";

export interface PlatformJwtPayload {
  /** PlatformSuperAdmin.id */
  adminId: string;
  email: string;
  fullName: string;
  kind: "platform";
  jti?: string;
  tokenUse?: "platform";
  amr?: "pwd" | "pwd+mfa";
  /** SSO only: raw IdP-attested amr array (auditability; guards use `amr`). */
  idpAmr?: string[];
  iss?: string;
  aud?: string | string[];
  forcePasswordReset?: boolean;
  tokenVersion?: number;
  iat?: number;
  exp?: number;
  lastActivityAt?: number;
}

export interface PlatformSession {
  adminId: string;
  email: string;
  fullName: string;
  forcePasswordReset: boolean;
}

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET environment variable is required. Set it in your .env file."
    );
  }
  return new TextEncoder().encode(secret);
}

/** Platform sessions are shorter-lived than tenant sessions by design. */
export const PLATFORM_SESSION_POLICY = {
  ABSOLUTE_TIMEOUT_SECONDS: Math.min(
    SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS,
    14400 // 4 hours
  ),
  INACTIVITY_TIMEOUT_SECONDS: Math.min(
    SESSION_POLICY.INACTIVITY_TIMEOUT_SECONDS,
    3600 // 1 hour
  ),
} as const;

export async function hashPlatformPassword(password: string): Promise<string> {
  return hashPassword(password);
}

export async function verifyPlatformPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return verifyPassword(password, hash);
}

/** Shared credential policy: length, an uppercase letter and a digit. */
export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a digit";
  return null;
}

async function createPlatformToken(
  payload: PlatformJwtPayload
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + PLATFORM_SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS;
  const minutes = Math.floor(PLATFORM_SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS / 60);
  return new SignJWT({
    ...payload,
    iat: now,
    exp,
    lastActivityAt: now,
    jti: payload.jti ?? randomUUID(),
    tokenUse: "platform",
  } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(`${minutes}m`)
    .setIssuer(PLATFORM_ISSUER)
    .setAudience(PLATFORM_AUDIENCE)
    .sign(getJwtSecret());
}

export async function verifyPlatformToken(
  token: string
): Promise<PlatformJwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    const p = payload as unknown as PlatformJwtPayload;
    // Reject anything that is not explicitly a platform token. This is what
    // stops a tenant JWT from being accepted on the platform boundary.
    if (p.kind !== PLATFORM_LOGIN_KIND) return null;
    if (!p.adminId) return null;
    if (p.iss !== undefined && p.iss !== PLATFORM_ISSUER) return null;
    if (p.aud !== undefined) {
      const audience = Array.isArray(p.aud) ? p.aud : [p.aud];
      if (!audience.includes(PLATFORM_AUDIENCE)) return null;
    }
    if (p.tokenUse !== undefined && p.tokenUse !== "platform") return null;
    return p;
  } catch {
    return null;
  }
}

export async function setPlatformSession(
  payload: Omit<PlatformJwtPayload, "kind">,
  provenance?: { authSource?: "local" | "sso"; idpSub?: string | null; idpSid?: string | null }
): Promise<string> {
  const jti = payload.jti ?? randomUUID();
  const token = await createPlatformToken({
    ...payload,
    jti,
    kind: PLATFORM_LOGIN_KIND,
  });
  await createSessionRecord({
    id: jti,
    subjectType: "platform",
    subjectId: payload.adminId,
    expiresAt: new Date(
      Date.now() + PLATFORM_SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS * 1000
    ),
    // Provenance makes SSO-derived sessions revocable by central logout and by
    // IdP back-channel logout without touching the same admin's local login.
    authSource: provenance?.authSource ?? null,
    idpSub: provenance?.idpSub ?? null,
    idpSid: provenance?.idpSid ?? null,
  });
  // The token is returned to the calling tab and registered with its worker.
  // No browser-wide platform cookie is written in production. The test-only
  // compatibility bridge keeps legacy cookie-seeded tests meaningful.
  if (allowLegacyCookieSessions()) {
    try {
      (await cookies()).set(PLATFORM_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: PLATFORM_SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS + 60,
      });
    } catch {
      // no request cookie store in a unit-test context
    }
  }
  return token;
}

/** Read and verify the current platform token for revocation/audit. */
export async function getPlatformTokenPayload(): Promise<PlatformJwtPayload | null> {
  const verified = await verifyTabProof("platform");
  if (verified) return verified.payload as unknown as PlatformJwtPayload;
  if (!allowLegacyCookieSessions()) return null;
  try {
    const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
    return token ? await verifyPlatformToken(token) : null;
  } catch {
    return null;
  }
}

/** Revoke the current platform session server-side. */
export async function revokePlatformSession(
  payload: PlatformJwtPayload | null,
  reason: string
): Promise<void> {
  if (!payload?.jti) return;
  await revokeSession(payload.jti, reason);
}

export async function clearPlatformSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(PLATFORM_COOKIE);
}

/** Timing enforcement, mirroring the tenant session rules. */
function validatePlatformTiming(p: PlatformJwtPayload): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (p.exp && now > p.exp) return false;
  const last = p.lastActivityAt ?? p.iat ?? 0;
  if (now - last > PLATFORM_SESSION_POLICY.INACTIVITY_TIMEOUT_SECONDS) {
    return false;
  }
  return true;
}

/**
 * Resolve the authenticated platform administrator, or null.
 * Re-reads the database on every call so a deactivated or replaced platform
 * administrator loses access immediately, regardless of cookie lifetime.
 */
export const getPlatformSession = cache(async function getPlatformSession(): Promise<PlatformSession | null> {
  try {
    const verified = await verifyTabProof("platform");
    let payload: PlatformJwtPayload | null = null;
    if (verified) {
      payload = verified.payload as unknown as PlatformJwtPayload;
    } else if (allowLegacyCookieSessions()) {
      const token = (await cookies()).get(PLATFORM_COOKIE)?.value ?? null;
      payload = token ? await verifyPlatformToken(token) : null;
    }
    if (!payload) return null;
    if (!validatePlatformTiming(payload)) return null;
    if (!(await isSessionRecordActive(payload.jti))) return null;
    if (mfaPolicy() === "enforce" && payload.amr !== "pwd+mfa") return null;

    const admin = await db.platformSuperAdmin.findUnique({
      where: { id: payload.adminId },
      select: {
        id: true,
        email: true,
        fullName: true,
        status: true,
        forcePasswordReset: true,
        tokenVersion: true,
      },
    });
    if (!admin) return null;
    if (admin.status !== "active") return null;
    // Bumping tokenVersion invalidates every existing platform session.
    if (admin.tokenVersion !== (payload.tokenVersion ?? 0)) return null;

    return {
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      forcePasswordReset: admin.forcePasswordReset,
    };
  } catch {
    return null;
  }
});

/**
 * Guard for platform pages. Redirects to the platform login on any failure.
 * The platform login lives on its own route — never the tenant /login.
 */
export async function requirePlatformAdmin(): Promise<PlatformSession> {
  const session = await getPlatformSession();
  if (!session) {
    redirect("/platform/login");
  }
  return session;
}

/**
 * Guard for every platform page EXCEPT the standalone first-login screen: a
 * first-login or reset platform password must be changed before any other
 * platform operation.
 */
export async function requirePlatformPage(): Promise<PlatformSession> {
  const session = await requirePlatformAdmin();
  if (session.forcePasswordReset) {
    redirect("/platform/first-login");
  }
  return session;
}

/** Non-redirecting guard for platform API routes. */
export async function getPlatformAdminOrNull(): Promise<PlatformSession | null> {
  return getPlatformSession();
}

/**
 * Authenticate a platform administrator by credentials.
 *
 * Deliberately returns a discriminated result rather than throwing, so callers
 * cannot accidentally log the reason (and so failure messages stay generic).
 */
export async function authenticatePlatformAdmin(
  email: string,
  password: string
): Promise<
  | { ok: true; admin: PlatformSession; tokenVersion: number }
  | { ok: false; reason: "invalid" | "inactive" | "not_found" }
> {
  const normalized = email.trim().toLowerCase();
  const admin = await db.platformSuperAdmin.findUnique({
    where: { email: normalized },
  });
  if (!admin) {
    // Comparable work for unknown accounts: no timing oracle.
    await verifyPassword(
      password,
      "$2b$12$Liry.nw.u149hj.S6S6JfexTBF7uu1EZY8StKjQTA39/jdAco3ZLK"
    );
    return { ok: false, reason: "not_found" };
  }

  const valid = await verifyPlatformPassword(password, admin.passwordHash);
  if (!valid) return { ok: false, reason: "invalid" };

  if (admin.status !== "active") return { ok: false, reason: "inactive" };

  return {
    ok: true,
    tokenVersion: admin.tokenVersion,
    admin: {
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      forcePasswordReset: admin.forcePasswordReset,
    },
  };
}