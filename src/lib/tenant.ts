import { db } from "./db";
import { redirect } from "next/navigation";
import {
  getAdminSession,
  getMomoSession,
  getSusuSession,
  getCustomerSession,
  isSessionCurrent,
  clearAllSessions,
  readModuleCookie,
  type JwtPayload,
  type ModuleName,
} from "./auth";

/**
 * ============================================================================
 * CANONICAL TENANT CONTEXT
 * ============================================================================
 *
 * Every tenant-owned read or write in this application resolves its authorized
 * tenant through this module. There is deliberately no other way to obtain a
 * tenantId.
 *
 * The chain is always:
 *
 *   module session cookie
 *        ↓  (JWT signature + server-side session timing + tokenVersion)
 *   verified JwtPayload
 *        ↓  (User row re-read from the database)
 *   user.tenantId
 *        ↓  (BusinessTenant row re-read from the database)
 *   BusinessTenant with status ACTIVE
 *        ↓  (module entitlement)
 *   TenantContext
 *
 * A browser-supplied `tenantId` is NEVER an input to this function. Client
 * code cannot influence which tenant it resolves to, which is what makes
 * cross-tenant ID substitution structurally impossible rather than merely
 * discouraged.
 *
 * FAIL CLOSED: if any link in the chain is missing — no session, unknown user,
 * user with no tenant, tenant missing, tenant suspended/archived, module not
 * entitled — the resolver returns null. Callers must treat null as "deny".
 * There is no global fallback and no "first tenant" default.
 */

export interface TenantContext {
  /** Authorized tenant id — the ONLY tenant this request may touch. */
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  momoEnabled: boolean;
  susuEnabled: boolean;
  /** Authenticated user id (User.id, or Customer.id for the portal). */
  userId: string;
  role: string;
  /** Business modules this session may use, intersected with tenant entitlement. */
  modules: ("momo" | "susu")[];
}

/** Raised when a tenant cannot be resolved. Never swallowed into a fallback. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

/**
 * Which business modules does this tenant actually have enabled?
 * Tenant entitlement is the authority — a user's own capability flag is not.
 */
function entitledModules(tenant: {
  momoEnabled: boolean;
  susuEnabled: boolean;
}): ("momo" | "susu")[] {
  const out: ("momo" | "susu")[] = [];
  if (tenant.momoEnabled) out.push("momo");
  if (tenant.susuEnabled) out.push("susu");
  return out;
}

/** Tenant statuses that permit tenant operations. */
const OPERABLE_STATUSES = new Set(["ACTIVE"]);

/**
 * Resolve the tenant context for a staff module session.
 *
 * @param module  which module cookie to read — this is the authorization scope
 * @param requiredModule  when set, the tenant must have this module enabled
 */
export async function getTenantContext(
  module: ModuleName,
  requiredModule?: "momo" | "susu"
): Promise<TenantContext | null> {
  try {
    const session =
      module === "admin"
        ? await getAdminSession()
        : module === "momo"
          ? await getMomoSession()
          : module === "susu"
            ? await getSusuSession()
            : await getCustomerSession();

    if (!session?.userId) return null;

    // Re-validate against the database (status + tokenVersion) — a cookie that
    // was valid at login is not trusted on its own.
    if (!(await isSessionCurrent(session))) return null;

    // Customer portal sessions resolve a Customer, not a User.
    if (session.role === "customer") {
      return await getCustomerTenantContext(session);
    }

    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        role: true,
        status: true,
        tenantId: true,
        momoEnabled: true,
        susuEnabled: true,
      },
    });
    if (!user || user.status !== "active") return null;

    // No tenant assigned => not authorized for any tenant data. Fail closed.
    if (!user.tenantId) return null;

    const tenant = await db.businessTenant.findUnique({
      where: { id: user.tenantId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        momoEnabled: true,
        susuEnabled: true,
      },
    });
    if (!tenant) return null;
    if (!OPERABLE_STATUSES.has(tenant.status)) return null;

    const entitled = entitledModules(tenant);

    // Module entitlement is enforced from the TENANT record. A user flag alone
    // never grants access to a module the business has not been enrolled for.
    if (requiredModule && !entitled.includes(requiredModule)) return null;

    // Intersect the user's own capability with the tenant's entitlement.
    const userModules: ("momo" | "susu")[] = [];
    if (user.momoEnabled) userModules.push("momo");
    if (user.susuEnabled) userModules.push("susu");
    const effective = entitled.filter((m) => userModules.includes(m));

    // A tenant administrator manages the business, so they hold the union of
    // entitled modules rather than needing per-module worker flags.
    const modules = user.role === "admin" ? entitled : effective;

    return {
      tenantId: tenant.id,
      tenantCode: tenant.code,
      tenantName: tenant.name,
      momoEnabled: tenant.momoEnabled,
      susuEnabled: tenant.susuEnabled,
      userId: user.id,
      role: user.role,
      modules,
    };
  } catch {
    // Any unexpected failure is a denial, never a fallback.
    return null;
  }
}

/** Customer portal variant: the tenant comes from the Customer record. */
async function getCustomerTenantContext(
  session: JwtPayload
): Promise<TenantContext | null> {
  const customer = await db.customer.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      status: true,
      portalEnabled: true,
      tenantId: true,
    },
  });
  if (!customer || customer.status !== "active" || !customer.portalEnabled) {
    return null;
  }
  if (!customer.tenantId) return null;

  const tenant = await db.businessTenant.findUnique({
    where: { id: customer.tenantId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  if (!tenant || !OPERABLE_STATUSES.has(tenant.status)) return null;
  // The customer portal is a Susu feature.
  if (!tenant.susuEnabled) return null;

  return {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    tenantName: tenant.name,
    momoEnabled: tenant.momoEnabled,
    susuEnabled: tenant.susuEnabled,
    userId: customer.id,
    role: "customer",
    modules: ["susu"],
  };
}

// ---------------------------------------------------------------------------
// Guards — for pages and server actions
// ---------------------------------------------------------------------------

/**
 * Require a tenant context or redirect. Use in server components and actions
 * where a redirect is an acceptable denial.
 *
 * Sessions are cleared only when a session cookie for this module existed but
 * failed validation (stale, suspended tenant, revoked user). An absent cookie —
 * e.g. when an action probes the admin guard before the collector guard — must
 * NOT wipe other modules' sessions.
 */
export async function requireTenantContext(
  module: ModuleName,
  requiredModule?: "momo" | "susu"
): Promise<TenantContext> {
  const ctx = await getTenantContext(module, requiredModule);
  if (!ctx) {
    // Only clear sessions when a session cookie for this module existed but
    // failed validation. An absent cookie — e.g. when an action probes the
    // admin guard before the collector guard — must not wipe other modules'
    // sessions. A throwing cookie store (no request scope) counts as absent.
    let hadCookie = false;
    try {
      hadCookie = Boolean(await readModuleCookie(module));
    } catch {
      hadCookie = false;
    }
    if (hadCookie) {
      await clearAllSessions();
    }
    redirect("/login?reason=tenant_unavailable");
  }
  return ctx;
}

/** Require a tenant ADMINISTRATOR context (the business's own admin). */
export async function requireTenantAdmin(): Promise<TenantContext> {
  const ctx = await requireTenantContext("admin");
  if (ctx.role !== "admin") redirect("/unauthorized");
  return ctx;
}

/** Require a tenant admin WITH the MoMo module entitled. */
export async function requireTenantAdminMomo(): Promise<TenantContext> {
  const ctx = await requireTenantContext("admin", "momo");
  if (ctx.role !== "admin") redirect("/unauthorized");
  return ctx;
}

/** Require a tenant admin WITH the Susu module entitled. */
export async function requireTenantAdminSusu(): Promise<TenantContext> {
  const ctx = await requireTenantContext("admin", "susu");
  if (ctx.role !== "admin") redirect("/unauthorized");
  return ctx;
}

/** Require a MoMo worker context. */
export async function requireTenantWorker(): Promise<TenantContext> {
  const ctx = await requireTenantContext("momo", "momo");
  if (!ctx.modules.includes("momo")) redirect("/unauthorized");
  return ctx;
}

/** Require a Susu collector context. */
export async function requireTenantCollector(): Promise<TenantContext> {
  const ctx = await requireTenantContext("susu", "susu");
  if (!ctx.modules.includes("susu")) redirect("/unauthorized");
  return ctx;
}

/** Require a customer-portal context. */
export async function requireTenantCustomer(): Promise<TenantContext> {
  const ctx = await getTenantContext("customer", "susu");
  if (!ctx) {
    if (await readModuleCookie("customer")) {
      await clearAllSessions();
    }
    redirect("/login?role=customer&reason=tenant_unavailable");
  }
  return ctx;
}

/** Non-redirecting variant for API routes: returns null instead of redirecting. */
export async function getApiTenantContext(
  module: ModuleName,
  requiredModule?: "momo" | "susu"
): Promise<TenantContext | null> {
  return getTenantContext(module, requiredModule);
}

// ---------------------------------------------------------------------------
// Cross-tenant reference guards
// ---------------------------------------------------------------------------

/**
 * Verify that a referenced entity belongs to the authorized tenant.
 *
 * This is the mechanism that defeats cross-tenant ID substitution: a tenant A
 * administrator submitting tenant B's customer id gets `null` here, and the
 * caller must abort. Every mutation that accepts an entity id from the client
 * routes that id through one of these checks before using it.
 */
export async function assertTenantEntity<
  K extends keyof typeof TENANT_SCOPED_MODELS
>(
  model: K,
  id: string,
  ctx: TenantContext
): Promise<boolean> {
  if (!id) return false;
  try {
    const delegate = db[TENANT_SCOPED_MODELS[model] as keyof typeof db] as {
      findFirst: (args: unknown) => Promise<unknown>;
    };
    const found = await delegate.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: { id: true },
    });
    return Boolean(found);
  } catch {
    return false;
  }
}

/** Prisma delegate names for every tenant-scoped model. */
export const TENANT_SCOPED_MODELS = {
  user: "user",
  location: "location",
  dailyAccount: "dailyAccount",
  expense: "expense",
  customer: "customer",
  susuAccount: "susuAccount",
  susuCycle: "susuCycle",
  contribution: "contribution",
  contributionAllocation: "contributionAllocation",
  withdrawal: "withdrawal",
  commission: "commission",
  cardFee: "cardFee",
  collector: "collector",
  collectorCustomerAssignment: "collectorCustomerAssignment",
  collectorRemittance: "collectorRemittance",
  deviceEnrollment: "deviceEnrollment",
  offlineTransaction: "offlineTransaction",
  auditLog: "auditLog",
  passwordResetToken: "passwordResetToken",
} as const;

export type TenantScopedModel = keyof typeof TENANT_SCOPED_MODELS;

/**
 * Verify several references at once. Returns the name of the first reference
 * that fails, or null when all belong to the authorized tenant.
 */
export async function assertAllTenantEntities(
  refs: { model: TenantScopedModel; id: string | null | undefined }[],
  ctx: TenantContext
): Promise<string | null> {
  for (const ref of refs) {
    if (ref.id == null) continue;
    const ok = await assertTenantEntity(ref.model, ref.id, ctx);
    if (!ok) return ref.model;
  }
  return null;
}

/** Standard denial payload for server actions. */
export function tenantDenied<T extends { success: boolean; error?: string }>(
  response: T,
  message = "You do not have access to this record."
): T {
  return { ...response, success: false, error: message };
}
