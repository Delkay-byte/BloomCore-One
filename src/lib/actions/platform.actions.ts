"use server";

import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import {
  authenticatePlatformAdmin,
  clearPlatformSession,
  getPlatformAdminOrNull,
  getPlatformSession,
  hashPlatformPassword,
  requirePlatformAdmin,
  revokePlatformSession,
  setPlatformSession,
  validatePasswordPolicy,
  verifyPlatformToken,
  PLATFORM_COOKIE,
  type PlatformSession,
} from "@/lib/platform-auth";
import {
  createPlatformAuditLog,
  getPlatformAuditLogs,
  PLATFORM_AUDIT_ACTIONS,
} from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  guardLogin,
  recordLoginFailure,
  recordLoginSuccess,
  cooldownMessage,
  GENERIC_LOGIN_ERROR,
} from "@/lib/security/auth-guard";
import { logSecurityEvent } from "@/lib/security/log";
import { RATE_LIMITS } from "@/lib/security/config";
import { beginMfaStepIfRequired } from "@/lib/security/mfa-login";
import { headers, cookies } from "next/headers";

export interface PlatformActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Credential helpers — one-time temporary credentials, never logged
// ---------------------------------------------------------------------------

/** Password policy shared with the self-service reset flow. */
function generateTempPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const pick = (set: string) => set[randomBytes(1)[0] % set.length];
  let out = pick(upper) + pick(lower) + pick(digits);
  for (let i = 0; i < 9; i++) out += pick(all);
  // Shuffle so the guaranteed characters are not in predictable positions.
  return out
    .split("")
    .sort(() => randomBytes(1)[0] % 2 === 0 ? 1 : -1)
    .join("");
}

const TENANT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Server-generated tenant code, e.g. "BT-7K4M2X". Unique by construction. */
async function generateTenantCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++) {
      suffix += TENANT_CODE_ALPHABET[randomBytes(1)[0] % TENANT_CODE_ALPHABET.length];
    }
    const code = `BT-${suffix}`;
    const existing = await db.businessTenant.findUnique({ where: { code } });
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique tenant code");
}

async function auditPlatformEvent(
  session: PlatformSession | null,
  action: string,
  params: Omit<Parameters<typeof createPlatformAuditLog>[0], "action" | "actorId" | "actorEmail"> = {}
) {
  await createPlatformAuditLog({
    actorId: session?.adminId ?? null,
    actorEmail: session?.email ?? null,
    action,
    ...params,
  });
}

// ---------------------------------------------------------------------------
// Platform authentication
// ---------------------------------------------------------------------------

export async function platformLogin(
  formData: FormData
): Promise<PlatformActionResponse | void> {
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
    action: "platform_login",
    turnstileToken,
  });
  if (!guard.ok) return { success: false, error: guard.error };

  const result = await authenticatePlatformAdmin(email, password);
  if (!result.ok) {
    // One generic failure message for all reasons — no account enumeration.
    const state = await recordLoginFailure(
      email,
      guard.ip,
      "platform_login"
    );
    await auditPlatformEvent(null, PLATFORM_AUDIT_ACTIONS.PLATFORM_LOGIN_FAILED, {
      details: { attempted: true },
      ipAddress: guard.ip,
    });
    return {
      success: false,
      error: state.blocked
        ? cooldownMessage(state.retryAfterSeconds)
        : GENERIC_LOGIN_ERROR,
    };
  }

  await recordLoginSuccess(email, guard.ip, "platform_login");

  const adminRow = await db.platformSuperAdmin.findUnique({
    where: { id: result.admin.adminId },
    select: { mfaEnabled: true },
  });
  const mfaStep = await beginMfaStepIfRequired({
    subjectType: "platform",
    subjectId: result.admin.adminId,
    module: "platform",
    email: result.admin.email,
    fullName: result.admin.fullName,
    role: "admin",
    mfaEnabled: Boolean(adminRow?.mfaEnabled),
    forcePasswordReset: result.admin.forcePasswordReset,
    tokenVersion: result.tokenVersion,
  });
  if (mfaStep) redirect(`/mfa/${mfaStep}`);

  await setPlatformSession({
    adminId: result.admin.adminId,
    email: result.admin.email,
    fullName: result.admin.fullName,
    forcePasswordReset: result.admin.forcePasswordReset,
    tokenVersion: result.tokenVersion,
    amr: "pwd",
  });
  await db.platformSuperAdmin.update({
    where: { id: result.admin.adminId },
    data: { lastLoginAt: new Date() },
  });
  await auditPlatformEvent(result.admin, PLATFORM_AUDIT_ACTIONS.PLATFORM_LOGIN, {
    ipAddress: await safeClientIp(),
  });

  if (result.admin.forcePasswordReset) {
    redirect("/platform/first-login");
  }
  redirect("/platform/dashboard");
}

export async function platformLogout(): Promise<void> {
  const session = await getPlatformSession();
  if (session) {
    const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
    const payload = token ? await verifyPlatformToken(token) : null;
    await revokePlatformSession(payload, "platform_logout");
    await auditPlatformEvent(session, PLATFORM_AUDIT_ACTIONS.PLATFORM_LOGOUT);
  }
  await clearPlatformSession();
  redirect("/platform/login");
}

export async function platformChangePassword(
  formData: FormData
): Promise<PlatformActionResponse> {
  const session = await getPlatformAdminOrNull();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  const currentPassword = (formData.get("currentPassword") as string) ?? "";
  const newPassword = (formData.get("newPassword") as string) ?? "";
  const confirmPassword = (formData.get("confirmPassword") as string) ?? "";

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { success: false, error: "All password fields are required" };
  }
  if (newPassword !== confirmPassword) {
    return { success: false, error: "New passwords do not match" };
  }
  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) {
    return { success: false, error: policyError };
  }

  const admin = await db.platformSuperAdmin.findUnique({
    where: { id: session.adminId },
  });
  if (!admin) {
    return { success: false, error: "Not authenticated" };
  }
  const bcrypt = await import("bcryptjs");
  if (!(await bcrypt.compare(currentPassword, admin.passwordHash))) {
    return { success: false, error: "Current password is incorrect" };
  }

  await db.platformSuperAdmin.update({
    where: { id: admin.id },
    data: {
      passwordHash: await hashPlatformPassword(newPassword),
      forcePasswordReset: false,
      tokenVersion: { increment: 1 },
    },
  });

  // Re-issue the platform session with the new tokenVersion so the operator
  // is not logged out by their own password change.
  await setPlatformSession({
    adminId: admin.id,
    email: admin.email,
    fullName: admin.fullName,
    forcePasswordReset: false,
    tokenVersion: admin.tokenVersion + 1,
  });

  await auditPlatformEvent(session, PLATFORM_AUDIT_ACTIONS.PLATFORM_PASSWORD_CHANGED);
  revalidatePath("/platform/settings");
  revalidatePath("/platform/first-login");
  return { success: true };
}

async function safeClientIp(): Promise<string | null> {
  try {
    const h = await headers();
    const { getClientIp } = await import("@/lib/security/client-ip");
    return getClientIp(h).ip;
  } catch {
    return null;
  }
}

/**
 * Read-only platform screens still re-check the platform session. A layout
 * redirect is not an authorization control for a server action that can be
 * invoked directly.
 */
async function requirePlatformRead(): Promise<PlatformSession> {
  const session = await getPlatformAdminOrNull();
  if (!session) throw new Error("Not authenticated");
  if (session.forcePasswordReset) throw new Error("Password change required");
  return session;
}

/** Rate limit for platform-level mutations. */
async function platformSensitiveAllowed(
  session: PlatformSession,
  scope: string
): Promise<boolean> {
  const result = await consumeRateLimit(
    scope,
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!result.allowed) {
    logSecurityEvent({
      event: "platform.sensitive_rate_limited",
      outcome: "blocked",
      actorType: "platform_admin",
      actorId: session.adminId,
      route: scope,
    });
  }
  return result.allowed;
}

// ---------------------------------------------------------------------------
// Platform overview (dashboard)
// ---------------------------------------------------------------------------

export async function getPlatformOverview() {
  const session = await requirePlatformRead();

  const [
    total,
    active,
    suspended,
    provisioning,
    archived,
    momoOnly,
    susuOnly,
    both,
    onboardingNotStarted,
    onboardingInProgress,
    recentTenants,
  ] = await Promise.all([
    db.businessTenant.count(),
    db.businessTenant.count({ where: { status: "ACTIVE" } }),
    db.businessTenant.count({ where: { status: "SUSPENDED" } }),
    db.businessTenant.count({ where: { status: "PROVISIONING" } }),
    db.businessTenant.count({ where: { status: "ARCHIVED" } }),
    db.businessTenant.count({ where: { momoEnabled: true, susuEnabled: false } }),
    db.businessTenant.count({ where: { momoEnabled: false, susuEnabled: true } }),
    db.businessTenant.count({ where: { momoEnabled: true, susuEnabled: true } }),
    db.businessTenant.count({ where: { onboardingStatus: "NOT_STARTED" } }),
    db.businessTenant.count({ where: { onboardingStatus: "IN_PROGRESS" } }),
    db.businessTenant.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true, code: true, name: true, status: true,
        momoEnabled: true, susuEnabled: true, createdAt: true,
      },
    }),
  ]);

  const recentActivity = await getPlatformAuditLogs({ page: 1, limit: 8 });

  // Practical health: database connectivity + build identity only.
  let database: "connected" | "unavailable" = "unavailable";
  try {
    await db.$queryRaw`SELECT 1`;
    database = "connected";
  } catch {
    database = "unavailable";
  }
  const commit =
    process.env.GIT_COMMIT ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.SOURCE_VERSION ||
    null;

  return {
    session,
    totals: { total, active, suspended, provisioning, archived },
    modules: { momoOnly, susuOnly, both, momoEnabled: momoOnly + both, susuEnabled: susuOnly + both },
    onboarding: { notStarted: onboardingNotStarted, inProgress: onboardingInProgress },
    recentTenants,
    recentActivity: recentActivity.logs,
    health: {
      database,
      appEnv: process.env.APP_ENV || null,
      nodeEnv: process.env.NODE_ENV || null,
      commit,
      checkedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tenant directory
// ---------------------------------------------------------------------------

export type TenantModuleFilter = "all" | "momo" | "susu" | "both";
export type TenantStatusFilter = "all" | "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export type TenantOnboardingFilter = "all" | "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";

export async function listTenants(options: {
  search?: string;
  module?: TenantModuleFilter;
  status?: TenantStatusFilter;
  onboarding?: TenantOnboardingFilter;
  page?: number;
  limit?: number;
}) {
  await requirePlatformRead();

  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));

  const where: Record<string, unknown> = {};
  const search = options.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { code: { contains: search.toUpperCase() } },
    ];
  }
  if (options.module === "momo") {
    where.momoEnabled = true;
    where.susuEnabled = false;
  }
  if (options.module === "susu") {
    where.momoEnabled = false;
    where.susuEnabled = true;
  }
  if (options.module === "both") {
    where.momoEnabled = true;
    where.susuEnabled = true;
  }
  if (options.status && options.status !== "all") where.status = options.status;
  if (options.onboarding && options.onboarding !== "all") where.onboardingStatus = options.onboarding;

  const [tenants, total] = await Promise.all([
    db.businessTenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        code: true,
        name: true,
        contactEmail: true,
        contactPhone: true,
        momoEnabled: true,
        susuEnabled: true,
        status: true,
        onboardingStatus: true,
        createdAt: true,
        primaryAdminUserId: true,
        _count: { select: { users: true } },
      },
    }),
    db.businessTenant.count({ where }),
  ]);

  // primaryAdminUserId is a plain reference (not a foreign key), so the
  // administrator's display details are resolved in a second scoped query.
  const adminIds = [...new Set(tenants.map((t) => t.primaryAdminUserId).filter(Boolean))] as string[];
  const admins = await db.user.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, fullName: true, email: true, status: true },
  });
  const adminById = new Map(admins.map((a) => [a.id, a]));

  return {
    tenants: tenants.map((t) => ({
      ...t,
      primaryAdmin: t.primaryAdminUserId ? adminById.get(t.primaryAdminUserId) ?? null : null,
    })),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

export async function getTenantDetail(tenantId: string) {
  await requirePlatformRead();

  const tenant = await db.businessTenant.findUnique({
    where: { id: tenantId },
  });
  if (!tenant) return null;

  // primaryAdminUserId is a plain reference; resolve the account separately.
  const primaryAdmin = tenant.primaryAdminUserId
    ? await db.user.findUnique({
        where: { id: tenant.primaryAdminUserId },
        select: {
          id: true, fullName: true, email: true, phone: true,
          status: true, forcePasswordReset: true,
        },
      })
    : null;

  // Aggregate operational counts only — never customer-level financial data.
  const [workers, locations, dailyAccounts, lastDailyAccount, collectors, customers, contributions, withdrawals] =
    await Promise.all([
      db.user.count({ where: { tenantId, role: { in: ["worker", "collector"] }, status: "active" } }),
      db.location.count({ where: { tenantId } }),
      db.dailyAccount.count({ where: { tenantId } }),
      db.dailyAccount.findFirst({
        where: { tenantId, submittedAt: { not: null } },
        orderBy: { submittedAt: "desc" },
        select: { submittedAt: true },
      }),
      db.collector.count({ where: { tenantId, status: "active" } }),
      db.customer.count({ where: { tenantId } }),
      db.contribution.count({ where: { tenantId } }),
      db.withdrawal.count({ where: { tenantId } }),
    ]);

  const tenantAudit = await getPlatformAuditLogs({ page: 1, limit: 10, tenantId });

  return {
    tenant,
    primaryAdmin,
    aggregates: {
      workers,
      locations,
      dailyAccounts,
      lastSubmittedAt: lastDailyAccount?.submittedAt ?? null,
      collectors,
      customers,
      contributions,
      withdrawals,
    },
    audit: tenantAudit.logs,
  };
}

// ---------------------------------------------------------------------------
// Tenant enrollment — atomic tenant + primary administrator creation
// ---------------------------------------------------------------------------

export interface EnrollTenantInput {
  name: string;
  legalName?: string;
  contactPhone?: string;
  contactEmail?: string;
  address?: string;
  momoEnabled: boolean;
  susuEnabled: boolean;
  adminFullName: string;
  adminEmail: string;
  adminPhone?: string;
  onboardingStatus?: "NOT_STARTED" | "IN_PROGRESS";
}

/**
 * Enroll a new business.
 *
 * The tenant, its server-generated code, its primary administrator account and
 * the audit trail are created in ONE transaction — a failure leaves no
 * partially provisioned tenant with broken authentication. The temporary
 * administrator password is returned exactly once; only its hash is stored.
 */
export async function enrollTenant(
  input: EnrollTenantInput
): Promise<PlatformActionResponse> {
  const session = await requirePlatformAdmin();
  if (!(await platformSensitiveAllowed(session, "platform:mutate"))) {
    return {
      success: false,
      error: "Too many administrative requests. Please wait and try again.",
    };
  }

  const name = input.name?.trim();
  const adminEmail = input.adminEmail?.trim().toLowerCase();
  if (!name || name.length < 2) {
    return { success: false, error: "Business name is required (min 2 characters)" };
  }
  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return { success: false, error: "A valid administrator email is required" };
  }
  if (!input.adminFullName || input.adminFullName.trim().length < 2) {
    return { success: false, error: "Administrator full name is required" };
  }
  // Only valid module combinations may be enrolled.
  if (!input.momoEnabled && !input.susuEnabled) {
    return {
      success: false,
      error: "A business must be enrolled for MoMo, Susu, or both modules",
    };
  }

  const existingAdmin = await db.user.findUnique({ where: { email: adminEmail } });
  if (existingAdmin) {
    return {
      success: false,
      error: "A staff account with this email already exists. Choose a different administrator email.",
    };
  }

  const code = await generateTenantCode();
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPlatformPassword(tempPassword);

  try {
    const created = await db.$transaction(async (tx) => {
      const tenant = await tx.businessTenant.create({
        data: {
          code,
          name,
          legalName: input.legalName?.trim() || null,
          contactPhone: input.contactPhone?.trim() || null,
          contactEmail: input.contactEmail?.trim().toLowerCase() || null,
          address: input.address?.trim() || null,
          momoEnabled: input.momoEnabled,
          susuEnabled: input.susuEnabled,
          status: "ACTIVE",
          onboardingStatus: input.onboardingStatus ?? "IN_PROGRESS",
          activatedAt: new Date(),
        },
      });

      const admin = await tx.user.create({
        data: {
          email: adminEmail,
          fullName: input.adminFullName.trim(),
          phone: input.adminPhone?.trim() || null,
          role: "admin",
          status: "active",
          passwordHash,
          forcePasswordReset: true,
          momoEnabled: true,
          susuEnabled: true,
          tenantId: tenant.id,
        },
      });

      await tx.businessTenant.update({
        where: { id: tenant.id },
        data: { primaryAdminUserId: admin.id },
      });

      await tx.platformAuditLog.create({
        data: {
          actorId: session.adminId,
          actorEmail: session.email,
          action: PLATFORM_AUDIT_ACTIONS.TENANT_CREATED,
          tenantId: tenant.id,
          tenantCode: tenant.code,
          entityType: "BusinessTenant",
          entityId: tenant.id,
          details: JSON.stringify({
            name: tenant.name,
            momoEnabled: tenant.momoEnabled,
            susuEnabled: tenant.susuEnabled,
            adminEmail: admin.email,
          }),
        },
      });
      await tx.platformAuditLog.create({
        data: {
          actorId: session.adminId,
          actorEmail: session.email,
          action: PLATFORM_AUDIT_ACTIONS.TENANT_ADMIN_PROVISIONED,
          tenantId: tenant.id,
          tenantCode: tenant.code,
          entityType: "User",
          entityId: admin.id,
          details: JSON.stringify({ adminEmail: admin.email, credential: "one-time" }),
        },
      });

      return { tenant, admin };
    });

    revalidatePath("/platform/tenants");
    revalidatePath("/platform/dashboard");

    return {
      success: true,
      data: {
        tenantId: created.tenant.id,
        tenantCode: created.tenant.code,
        adminEmail: created.admin.email,
        // One-time credential for out-of-band handover. Never logged.
        temporaryPassword: tempPassword,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("Unique constraint")) {
      return { success: false, error: "A tenant with these details already exists" };
    }
    return { success: false, error: "Enrollment failed. No partial records were created." };
  }
}

// ---------------------------------------------------------------------------
// Tenant lifecycle + configuration
// ---------------------------------------------------------------------------

export async function setTenantStatus(
  tenantId: string,
  action: "activate" | "suspend" | "reactivate",
  reason?: string
): Promise<PlatformActionResponse> {
  const session = await requirePlatformAdmin();
  if (!(await platformSensitiveAllowed(session, "platform:mutate"))) {
    return {
      success: false,
      error: "Too many administrative requests. Please wait and try again.",
    };
  }

  const tenant = await db.businessTenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { success: false, error: "Tenant not found" };

  const now = new Date();
  let nextStatus: string;
  let auditAction: string;

  if (action === "suspend") {
    if (tenant.status !== "ACTIVE" && tenant.status !== "PROVISIONING") {
      return { success: false, error: `Cannot suspend a ${tenant.status.toLowerCase()} tenant` };
    }
    if (!reason || reason.trim().length < 3) {
      return { success: false, error: "A reason is required to suspend a business" };
    }
    nextStatus = "SUSPENDED";
    auditAction = PLATFORM_AUDIT_ACTIONS.TENANT_SUSPENDED;
  } else {
    if (tenant.status !== "SUSPENDED" && tenant.status !== "PROVISIONING") {
      return { success: false, error: `Cannot activate a ${tenant.status.toLowerCase()} tenant` };
    }
    nextStatus = "ACTIVE";
    auditAction =
      tenant.status === "SUSPENDED"
        ? PLATFORM_AUDIT_ACTIONS.TENANT_REACTIVATED
        : PLATFORM_AUDIT_ACTIONS.TENANT_ACTIVATED;
  }

  await db.businessTenant.update({
    where: { id: tenantId },
    data:
      nextStatus === "SUSPENDED"
        ? { status: nextStatus, suspendedAt: now, suspensionReason: reason!.trim() }
        : { status: nextStatus, activatedAt: now, suspendedAt: null, suspensionReason: null },
  });

  await auditPlatformEvent(session, auditAction, {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    entityType: "BusinessTenant",
    entityId: tenant.id,
    reason: action === "suspend" ? reason!.trim() : (reason?.trim() || null),
    details: { from: tenant.status, to: nextStatus },
  });

  revalidatePath("/platform/tenants");
  revalidatePath(`/platform/tenants/${tenantId}`);
  return { success: true };
}

export async function updateTenantProfile(
  tenantId: string,
  formData: FormData
): Promise<PlatformActionResponse> {
  const session = await requirePlatformAdmin();
  if (!(await platformSensitiveAllowed(session, "platform:mutate"))) {
    return {
      success: false,
      error: "Too many administrative requests. Please wait and try again.",
    };
  }

  const tenant = await db.businessTenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { success: false, error: "Tenant not found" };

  const name = (formData.get("name") as string)?.trim();
  if (!name || name.length < 2) {
    return { success: false, error: "Business name is required" };
  }

  await db.businessTenant.update({
    where: { id: tenantId },
    data: {
      name,
      legalName: (formData.get("legalName") as string)?.trim() || null,
      contactPhone: (formData.get("contactPhone") as string)?.trim() || null,
      contactEmail: (formData.get("contactEmail") as string)?.trim().toLowerCase() || null,
      address: (formData.get("address") as string)?.trim() || null,
    },
  });

  await auditPlatformEvent(session, PLATFORM_AUDIT_ACTIONS.TENANT_PROFILE_UPDATED, {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    entityType: "BusinessTenant",
    entityId: tenant.id,
    details: { name },
  });

  revalidatePath(`/platform/tenants/${tenantId}`);
  return { success: true };
}

/**
 * Enable or disable a tenant's modules. Both modules disabled is not a valid
 * operating configuration — use suspension instead. Existing records are never
 * deleted when a module is disabled; only new operations are rejected.
 */
export async function updateTenantModules(
  tenantId: string,
  momoEnabled: boolean,
  susuEnabled: boolean
): Promise<PlatformActionResponse> {
  const session = await requirePlatformAdmin();
  if (!(await platformSensitiveAllowed(session, "platform:mutate"))) {
    return {
      success: false,
      error: "Too many administrative requests. Please wait and try again.",
    };
  }

  const tenant = await db.businessTenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { success: false, error: "Tenant not found" };
  if (tenant.status === "ARCHIVED") {
    return { success: false, error: "An archived tenant cannot be reconfigured" };
  }
  if (!momoEnabled && !susuEnabled) {
    return {
      success: false,
      error: "A business cannot operate with both modules disabled. Suspend the tenant instead.",
    };
  }
  if (momoEnabled === tenant.momoEnabled && susuEnabled === tenant.susuEnabled) {
    return { success: true };
  }

  await db.businessTenant.update({
    where: { id: tenantId },
    data: { momoEnabled, susuEnabled },
  });

  await auditPlatformEvent(session, PLATFORM_AUDIT_ACTIONS.TENANT_MODULES_CHANGED, {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    entityType: "BusinessTenant",
    entityId: tenant.id,
    details: {
      from: { momo: tenant.momoEnabled, susu: tenant.susuEnabled },
      to: { momo: momoEnabled, susu: susuEnabled },
    },
  });

  revalidatePath(`/platform/tenants/${tenantId}`);
  return { success: true };
}

/**
 * Secure recovery for a tenant administrator: issue a ONE-TIME temporary
 * password, force a change at next login and invalidate existing sessions.
 * The current password is never shown or retrievable.
 */
export async function resetTenantAdminAccess(
  tenantId: string,
  adminUserId: string
): Promise<PlatformActionResponse> {
  const session = await requirePlatformAdmin();
  if (!(await platformSensitiveAllowed(session, "platform:mutate"))) {
    return {
      success: false,
      error: "Too many administrative requests. Please wait and try again.",
    };
  }

  const tenant = await db.businessTenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { success: false, error: "Tenant not found" };

  const admin = await db.user.findFirst({
    where: { id: adminUserId, tenantId, role: "admin" },
  });
  if (!admin) {
    return { success: false, error: "Administrator not found for this business" };
  }

  const tempPassword = generateTempPassword();
  await db.user.update({
    where: { id: admin.id },
    data: {
      passwordHash: await hashPlatformPassword(tempPassword),
      forcePasswordReset: true,
      tokenVersion: { increment: 1 },
    },
  });

  await auditPlatformEvent(session, PLATFORM_AUDIT_ACTIONS.TENANT_ADMIN_RECOVERY_INITIATED, {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    entityType: "User",
    entityId: admin.id,
    details: { adminEmail: admin.email, credential: "one-time" },
  });

  revalidatePath(`/platform/tenants/${tenantId}`);
  return {
    success: true,
    data: {
      adminEmail: admin.email,
      // One-time credential for out-of-band handover. Never logged.
      temporaryPassword: tempPassword,
    },
  };
}

// ---------------------------------------------------------------------------
// Platform audit history
// ---------------------------------------------------------------------------

export async function getPlatformAuditPage(options: {
  page?: number;
  action?: string;
  tenantCode?: string;
}) {
  await requirePlatformRead();
  const where: Record<string, unknown> = {};
  if (options.action) where.action = options.action;
  if (options.tenantCode) where.tenantCode = options.tenantCode.toUpperCase();

  const page = Math.max(1, options.page ?? 1);
  const limit = 30;
  const [logs, total] = await Promise.all([
    db.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.platformAuditLog.count({ where }),
  ]);
  return { logs, total, page, limit, pages: Math.ceil(total / limit) };
}
