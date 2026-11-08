"use server";

import { db } from "@/lib/db";
import {
  hashPassword,
  verifyPassword,
  setModuleSession,
  setSelectionSession,
  clearModuleSession,
  getAdminSession,
  getMomoSession,
  getSusuSession,
  getCustomerSession,
  getAnyAuthUser,
  getSelectionUser,
  isSessionCurrent,
  createSelectionToken,
  revokeAllUserSessions,
  revokeSessionToken,
  SELECTION_COOKIE_NAME,
  type JwtPayload,
  type ModuleName,
} from "@/lib/auth";
import { loginSchema } from "@/lib/validations";
import { createAuditLog } from "@/lib/audit";
import { normalizeGhanaPhone } from "@/lib/utils";
import {
  isAccountNumber,
  normalizeAccountNumber,
  SHARED_PHONE_MESSAGE,
} from "@/lib/customer-identifiers";
import { cookies } from "next/headers";
import {
  cooldownMessage,
  GENERIC_LOGIN_ERROR,
  guardLogin,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/security/auth-guard";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { beginMfaStepIfRequired } from "@/lib/security/mfa-login";
import { TURNSTILE_ACTIONS } from "@/lib/security/turnstile-actions";

/**
 * A valid bcrypt hash of a value nobody knows. Comparing against it for unknown
 * accounts keeps the response time comparable to a real password check, which
 * removes the clearest timing-based account-enumeration signal.
 */
const DUMMY_PASSWORD_HASH =
  "$2b$12$Liry.nw.u149hj.S6S6JfexTBF7uu1EZY8StKjQTA39/jdAco3ZLK";

async function verifyPasswordConstantTime(
  password: string,
  hash: string | null | undefined
): Promise<boolean> {
  if (!hash) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return false;
  }
  return verifyPassword(password, hash);
}

export interface ActionResponse {
  success: boolean;
  error?: string;
  /** When true, the error relates to an admin attempting the shared login. */
  adminLogin?: boolean;
  /**
   * The tab's new session handle. Returned only to the client that completed
   * authentication; it is never placed in a URL or a shared cookie. The client
   * hands it to its tab-scoped service worker.
   */
  sessionToken?: string;
  /** Where the client should navigate after registering the session. */
  redirectTo?: string;
  /** MFA step required before a session can be issued. */
  mfa?: "verify" | "enroll";
  /** Short-lived, tab-scoped MFA challenge (never a session). */
  mfaToken?: string;
}

/**
 * The non-admin workspaces that may be requested through the shared `/login`
 * portal. `admin` is deliberately excluded and handled by `/admin/login`.
 */
export type NonAdminRole = "customer" | "momo" | "susu";

function isNonAdminRole(value: string | undefined): value is NonAdminRole {
  return value === "customer" || value === "momo" || value === "susu";
}

function dashboardPathFor(module: ModuleName): string {
  if (module === "admin") return "/admin/dashboard";
  if (module === "momo") return "/worker/dashboard";
  return "/collector/dashboard";
}

export async function login(
  formData: FormData
): Promise<ActionResponse | void> {
  const rawEmail = (formData.get("email") as string)?.trim() ?? "";
  const password = (formData.get("password") as string) ?? "";
  const turnstileToken =
    (formData.get("cf-turnstile-response") as string) ??
    (formData.get("turnstileToken") as string);

  // Per-IP limit + progressive cooldown + Turnstile, before any credential work.
  const guard = await guardLogin({
    identifier: rawEmail,
    action: TURNSTILE_ACTIONS.staffLogin,
    turnstileToken,
  });
  if (!guard.ok) return { success: false, error: guard.error };

  const email = guard.identifier;
  const validated = loginSchema.safeParse({ email, password });
  if (!validated.success) {
    await recordLoginFailure(email, guard.ip, "login");
    return { success: false, error: GENERIC_LOGIN_ERROR };
  }

  const user = await db.user.findUnique({
    where: { email },
  });

  const valid = await verifyPasswordConstantTime(password, user?.passwordHash);
  if (!user || !valid) {
    const state = await recordLoginFailure(email, guard.ip, "login");
    return {
      success: false,
      error: state.blocked
        ? cooldownMessage(state.retryAfterSeconds)
        : GENERIC_LOGIN_ERROR,
    };
  }

  // Account-state checks happen only after a correct password, so they cannot
  // be used to enumerate accounts.
  if (user.status !== "active") {
    return {
      success: false,
      error: "Your account is not available. Please contact your administrator.",
    };
  }

  await recordLoginSuccess(email, guard.ip, "login");

  // Every account type passes through the MFA policy gate, including the
  // legacy shared-login action.
  const mfaModule: "admin" | "momo" | "susu" =
    user.role === "admin" ? "admin" : user.momoEnabled ? "momo" : "susu";
  const mfaStep = await beginMfaStepIfRequired({
    subjectType: "user",
    subjectId: user.id,
    module: mfaModule,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    mfaEnabled: user.mfaEnabled,
    forcePasswordReset: user.forcePasswordReset,
    tokenVersion: user.tokenVersion,
  });
  if (mfaStep) {
    return {
      success: true,
      mfa: mfaStep.mode,
      mfaToken: mfaStep.token,
      redirectTo: `/mfa/${mfaStep.mode}`,
    };
  }

  const modules: ("momo" | "susu")[] = [];
  if (user.momoEnabled) modules.push("momo");
  if (user.susuEnabled) modules.push("susu");

  await createAuditLog({
    userId: user.id,
    action: "auth.login",
    entityType: "user",
    entityId: user.id,
  });

  // Administrators sign into the administration module.
  if (user.role === "admin") {
    const issued = await issueModuleSession(user.id, "admin");
    return {
      success: true,
      sessionToken: issued.token,
      redirectTo: issued.payload.forcePasswordReset
        ? "/admin/first-login"
        : "/admin/dashboard",
    };
  }

  if (modules.length === 0) {
    return {
      success: false,
      error: "Your account is not registered for any module. Please contact the administrator.",
    };
  }

  if (modules.length === 1) {
    const mod = modules[0];
    const issued = await issueModuleSession(user.id, mod);
    return {
      success: true,
      sessionToken: issued.token,
      redirectTo: issued.payload.forcePasswordReset
        ? firstLoginPathFor(mod)
        : dashboardPathFor(mod),
    };
  }

  // Dual-role: let the person choose their workspace. No arbitrary default.
  const selectionToken = await createSelectionToken({
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    modules,
  });
  await setSelectionSession(selectionToken);
  return {
    success: true,
    sessionToken: selectionToken,
    redirectTo: "/select-workspace",
  };
}

function firstLoginPathFor(module: ModuleName): string {
  return `/${module === "admin" ? "admin" : module === "momo" ? "worker" : "collector"}/first-login`;
}

async function buildSessionPayload(userId: string): Promise<JwtPayload> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const modules: ("momo" | "susu")[] = [];
  if (user.momoEnabled) modules.push("momo");
  if (user.susuEnabled) modules.push("susu");
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role as "admin" | "worker" | "collector",
    modules,
    locationId: user.locationId ?? undefined,
    tenantId: user.tenantId,
    forcePasswordReset: user.forcePasswordReset,
    tokenVersion: user.tokenVersion,
  };
}

/**
 * Issue a fresh session for `userId` for the given module.
 * Returns the token so the calling tab can register it with its worker.
 */
export async function issueModuleSession(
  userId: string,
  module: ModuleName,
  mfaVerified = false
): Promise<{ payload: JwtPayload; token: string }> {
  const payload = await buildSessionPayload(userId);
  const withAmr: JwtPayload = {
    ...payload,
    amr: mfaVerified ? "pwd+mfa" : "pwd",
  };
  const token = await setModuleSession(module, withAmr);
  return { payload: withAmr, token };
}

export async function selectWorkspace(
  module: "momo" | "susu"
): Promise<ActionResponse> {
  const selection = await getSelectionUser();
  if (!selection) {
    return { success: false, error: "Workspace selection expired. Please sign in again." };
  }
  if (!selection.modules.includes(module)) {
    return { success: false, error: "You are not authorized for this module." };
  }

  const issued = await issueModuleSession(selection.userId, module);

  // The selection token is single-use. The shared legacy cookie is removed
  // only for migration; no new selection cookie is written.
  try {
    (await cookies()).delete(SELECTION_COOKIE_NAME);
  } catch {
    // no request cookie store outside a request scope
  }

  await createAuditLog({
    userId: selection.userId,
    action: "auth.workspace_selected",
    entityType: "user",
    entityId: selection.userId,
    details: { module },
  });

  return {
    success: true,
    sessionToken: issued.token,
    redirectTo: dashboardPathFor(module),
  };
}

/**
 * Switch between the modules this person is registered for.
 * Requires an active session in any module belonging to the same account.
 */
export async function switchWorkspace(
  target: "momo" | "susu"
): Promise<ActionResponse> {
  const sources: Array<[ModuleName, Awaited<ReturnType<typeof getMomoSession>>]> = [
    ["momo", await getMomoSession()],
    ["susu", await getSusuSession()],
    ["admin", null],
  ];

  let userId: string | null = null;
  let sourceModule: ModuleName | null = null;
  let sourceAmr: JwtPayload["amr"] = "pwd";
  for (const [mod, session] of sources) {
    if (session && (await isSessionCurrent(session))) {
      userId = session.userId;
      sourceModule = mod;
      sourceAmr = session.amr;
      break;
    }
  }

  if (!userId || !sourceModule || sourceModule === "admin") {
    return { success: false, error: "Not authenticated" };
  }
  if (sourceModule === target) {
    return { success: true };
  }

  // Verify the account is genuinely registered for the target module.
  const payload = await buildSessionPayload(userId);
  if (!(payload.modules ?? []).includes(target)) {
    return { success: false, error: "You are not authorized for this module." };
  }

  const token = await setModuleSession(target, { ...payload, amr: sourceAmr });
  // Remove only the legacy cookie for the source module; the current tab's
  // worker mapping is replaced by the client with the new token below.
  await clearModuleSession(sourceModule);

  await createAuditLog({
    userId,
    action: "auth.workspace_switched",
    entityType: "user",
    entityId: userId,
    details: { from: sourceModule, to: target },
  });

  return {
    success: true,
    sessionToken: token,
    redirectTo: dashboardPathFor(target),
  };
}

/**
 * Sign out THIS tab only.
 *
 * The tab's worker header identifies exactly one server session. Revoking its
 * `jti` leaves every other tab's session untouched. The client clears its own
 * worker mapping after this action returns.
 */
export async function logout(): Promise<ActionResponse> {
  const active = await getAnyAuthUser();
  if (active) {
    await revokeSessionToken(active, "logout");
    await createAuditLog({
      userId: active.userId,
      action: "auth.logout",
      entityType: active.role === "customer" ? "customer" : "user",
      entityId: active.userId,
    });
  }
  return { success: true, redirectTo: "/login" };
}

/**
 * Verify the current user's password (for step-up reauthentication).
 *
 * The password is never logged or stored. Identity comes ONLY from the
 * session named by `options.module`. Sensitive screens (Susu withdrawals,
 * worker password reset) are administrator surfaces and must pass
 * "admin": falling back to a MoMo worker or Susu collector session that the
 * browser also holds would verify the wrong account's password — which is
 * exactly how a valid administrator password can be reported as incorrect.
 *
 * The submitted password is compared exactly as typed. Sign-in does not trim
 * it, so trimming here made a password that worked at sign-in fail at
 * confirmation.
 */
export async function verifyPasswordAction(
  password: string,
  options?: { module?: ModuleName }
): Promise<ActionResponse> {
  if (typeof password !== "string" || password.length === 0) {
    return { success: false, error: "Password is required" };
  }
  if (password.length > 256) {
    return { success: false, error: "Incorrect password" };
  }

  const requestedModule = options?.module;
  let context: { module: ModuleName; user: JwtPayload } | null = null;

  if (requestedModule) {
    const session =
      requestedModule === "admin"
        ? await getAdminSession()
        : requestedModule === "momo"
          ? await getMomoSession()
          : requestedModule === "susu"
            ? await getSusuSession()
            : await getCustomerSession();

    if (!session) {
      return {
        success: false,
        error: "Your session has expired. Please sign in again.",
      };
    }
    context = { module: requestedModule, user: session };
  } else {
    // Compatibility path for callers that do not name a module.
    const adminUser = await getAdminSession();
    const momoUser = await getMomoSession();
    const susuUser = await getSusuSession();
    if (adminUser) {
      context = { module: "admin", user: adminUser };
    } else if (momoUser) {
      context = { module: "momo", user: momoUser };
    } else if (susuUser) {
      context = { module: "susu", user: susuUser };
    }
  }

  if (!context) {
    return { success: false, error: "Not authenticated" };
  }

  if (!(await isSessionCurrent(context.user))) {
    return { success: false, error: "Session expired. Please sign in again." };
  }

  // Failed-attempt protection: the window applies to successful and failed
  // attempts alike, so it cannot be used to probe passwords in bulk.
  const rate = await consumeRateLimit(
    "auth:reauth",
    context.user.userId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) {
    return {
      success: false,
      error: "Too many password attempts. Please wait and try again.",
    };
  }

  const dbUser = await db.user.findUnique({
    where: { id: context.user.userId },
  });
  if (!dbUser || dbUser.status !== "active") {
    return { success: false, error: "User not found" };
  }

  const valid = await verifyPassword(password, dbUser.passwordHash);
  if (!valid) {
    await createAuditLog({
      userId: context.user.userId,
      action: "auth.reauth_failed",
      entityType: "user",
      entityId: context.user.userId,
      details: { module: context.module },
    });
    return { success: false, error: "Incorrect password" };
  }

  await createAuditLog({
    userId: context.user.userId,
    action: "auth.reauth_success",
    entityType: "user",
    entityId: context.user.userId,
    details: { module: context.module },
  });

  return { success: true };
}

export async function changePassword(
  formData: FormData
): Promise<ActionResponse> {
  // Determine which module session is making the request — identity always
  // comes from the authenticated session, never from browser-supplied IDs.
  // The optional `module` field only SELECTS among cookies the browser already
  // holds, so the first-login screen cannot change a different session's
  // password when more than one is present.
  const requestedModule = formData.get("module");
  const moduleFilter: ModuleName | null =
    requestedModule === "admin" ||
    requestedModule === "momo" ||
    requestedModule === "susu"
      ? requestedModule
      : null;

  const contexts: Array<{ module: ModuleName; user: JwtPayload | null }> = [
    { module: "admin", user: await getAdminSession() },
    { module: "momo", user: await getMomoSession() },
    { module: "susu", user: await getSusuSession() },
  ];
  const context = contexts.find(
    (c) => c.user !== null && (moduleFilter === null || c.module === moduleFilter)
  );
  if (!context || !context.user) {
    return { success: false, error: "Not authenticated" };
  }
  const session = context.user;

  if (!(await isSessionCurrent(session))) {
    return { success: false, error: "Session expired. Please sign in again." };
  }

  const currentPassword = (formData.get("currentPassword") as string)?.trim();
  const newPassword = (formData.get("newPassword") as string)?.trim();
  const confirmPassword = (formData.get("confirmPassword") as string)?.trim();

  if (!currentPassword) {
    return { success: false, error: "Current password is required" };
  }

  if (newPassword !== confirmPassword) {
    return { success: false, error: "Passwords don't match" };
  }

  if (newPassword.length < 8) {
    return { success: false, error: "Password must be at least 8 characters" };
  }

  const dbUser = await db.user.findUnique({ where: { id: session.userId } });
  if (!dbUser) {
    return { success: false, error: "User not found" };
  }

  const valid = await verifyPassword(currentPassword, dbUser.passwordHash);
  if (!valid) {
    return { success: false, error: "Current password is incorrect" };
  }

  const wasForced = !!session.forcePasswordReset;

  const newHash = await hashPassword(newPassword);
  // Bump tokenVersion to invalidate ALL existing sessions across all modules
  await db.user.update({
    where: { id: session.userId },
    data: {
      passwordHash: newHash,
      forcePasswordReset: false,
      tokenVersion: { increment: 1 },
    },
  });

  // Re-issue THIS module's session with the new tokenVersion. All previous
  // sessions (including any stolen cookie) are revoked server-side first.
  await revokeAllUserSessions("user", session.userId, "password_changed");
  const refreshed = {
    ...(await buildSessionPayload(session.userId)),
    amr: session.amr,
  };
  const token = await setModuleSession(context.module, refreshed);

  await createAuditLog({
    userId: session.userId,
    action: wasForced ? "auth.first_login_password_changed" : "auth.password_changed",
    entityType: "user",
    entityId: session.userId,
  });

  return {
    success: true,
    sessionToken: token,
    redirectTo: dashboardPathFor(context.module),
  };
}

// ---------------------------------------------------------------------------
// Shared credential resolvers
//
// These enforce server-side capability checks so that the browser-supplied
// "requested workspace" (role) can NEVER become proof of access.  The role the
// user clicks on the login screen is only a *requested* workspace; the server
// re-verifies it against the account's real capabilities below.
// ---------------------------------------------------------------------------

const CUSTOMER_GENERIC_ERROR = "Invalid phone number, Account Number or password.";
const STAFF_GENERIC_ERROR = "Invalid email, phone or password.";

/**
 * Resolve a customer (portal) login.
 * Returns the session payload, or a generic error string that never reveals
 * whether the identifier exists, is disabled, or the password was wrong.
 */
export async function resolveCustomerAuth(
  identifier: string,
  password: string,
  turnstileToken?: string | null
): Promise<
  | { payload: JwtPayload }
  | { error: string }
  | { mfa: "verify" | "enroll"; mfaToken: string }
> {
  if (!identifier || !password) {
    return { error: CUSTOMER_GENERIC_ERROR };
  }

  const guard = await guardLogin({
    identifier,
    action: TURNSTILE_ACTIONS.customerLogin,
    turnstileToken,
  });
  if (!guard.ok) return { error: guard.error };

  // Customer sign-in accepts exactly two identifiers: the canonical Account
  // Number or a registered phone number. Email is deliberately not accepted.
  const accountNumber = normalizeAccountNumber(identifier);
  const phoneCandidates = normalizeGhanaPhone(identifier).map((value) =>
    value.trim()
  );
  const trimmedIdentifier = identifier.trim();

  let customer: Awaited<ReturnType<typeof db.customer.findFirst>> = null;

  if (isAccountNumber(identifier)) {
    // Globally unique and unambiguous.
    customer = await db.customer.findFirst({
      where: { customerId: accountNumber },
    });
  } else {
    // A phone number may be shared by family members. Only active portal
    // accounts are ambiguous; never choose one arbitrarily.
    const phoneMatches = await db.customer.findMany({
      where: {
        status: "active",
        portalEnabled: true,
        portalPasswordHash: { not: null },
        OR: [
          { phone: trimmedIdentifier },
          ...(phoneCandidates.length
            ? [{ phone: { in: phoneCandidates } }]
            : []),
        ],
      },
      select: { id: true },
      take: 2,
    });
    if (phoneMatches.length > 1) {
      return { error: SHARED_PHONE_MESSAGE };
    }
    if (phoneMatches.length === 1) {
      customer = await db.customer.findUnique({
        where: { id: phoneMatches[0].id },
      });
    }
  }

  const valid = await verifyPasswordConstantTime(
    password,
    customer?.portalPasswordHash
  );
  if (!customer || !valid) {
    const state = await recordLoginFailure(identifier, guard.ip, "customer_login");
    return {
      error: state.blocked
        ? cooldownMessage(state.retryAfterSeconds)
        : CUSTOMER_GENERIC_ERROR,
    };
  }

  if (
    customer.status !== "active" ||
    !customer.portalEnabled ||
    !customer.portalPasswordHash
  ) {
    return {
      error: "Your customer portal access is not available. Please contact the business.",
    };
  }

  await recordLoginSuccess(identifier, guard.ip, "customer_login");

  const mfaStep = await beginMfaStepIfRequired({
    subjectType: "customer",
    subjectId: customer.id,
    module: "customer",
    email: customer.email || customer.customerId,
    fullName: customer.fullName,
    role: "customer",
    mfaEnabled: customer.mfaEnabled,
    forcePasswordReset: customer.forcePortalPasswordReset ?? false,
    tokenVersion: customer.tokenVersion ?? 0,
  });
  if (mfaStep) return { mfa: mfaStep.mode, mfaToken: mfaStep.token };

  const payload: JwtPayload = {
    userId: customer.id,
    email: customer.email || `${customer.customerId}@bloomcore.local`,
    fullName: customer.fullName,
    role: "customer",
    modules: ["customer"],
    tenantId: customer.tenantId,
    forcePasswordReset: customer.forcePortalPasswordReset ?? false,
    tokenVersion: customer.tokenVersion ?? 0,
  };

  return { payload };
}

/**
 * Resolve a staff (MoMo worker / Susu collector) login for a specific module.
 *
 * CRITICAL: the requested `module` is just the workspace the user asked for on
 * the login screen.  The server re-checks it against the account's actual
 * capabilities.  If the account lacks the capability (or is an admin, or does
 * not exist), the request is denied with a generic error — no session is
 * created and the wrong workspace is never opened.
 */
export async function resolveStaffAuth(
  identifier: string,
  password: string,
  module: "momo" | "susu",
  turnstileToken?: string | null
): Promise<
  | { payload: JwtPayload }
  | { error: string }
  | { mfa: "verify" | "enroll"; mfaToken: string }
> {
  if (!identifier || !password) {
    return { error: STAFF_GENERIC_ERROR };
  }

  const guard = await guardLogin({
    identifier,
    action: TURNSTILE_ACTIONS.staffLogin,
    turnstileToken,
  });
  if (!guard.ok) return { error: guard.error };

  const phoneCandidates = normalizeGhanaPhone(identifier);
  const user = await db.user.findFirst({
    where: {
      OR: [
        { email: identifier.toLowerCase() },
        ...(phoneCandidates.length ? [{ phone: { in: phoneCandidates } }] : []),
      ],
    },
  });

  const valid = await verifyPasswordConstantTime(password, user?.passwordHash);
  if (!user || !valid) {
    const state = await recordLoginFailure(identifier, guard.ip, "login");
    return {
      error: state.blocked
        ? cooldownMessage(state.retryAfterSeconds)
        : STAFF_GENERIC_ERROR,
    };
  }

  // State and capability checks run only after correct credentials, so they
  // are not an enumeration oracle.
  if (user.status !== "active") {
    return {
      error: "Your account is not available. Please contact your administrator.",
    };
  }

  // Admins must use the dedicated administrator login. Never grant an admin
  // session through the shared portal.
  if (user.role === "admin") {
    return { error: STAFF_GENERIC_ERROR };
  }

  const hasCapability = module === "momo" ? user.momoEnabled : user.susuEnabled;
  if (!hasCapability) {
    return { error: STAFF_GENERIC_ERROR };
  }

  await recordLoginSuccess(identifier, guard.ip, "login");

  const mfaStep = await beginMfaStepIfRequired({
    subjectType: "user",
    subjectId: user.id,
    module,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    mfaEnabled: user.mfaEnabled,
    forcePasswordReset: user.forcePasswordReset,
    tokenVersion: user.tokenVersion,
  });
  if (mfaStep) return { mfa: mfaStep.mode, mfaToken: mfaStep.token };

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: module === "momo" ? "worker" : "collector",
    modules: [module],
    locationId: user.locationId ?? undefined,
    tenantId: user.tenantId,
    forcePasswordReset: user.forcePasswordReset,
    tokenVersion: user.tokenVersion,
  };

  return { payload };
}

function auditWorkspace(module: "momo" | "susu" | "customer" | "admin", userId: string) {
  return createAuditLog({
    userId,
    action: module === "customer" ? "auth.customer_login" : "auth.login",
    entityType: module === "customer" ? "customer" : "user",
    entityId: userId,
    details: { module },
  });
}

export async function customerLogin(
  formData: FormData
): Promise<ActionResponse | void> {
  const identifier = (formData.get("identifier") as string)?.trim();
  const password = formData.get("password") as string;
  const turnstileToken =
    (formData.get("cf-turnstile-response") as string) ??
    (formData.get("turnstileToken") as string);

  const result = await resolveCustomerAuth(
    identifier ?? "",
    password ?? "",
    turnstileToken
  );
  if ("error" in result) return { success: false, error: result.error };
  if ("mfa" in result) {
    return {
      success: true,
      mfa: result.mfa,
      mfaToken: result.mfaToken,
      redirectTo: `/mfa/${result.mfa}`,
    };
  }

  const token = await setModuleSession("customer", result.payload);
  await auditWorkspace("customer", result.payload.userId);

  return {
    success: true,
    sessionToken: token,
    redirectTo: result.payload.forcePasswordReset
      ? "/customer/first-login"
      : "/customer/dashboard",
  };
}

/**
 * Unified NON-ADMIN login used by the shared `/login` portal.
 *
 * The `role` field is the workspace the user selected on the screen.  It is
 * treated ONLY as a requested workspace and is re-validated server-side:
 *
 *   - customer → authenticate against the Customer portal
 *   - momo     → authenticate a staff account with MoMo capability
 *   - susu     → authenticate a staff account with Susu capability
 *   - admin    → rejected; the user must use `/admin/login`
 *
 * An account can never open a workspace it is not authorized for.
 */
export async function unifiedLogin(
  formData: FormData
): Promise<ActionResponse | void> {
  const role = (formData.get("role") as string)?.trim();
  const identifier = (formData.get("identifier") as string)?.trim();
  const password = formData.get("password") as string;
  const turnstileToken =
    (formData.get("cf-turnstile-response") as string) ??
    (formData.get("turnstileToken") as string);

  // The shared portal never processes the admin role.
  if (role === "admin" || !isNonAdminRole(role)) {
    return {
      success: false,
      error: "Please use the administrator login.",
      adminLogin: true,
    };
  }

  if (role === "customer") {
    const result = await resolveCustomerAuth(
      identifier ?? "",
      password ?? "",
      turnstileToken
    );
    if ("error" in result) return { success: false, error: result.error };
    if ("mfa" in result) {
      return {
        success: true,
        mfa: result.mfa,
        mfaToken: result.mfaToken,
        redirectTo: `/mfa/${result.mfa}`,
      };
    }

    const token = await setModuleSession("customer", result.payload);
    await auditWorkspace("customer", result.payload.userId);

    return {
      success: true,
      sessionToken: token,
      redirectTo: result.payload.forcePasswordReset
        ? "/customer/first-login"
        : "/customer/dashboard",
    };
  }

  // momo | susu — server re-validates the requested workspace capability.
  const mod = role as "momo" | "susu";
  const result = await resolveStaffAuth(
    identifier ?? "",
    password ?? "",
    mod,
    turnstileToken
  );
  if ("error" in result) return { success: false, error: result.error };
  if ("mfa" in result) {
    return {
      success: true,
      mfa: result.mfa,
      mfaToken: result.mfaToken,
      redirectTo: `/mfa/${result.mfa}`,
    };
  }

  const token = await setModuleSession(mod, result.payload);
  await auditWorkspace(mod, result.payload.userId);

  return {
    success: true,
    sessionToken: token,
    redirectTo: result.payload.forcePasswordReset
      ? firstLoginPathFor(mod)
      : dashboardPathFor(mod),
  };
}

/**
 * Dedicated ADMIN login used by `/admin/login`.
 *
 * Only accounts whose primary role is `admin` may authenticate here.  Non-admin
 * staff credentials are rejected with a generic error and never receive an
 * admin session.  This keeps the privileged boundary separate from the shared
 * non-admin portal.
 */
export async function adminLogin(
  formData: FormData
): Promise<ActionResponse | void> {
  const email = (formData.get("email") as string)?.trim() ?? "";
  const password = (formData.get("password") as string) ?? "";
  const turnstileToken =
    (formData.get("cf-turnstile-response") as string) ??
    (formData.get("turnstileToken") as string);

  if (!email || !password) {
    return { success: false, error: GENERIC_LOGIN_ERROR };
  }

  const guard = await guardLogin({
    identifier: email,
    action: TURNSTILE_ACTIONS.adminLogin,
    turnstileToken,
  });
  if (!guard.ok) return { success: false, error: guard.error };

  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  const valid = await verifyPasswordConstantTime(password, user?.passwordHash);
  if (!user || !valid) {
    const state = await recordLoginFailure(email, guard.ip, "admin_login");
    return {
      success: false,
      error: state.blocked
        ? cooldownMessage(state.retryAfterSeconds)
        : GENERIC_LOGIN_ERROR,
    };
  }

  if (user.status !== "active" || user.role !== "admin") {
    return { success: false, error: GENERIC_LOGIN_ERROR };
  }

  await recordLoginSuccess(email, guard.ip, "admin_login");

  const mfaStep = await beginMfaStepIfRequired({
    subjectType: "user",
    subjectId: user.id,
    module: "admin",
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    mfaEnabled: user.mfaEnabled,
    forcePasswordReset: user.forcePasswordReset,
    tokenVersion: user.tokenVersion,
  });
  if (mfaStep) {
    return {
      success: true,
      mfa: mfaStep.mode,
      mfaToken: mfaStep.token,
      redirectTo: `/mfa/${mfaStep.mode}`,
    };
  }

  const payload = await buildSessionPayload(user.id);
  const token = await setModuleSession("admin", payload);
  await auditWorkspace("admin", user.id);

  return {
    success: true,
    sessionToken: token,
    redirectTo: payload.forcePasswordReset
      ? "/admin/first-login"
      : "/admin/dashboard",
  };
}

export async function customerChangePassword(
  formData: FormData
): Promise<ActionResponse> {
  const session = await getCustomerSession();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }
  if (!(await isSessionCurrent(session))) {
    return { success: false, error: "Session expired. Please sign in again." };
  }

  const currentPassword = (formData.get("currentPassword") as string)?.trim();
  const newPassword = (formData.get("newPassword") as string)?.trim();
  const confirmPassword = (formData.get("confirmPassword") as string)?.trim();

  if (!currentPassword) {
    return { success: false, error: "Current password is required" };
  }

  if (newPassword !== confirmPassword) {
    return { success: false, error: "Passwords don't match" };
  }

  if (newPassword.length < 8) {
    return { success: false, error: "Password must be at least 8 characters" };
  }

  const customer = await db.customer.findUnique({ where: { id: session.userId } });
  if (!customer) {
    return { success: false, error: "Customer not found" };
  }

  const valid = await verifyPassword(currentPassword, customer.portalPasswordHash || "");
  if (!valid) {
    return { success: false, error: "Current password is incorrect" };
  }

  const wasForced = !!session.forcePasswordReset;

  const newHash = await hashPassword(newPassword);
  await db.customer.update({
    where: { id: session.userId },
    data: {
      portalPasswordHash: newHash,
      forcePortalPasswordReset: false,
      tokenVersion: { increment: 1 },
    },
  });

  // Re-issue customer session with the new tokenVersion so the temporary
  // password session is fully replaced and other sessions are invalidated.
  await revokeAllUserSessions("customer", session.userId, "customer_password_changed");
  const refreshed = {
    userId: session.userId,
    email: session.email,
    fullName: session.fullName,
    role: "customer" as const,
    modules: ["customer" as const],
    tenantId: session.tenantId,
    forcePasswordReset: false,
    tokenVersion: (session.tokenVersion ?? 0) + 1,
    amr: session.amr,
  };
  const token = await setModuleSession("customer", refreshed);

  await createAuditLog({
    userId: session.userId,
    action: wasForced ? "auth.first_customer_password_changed" : "auth.customer_password_changed",
    entityType: "customer",
    entityId: session.userId,
  });

  return { success: true, sessionToken: token, redirectTo: "/customer/dashboard" };
}

/** Sign out only the current tab's customer session. */
export async function customerLogout(): Promise<ActionResponse> {
  const session = await getCustomerSession();
  if (session) {
    await revokeSessionToken(session, "customer_logout");
    await createAuditLog({
      userId: session.userId,
      action: "auth.customer_logout",
      entityType: "customer",
      entityId: session.userId,
    });
  }
  return { success: true, redirectTo: "/login?role=customer" };
}
