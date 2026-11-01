"use server";

import { db } from "@/lib/db";
import {
  hashPassword,
  verifyPassword,
  setModuleSession,
  setSelectionSession,
  clearAllSessions,
  clearModuleSession,
  getAdminSession,
  getMomoSession,
  getSusuSession,
  getCustomerSession,
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
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  cooldownMessage,
  GENERIC_LOGIN_ERROR,
  guardLogin,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/security/auth-guard";
import { beginMfaStepIfRequired } from "@/lib/security/mfa-login";

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
    action: "login",
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

  // Administrator login also passes through the MFA policy gate.
  if (user.role === "admin") {
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
    if (mfaStep) redirect(`/mfa/${mfaStep}`);
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
    const payload = await issueModuleSession(user.id, "admin");
    redirect(
      payload.forcePasswordReset ? "/admin/first-login" : "/admin/dashboard"
    );
  }

  if (modules.length === 0) {
    return {
      success: false,
      error: "Your account is not registered for any module. Please contact the administrator.",
    };
  }

  if (modules.length === 1) {
    const mod = modules[0];
    const payload = await issueModuleSession(user.id, mod);

    if (payload.forcePasswordReset) {
      redirect(firstLoginPathFor(mod));
    }
    redirect(dashboardPathFor(mod));
  }

  // Dual-role: let the person choose their workspace. No arbitrary default.
  const selectionToken = await createSelectionToken({
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    modules,
  });
  await setSelectionSession(selectionToken);
  redirect("/select-workspace");
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

/** Issue a fresh JWT for `userId` into the given module's cookie. */
export async function issueModuleSession(userId: string, module: ModuleName): Promise<JwtPayload> {
  const payload = await buildSessionPayload(userId);
  await setModuleSession(module, payload);
  return payload;
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

  await issueModuleSession(selection.userId, module);

  // The selection token is single-use.
  (await cookies()).delete(SELECTION_COOKIE_NAME);

  await createAuditLog({
    userId: selection.userId,
    action: "auth.workspace_selected",
    entityType: "user",
    entityId: selection.userId,
    details: { module },
  });

  return { success: true };
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
  for (const [mod, session] of sources) {
    if (session && (await isSessionCurrent(session))) {
      userId = session.userId;
      sourceModule = mod;
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

  await setModuleSession(target, payload);
  await clearModuleSession(sourceModule);

  await createAuditLog({
    userId,
    action: "auth.workspace_switched",
    entityType: "user",
    entityId: userId,
    details: { from: sourceModule, to: target },
  });

  return { success: true };
}

export async function logout(): Promise<void> {
  const sessions = [
    await getAdminSession(),
    await getMomoSession(),
    await getSusuSession(),
    await getCustomerSession(),
  ];
  const active = sessions.find(Boolean);
  if (active) {
    await revokeSessionToken(active, "logout");
    await createAuditLog({
      userId: active.userId,
      action: "auth.logout",
      entityType: active.role === "customer" ? "customer" : "user",
      entityId: active.userId,
    });
  }
  await clearAllSessions();
  redirect("/login");
}

/**
 * Verify the current user's password (for step-up reauthentication).
 * Does not log the password.  Only checks against the active session.
 *
 * Security: we prefer the admin session and refuse to fall through to
 * worker/collector sessions when the admin session is unavailable — this
 * prevents silently verifying against the wrong user if the admin cookie
 * is missing or temporarily invalid.
 */
export async function verifyPasswordAction(
  password: string
): Promise<ActionResponse> {
  // Trim whitespace from pasted passwords to avoid hash mismatch
  const trimmedPassword = password.trim();

  // Try each session, but prefer admin and log which module was used.
  const adminUser = await getAdminSession();
  const momoUser = await getMomoSession();
  const susuUser = await getSusuSession();

  let context: { module: ModuleName; user: JwtPayload } | null = null;

  if (adminUser) {
    context = { module: "admin", user: adminUser };
  } else if (momoUser) {
    context = { module: "momo", user: momoUser };
  } else if (susuUser) {
    context = { module: "susu", user: susuUser };
  }

  if (!context) {
    return { success: false, error: "Not authenticated" };
  }

  if (!(await isSessionCurrent(context.user))) {
    await clearAllSessions();
    return { success: false, error: "Session expired. Please sign in again." };
  }

  const dbUser = await db.user.findUnique({ where: { id: context.user.userId } });
  if (!dbUser) {
    return { success: false, error: "User not found" };
  }

  const valid = await verifyPassword(trimmedPassword, dbUser.passwordHash);
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
    await clearAllSessions();
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
  const refreshed = await buildSessionPayload(session.userId);
  await setModuleSession(context.module, refreshed);

  await createAuditLog({
    userId: session.userId,
    action: wasForced ? "auth.first_login_password_changed" : "auth.password_changed",
    entityType: "user",
    entityId: session.userId,
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Shared credential resolvers
//
// These enforce server-side capability checks so that the browser-supplied
// "requested workspace" (role) can NEVER become proof of access.  The role the
// user clicks on the login screen is only a *requested* workspace; the server
// re-verifies it against the account's real capabilities below.
// ---------------------------------------------------------------------------

const CUSTOMER_GENERIC_ERROR = "Invalid Customer ID, phone, email or password.";
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
): Promise<{ payload: JwtPayload } | { error: string }> {
  if (!identifier || !password) {
    return { error: CUSTOMER_GENERIC_ERROR };
  }

  const guard = await guardLogin({
    identifier,
    action: "customer_login",
    turnstileToken,
  });
  if (!guard.ok) return { error: guard.error };

  // Normalize Ghanaian phone formats so 024... and +233... match the same record.
  const phoneCandidates = normalizeGhanaPhone(identifier);

  const customer = await db.customer.findFirst({
    where: {
      OR: [
        { customerId: identifier },
        { email: identifier.toLowerCase() },
        { phone: identifier },
        ...(phoneCandidates.length ? [{ phone: { in: phoneCandidates } }] : []),
      ],
    },
  });

  // A portal identifier must resolve to exactly one customer. Identical emails
  // or phone numbers across tenants are ambiguous, so the request is refused
  // rather than silently choosing one tenant's record.
  if (customer) {
    const matches = await db.customer.count({
      where: {
        OR: [
          { customerId: identifier },
          { email: identifier.toLowerCase() },
          { phone: identifier },
          ...(phoneCandidates.length ? [{ phone: { in: phoneCandidates } }] : []),
        ],
      },
    });
    if (matches !== 1) {
      return { error: CUSTOMER_GENERIC_ERROR };
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
): Promise<{ payload: JwtPayload } | { error: string } | { mfa: "verify" | "enroll" }> {
  if (!identifier || !password) {
    return { error: STAFF_GENERIC_ERROR };
  }

  const guard = await guardLogin({
    identifier,
    action: "login",
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
  if (mfaStep) return { mfa: mfaStep };

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

  await setModuleSession("customer", result.payload);
  await auditWorkspace("customer", result.payload.userId);

  if (result.payload.forcePasswordReset) {
    redirect("/customer/first-login");
  }
  redirect("/customer/dashboard");
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

    await setModuleSession("customer", result.payload);
    await auditWorkspace("customer", result.payload.userId);

    if (result.payload.forcePasswordReset) {
      redirect("/customer/first-login");
    }
    redirect("/customer/dashboard");
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
  if ("mfa" in result) redirect(`/mfa/${result.mfa}`);

  await setModuleSession(mod, result.payload);
  await auditWorkspace(mod, result.payload.userId);

  if (result.payload.forcePasswordReset) {
    redirect(firstLoginPathFor(mod));
  }
  redirect(dashboardPathFor(mod));
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
    action: "admin_login",
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
  if (mfaStep) redirect(`/mfa/${mfaStep}`);

  const payload = await buildSessionPayload(user.id);
  await setModuleSession("admin", payload);
  await auditWorkspace("admin", user.id);

  if (payload.forcePasswordReset) {
    redirect("/admin/first-login");
  }
  redirect("/admin/dashboard");
}

export async function customerChangePassword(
  formData: FormData
): Promise<ActionResponse> {
  const session = await getCustomerSession();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }
  if (!(await isSessionCurrent(session))) {
    await clearAllSessions();
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
  };
  await setModuleSession("customer", refreshed);

  await createAuditLog({
    userId: session.userId,
    action: wasForced ? "auth.first_customer_password_changed" : "auth.customer_password_changed",
    entityType: "customer",
    entityId: session.userId,
  });

  return { success: true };
}

export async function customerLogout(): Promise<void> {
  const session = await getCustomerSession();
  if (session) {
    await createAuditLog({
      userId: session.userId,
      action: "auth.customer_logout",
      entityType: "customer",
      entityId: session.userId,
    });
  }
  await clearModuleSession("customer");
  redirect("/login?role=customer");
}
