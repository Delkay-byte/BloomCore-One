import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { db } from "./db";
import { redirect } from "next/navigation";
import {
  createSessionRecord,
  isSessionRecordActive,
  revokeAllSubjectSessions,
  revokeSession,
  touchSessionRecord,
} from "./security/session-store";

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET environment variable is required. " +
      "Set it in your .env file. See .env.example for details."
    );
  }
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Session security policy (server-enforced)
// ---------------------------------------------------------------------------
/** Safely parse a positive integer from env, falling back to default. */
function safeInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SESSION_POLICY = {
  /** 8 hours — inactivity timeout (generous pilot/testing value) */
  INACTIVITY_TIMEOUT_SECONDS: safeInt(
    process.env.SESSION_IDLE_TIMEOUT_SECONDS,
    28800
  ),
  /** 2 hours — background/hidden-page grace (generous pilot/testing value) */
  BACKGROUND_TIMEOUT_SECONDS: safeInt(
    process.env.SESSION_BACKGROUND_TIMEOUT_SECONDS,
    7200
  ),
  /** 8 hours — absolute session lifetime (generous pilot/testing value) */
  ABSOLUTE_TIMEOUT_SECONDS: safeInt(
    process.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
    28800
  ),
  /** Warning shown 60 seconds before inactivity expiry */
  WARNING_BEFORE_SECONDS: 60,
} as const;

/**
 * MODULE-SCOPED SESSION ARCHITECTURE
 *
 * Each business module keeps its own independent auth cookie:
 *
 *   bik-admin-session     → /admin/*   (administrators)
 *   bik-worker-session    → /worker/*  (MoMo workers)
 *   bik-collector-session → /collector/* (Susu collectors)
 *
 * Because every login only writes ITS OWN module cookie, signing in as a
 * worker in one tab can never overwrite an administrator session in another
 * tab — the two cookies are independent browser state.
 *
 * Standard-cookie limitation (documented deliberately): tabs of the SAME
 * origin share cookie storage, so copying a protected URL into another tab
 * still inherits that module's session. The isolation guarantee is per
 * module, not per tab — no superficial workaround is applied.
 */

export type ModuleName = "admin" | "momo" | "susu" | "customer";

const LEGACY_COOKIE_NAME = "bik-prestige-token";
export const SESSION_COOKIES: Record<ModuleName, string> = {
  admin: "bik-admin-session",
  momo: "bik-worker-session",
  susu: "bik-collector-session",
  customer: "bik-customer-session",
};
export const SELECTION_COOKIE_NAME = "bik-workspace-select";

export interface JwtPayload {
  userId: string;
  email: string;
  fullName?: string;
  role: "admin" | "worker" | "collector" | "customer"; // primary role (kept for compatibility)
  modules?: ("momo" | "susu" | "customer")[];          // authorized business modules
  locationId?: string;
  collectorId?: string;
  tenantId?: string | null;
  forcePasswordReset?: boolean;
  tokenVersion?: number;
  /** Server-side session registry id. */
  jti?: string;
  /** Distinguishes session tokens from workspace-selection tokens. */
  tokenUse?: "session" | "workspace-selection";
  /** Epoch seconds — when this token was issued (server-authoritative) */
  iat?: number;
  /** Epoch seconds — absolute expiry timestamp */
  exp?: number;
  /** Epoch seconds — last recorded meaningful activity */
  lastActivityAt?: number;
}

/** Short-lived token issued after login when the user must pick a workspace. */
export interface SelectionPayload {
  userId: string;
  email: string;
  fullName: string;
  modules: ("momo" | "susu")[];
  jti?: string;
  tokenUse?: "workspace-selection";
}

const JWT_ISSUER = "bloomcore-one";
const SESSION_AUDIENCE = "bloomcore-one:session";
const SELECTION_AUDIENCE = "bloomcore-one:workspace-selection";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createToken(payload: JwtPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const absoluteExpiry = now + SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS;
  // jose setExpirationTime: strings like "15m" are durations-from-now;
  // numbers are ALSO durations-from-now (not absolute timestamps).
  // Convert seconds to a jose-compatible string to avoid misinterpretation.
  const expirySeconds = SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS;
  const expiryMinutes = Math.floor(expirySeconds / 60);
  const expiryString = expiryMinutes >= 60
    ? `${Math.floor(expiryMinutes / 60)}h${expiryMinutes % 60 > 0 ? `${expiryMinutes % 60}m` : ""}`
    : `${expiryMinutes}m`;
  return new SignJWT({
    ...payload,
    iat: now,
    exp: absoluteExpiry,
    lastActivityAt: now,
    jti: payload.jti ?? randomUUID(),
    tokenUse: "session",
  } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(expiryString)
    .setIssuer(JWT_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .sign(getJwtSecret());
}

export async function createSelectionToken(payload: SelectionPayload): Promise<string> {
  return new SignJWT({
    ...payload,
    kind: "workspace-selection",
    jti: payload.jti ?? randomUUID(),
    tokenUse: "workspace-selection",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .setIssuer(JWT_ISSUER)
    .setAudience(SELECTION_AUDIENCE)
    .sign(getJwtSecret());
}

/**
 * Verify a token. New tokens carry issuer/audience/use claims and are checked
 * strictly. Pre-hardening tokens (no issuer) remain valid until their existing
 * short expiry so a deploy does not sign every user out.
 */
export async function verifyToken<T = JwtPayload>(token: string): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    const claims = payload as Record<string, unknown>;
    if (claims.iss !== undefined && claims.iss !== JWT_ISSUER) return null;
    if (claims.aud !== undefined) {
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const expected = [
        SESSION_AUDIENCE,
        SELECTION_AUDIENCE,
        "bloomcore-one:platform",
      ];
      if (!audience.some((value) => expected.includes(value))) return null;
    }
    if (
      claims.tokenUse !== undefined &&
      claims.tokenUse !== "session" &&
      claims.tokenUse !== "workspace-selection"
    ) {
      return null;
    }
    return payload as unknown as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server-side session validation
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "valid"
  | "inactivity_expired"
  | "absolute_expired"
  | "background_expired"
  | "invalid";

/**
 * Check whether a JWT payload is still valid against the server-side
 * session policy.  All timers are enforced here — the client cannot
 * manipulate them.
 */
export function validateSessionTiming(payload: JwtPayload): SessionStatus {
  const now = Math.floor(Date.now() / 1000);

  // 1. Absolute lifetime
  if (payload.exp && now > payload.exp) {
    return "absolute_expired";
  }

  // 2. Inactivity timeout
  const lastActivity = payload.lastActivityAt ?? payload.iat ?? 0;
  if (now - lastActivity > SESSION_POLICY.INACTIVITY_TIMEOUT_SECONDS) {
    return "inactivity_expired";
  }

  return "valid";
}

/**
 * Create a refreshed token with the current timestamp as lastActivityAt.
 * The absolute expiry (exp) is NOT extended — only inactivity resets.
 */
export async function refreshLastActivity(payload: JwtPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = payload.iat ?? now;
  // Use remaining seconds from the original exp, or fall back to full timeout
  const remainingSeconds = payload.exp ? Math.max(0, payload.exp - now) : SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS;
  const remainingMinutes = Math.max(1, Math.floor(remainingSeconds / 60));
  const expiryString = remainingMinutes >= 60
    ? `${Math.floor(remainingMinutes / 60)}h${remainingMinutes % 60 > 0 ? `${remainingMinutes % 60}m` : ""}`
    : `${remainingMinutes}m`;
  return new SignJWT({
    ...payload,
    lastActivityAt: now,
    exp: payload.exp ?? (now + SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS),
  } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(iat)
    .setExpirationTime(expiryString)
    .setIssuer(JWT_ISSUER)
    .setAudience(
      payload.tokenUse === "workspace-selection"
        ? SELECTION_AUDIENCE
        : SESSION_AUDIENCE
    )
    .sign(getJwtSecret());
}

// ---------------------------------------------------------------------------
// Cookie management
// ---------------------------------------------------------------------------

async function setSessionCookie(name: string, token: string) {
  const cookieStore = await cookies();
  // maxAge must always be a valid positive integer (NaN would cause the browser
  // to discard the cookie, creating an instant login loop).
  const maxAge = Math.max(60, SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS + 60);
  cookieStore.set(name, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
    priority: "high",
  });
}

export async function setModuleSession(module: ModuleName, payload: JwtPayload) {
  const jti = payload.jti ?? randomUUID();
  const token = await createToken({ ...payload, jti });
  await createSessionRecord({
    id: jti,
    subjectType: payload.role === "customer" ? "customer" : "user",
    subjectId: payload.userId,
    tenantId: payload.tenantId ?? null,
    expiresAt: new Date(
      Date.now() + SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS * 1000
    ),
  });
  await setSessionCookie(SESSION_COOKIES[module], token);
}

/** Revoke one session server-side (used by logout and account changes). */
export async function revokeSessionToken(
  payload: JwtPayload | null,
  reason: string
): Promise<void> {
  if (!payload?.jti) return;
  await revokeSession(payload.jti, reason);
}

/** Revoke every session belonging to an account. */
export async function revokeAllUserSessions(
  subjectType: "user" | "customer" | "platform",
  subjectId: string,
  reason: string
): Promise<void> {
  await revokeAllSubjectSessions(subjectType, subjectId, reason);
}

export async function setSelectionSession(token: string) {
  await setSessionCookie(SELECTION_COOKIE_NAME, token);
}

export async function clearModuleSession(module: ModuleName) {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIES[module]);
}

/** Terminate every known session for this browser (full logout). */
export async function clearAllSessions() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIES.admin);
  cookieStore.delete(SESSION_COOKIES.momo);
  cookieStore.delete(SESSION_COOKIES.susu);
  cookieStore.delete(SESSION_COOKIES.customer);
  cookieStore.delete(SELECTION_COOKIE_NAME);
  // Legacy single-cookie sessions (pre hardening)
  cookieStore.delete(LEGACY_COOKIE_NAME);
}

// ---------------------------------------------------------------------------
// Session readers (per module)
// ---------------------------------------------------------------------------

function legacyRoleMatchesModule(role: string, module: ModuleName): boolean {
  if (module === "admin") return role === "admin";
  if (module === "momo") return role === "worker";
  return role === "collector";
}

function normalizePayload(payload: JwtPayload): JwtPayload {
  return {
    ...payload,
    modules: Array.isArray(payload.modules)
      ? payload.modules
      : payload.role === "worker"
        ? ["momo"]
        : payload.role === "collector"
          ? ["susu"]
          : [],
    tokenVersion: typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0,
    iat: typeof payload.iat === "number" ? payload.iat : Math.floor(Date.now() / 1000),
    exp: typeof payload.exp === "number"
      ? payload.exp
      : Math.floor(Date.now() / 1000) + SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS,
    lastActivityAt: typeof payload.lastActivityAt === "number"
      ? payload.lastActivityAt
      : (typeof payload.iat === "number" ? payload.iat : Math.floor(Date.now() / 1000)),
  };
}

export async function readModuleCookie(module: ModuleName): Promise<JwtPayload | null> {
  const cookieStore = await cookies();
  const name = SESSION_COOKIES[module];

  const scoped = cookieStore.get(name)?.value;
  if (scoped) {
    const payload = await verifyToken<JwtPayload>(scoped);
    if (!payload?.userId) return null;
    if (payload.tokenUse === "workspace-selection") return null;
    const normalized = normalizePayload(payload);
    // Server-side session timing enforcement
    const status = validateSessionTiming(normalized);
    if (status !== "valid") return null;
    // Server-side registry enforcement (revocation, logout, admin action).
    if (!(await isSessionRecordActive(normalized.jti))) return null;
    return normalized;
  }

  // Graceful fallback to pre-hardening sessions until the next login.
  const legacy = cookieStore.get(LEGACY_COOKIE_NAME)?.value;
  if (!legacy) return null;
  const payload = await verifyToken<JwtPayload>(legacy);
  if (!payload?.userId || !legacyRoleMatchesModule(payload.role, module)) return null;
  const normalized = normalizePayload(payload);
  const status = validateSessionTiming(normalized);
  if (status !== "valid") return null;
  if (!(await isSessionRecordActive(normalized.jti))) return null;
  return normalized;
}

export async function getAdminSession(): Promise<JwtPayload | null> {
  return readModuleCookie("admin");
}

export async function getMomoSession(): Promise<JwtPayload | null> {
  return readModuleCookie("momo");
}

export async function getSusuSession(): Promise<JwtPayload | null> {
  return readModuleCookie("susu");
}

export async function getCustomerSession(): Promise<JwtPayload | null> {
  return readModuleCookie("customer");
}

/** Any authenticated module session (used by shared APIs such as /api/auth/me). */
export async function getAnyAuthUser(): Promise<JwtPayload | null> {
  return (await getAdminSession()) ?? (await getMomoSession()) ?? (await getSusuSession()) ?? (await getCustomerSession());
}

export async function getSelectionUser(): Promise<SelectionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SELECTION_COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifyToken<SelectionPayload & { kind?: string }>(token);
  if (!payload || payload.kind !== "workspace-selection") return null;
  return { userId: payload.userId, email: payload.email, fullName: payload.fullName, modules: payload.modules };
}

/** True when the stored session matches the user's current tokenVersion. */
export async function isSessionCurrent(payload: JwtPayload): Promise<boolean> {
  try {
    // Server-side timing enforcement applies to every role.
    const timingStatus = validateSessionTiming(payload);
    if (timingStatus !== "valid") return false;

    // Revoked/logged-out sessions are rejected even if the JWT is still valid.
    if (!(await isSessionRecordActive(payload.jti))) return false;

    // Customer sessions are validated against the Customer record, not User.
    if (payload.role === "customer") {
      const customer = await db.customer.findUnique({
        where: { id: payload.userId },
        select: { status: true, tokenVersion: true },
      });
      if (!customer || customer.status !== "active") return false;
      if ((customer.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0)) return false;
      return true;
    }

    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { tokenVersion: true, status: true },
    });
    if (!user || user.status !== "active") return false;
    if (user.tokenVersion !== (payload.tokenVersion ?? 0)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh a session cookie with updated lastActivityAt.
 * Returns the new token so the caller can set it.
 */
export async function refreshSession(module: ModuleName): Promise<string | null> {
  const cookieStore = await cookies();
  const name = SESSION_COOKIES[module];
  const token = cookieStore.get(name)?.value;
  if (!token) return null;
  const payload = await verifyToken<JwtPayload>(token);
  if (!payload?.userId) return null;
  const normalized = normalizePayload(payload);
  const status = validateSessionTiming(normalized);
  if (status !== "valid") return null;
  const newToken = await refreshLastActivity(normalized);
  await touchSessionRecord(normalized.jti);
  cookieStore.set(name, newToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS + 60,
    priority: "high",
  });
  return newToken;
}

/**
 * Get the current session status for the active module.
 * Used by client-side session monitor to display warnings.
 */
export async function getCurrentSessionStatus(): Promise<{
  status: SessionStatus;
  secondsUntilInactivity: number;
  secondsUntilAbsolute: number;
} | null> {
  const user = await getAnyAuthUser();
  if (!user) return null;
  const now = Math.floor(Date.now() / 1000);
  const lastActivity = user.lastActivityAt ?? user.iat ?? now;
  const secondsUntilInactivity = Math.max(0, SESSION_POLICY.INACTIVITY_TIMEOUT_SECONDS - (now - lastActivity));
  const secondsUntilAbsolute = Math.max(0, (user.exp ?? now + SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS) - now);
  const status = validateSessionTiming(user);
  return { status, secondsUntilInactivity, secondsUntilAbsolute };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export async function requireAuth(): Promise<JwtPayload> {
  const user = await getAnyAuthUser();
  if (!user) redirect("/login");
  if (!(await isSessionCurrent(user))) {
    await clearAllSessions();
    redirect("/login?reason=session_expired");
  }
  return user;
}

export async function requireAdmin(): Promise<JwtPayload> {
  const user = await getAdminSession();
  if (!user) redirect("/login");
  if (!(await isSessionCurrent(user))) {
    await clearAllSessions();
    redirect("/login?reason=session_expired");
  }
  if (user.role !== "admin") redirect("/unauthorized");
  return user;
}

/** Guard for MoMo worker pages/actions: requires an active momo capability. */
export async function requireWorker(): Promise<JwtPayload> {
  const user = await getMomoSession();
  if (!user) redirect("/login");
  if (!(await isSessionCurrent(user))) {
    await clearAllSessions();
    redirect("/login?reason=session_expired");
  }
  if (!(user.modules ?? []).includes("momo")) redirect("/unauthorized");
  return user;
}

/** Guard for Susu collector pages/actions: requires an active susu capability. */
export async function requireCollector(): Promise<JwtPayload> {
  const user = await getSusuSession();
  if (!user) redirect("/login");
  if (!(await isSessionCurrent(user))) {
    await clearAllSessions();
    redirect("/login?reason=session_expired");
  }
  if (!(user.modules ?? []).includes("susu")) redirect("/unauthorized");
  return user;
}

/**
 * Canonical authenticated-collector resolution for Susu server actions.
 *
 * A user is a Susu collector iff they hold a valid Susu module session AND an
 * active Collector record exists for their account. The primary User.role is
 * deliberately NOT used: the platform grants Susu capability to worker-role
 * accounts via susuEnabled (see updateWorker's "Susu (collector)" toggle), so
 * role-based gates would reject legitimate collectors. This is the single
 * server-side source of truth — collectors are never resolved from browser
 * input (no collectorId from the client).
 */
export async function resolveAuthenticatedCollector(): Promise<{
  user: JwtPayload;
  collector: { id: string; status: string };
} | null> {
  const user = await getSusuSession();
  if (!user) return null;
  if (!(user.modules ?? []).includes("susu")) return null;
  const collector = await db.collector.findFirst({
    where: { userId: user.userId, status: "active" },
    select: { id: true, status: true },
  });
  if (!collector) return null;
  return { user, collector };
}

/** Guard for Customer portal pages/actions: requires an active customer capability. */
export async function requireCustomer(): Promise<JwtPayload> {
  const user = await getCustomerSession();
  if (!user) redirect("/login?role=customer");
  if (!(await isSessionCurrent(user))) {
    await clearAllSessions();
    redirect("/login?role=customer&reason=session_expired");
  }
  if (!(user.modules ?? []).includes("customer")) redirect("/unauthorized");
  return user;
}

// Legacy alias retained for existing call sites.
export const getAuthUser = getAnyAuthUser;

export async function getFullUser(userId: string) {
  return db.user.findUnique({
    where: { id: userId },
    include: { location: true },
  });
}
