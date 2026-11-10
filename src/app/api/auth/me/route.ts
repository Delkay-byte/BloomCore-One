import { NextRequest, NextResponse } from "next/server";
import {
  getAdminSession,
  getMomoSession,
  getSusuSession,
  getCustomerSession,
  getAnyModuleSession,
  isSessionCurrent,
  type JwtPayload,
  type ModuleName,
} from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant";
import {
  evaluateZeliAccess,
  getZeliEntitlement,
} from "@/lib/zeli/entitlements";
import { getZeliAvailability } from "@/lib/zeli/availability";

/**
 * Return the authenticated user for the given module.
 * Accepts ?module=admin|momo|susu|customer so dashboards don't accidentally
 * read another role's session when multiple cookies are present.
 *
 * When no module is supplied, the response resolves the module that actually
 * authenticated this tab and derives the tenant from THAT module. The user's
 * primary role is not a workspace identifier: a dual-role account can hold a
 * Susu session while its primary role is `worker` (or the reverse).
 *
 * The response now includes the resolved tenant context so the UI can render
 * module navigation from the TENANT's entitlement rather than from a user
 * flag, and the resolved `module` so callers can keep their offline scope in
 * the same authorization context. The tenantId returned here is informational
 * only — server actions always re-resolve it from the session and never accept
 * it from the client.
 */
// This response depends on the calling tab's proof-of-possession header and on
// live session state. It must never be stored by a browser, proxy or CDN: a
// cached 200 could be replayed to an unauthenticated tab, and a cached 401 could
// strand an authenticated one.
export const dynamic = "force-dynamic";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Vary: "x-bloomcore-tab-proof, x-bloomcore-tab-request-id",
} as const;

const VALID_MODULES: readonly ModuleName[] = [
  "admin",
  "momo",
  "susu",
  "customer",
];

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function isModuleName(value: string): value is ModuleName {
  return (VALID_MODULES as readonly string[]).includes(value);
}

async function readSession(module: ModuleName): Promise<JwtPayload | null> {
  if (module === "admin") return getAdminSession();
  if (module === "momo") return getMomoSession();
  if (module === "susu") return getSusuSession();
  return getCustomerSession();
}

export async function GET(request: NextRequest) {
  const rawModule = request.nextUrl.searchParams.get("module");
  if (rawModule && !isModuleName(rawModule)) {
    // An unrecognized explicit module must not silently become a neutral
    // lookup for a different workspace.
    return json({ error: "Unknown module" }, 400);
  }
  const requestedModule = rawModule && isModuleName(rawModule) ? rawModule : null;

  let user: JwtPayload | null = null;
  let sessionModule: ModuleName | null = requestedModule;

  if (requestedModule) {
    user = await readSession(requestedModule);
  } else {
    // Identify BOTH the session and the module that supplied it. The module is
    // the tenant-resolution scope below.
    const found = await getAnyModuleSession();
    user = found?.user ?? null;
    sessionModule = found?.module ?? null;
  }

  if (!user || !sessionModule) {
    return json({ error: "Not authenticated" }, 401);
  }

  // Re-validate against the database (status, tokenVersion, revocation).
  if (!(await isSessionCurrent(user))) {
    return json({ error: "Not authenticated" }, 401);
  }

  // `requiredModule` makes the tenant's entitlement authoritative for staff
  // workspaces. A token can outlive a module being disabled on the tenant; it
  // must not keep returning a tenant context for offline scoping in that case.
  const requiredModule =
    sessionModule === "momo" || sessionModule === "susu"
      ? sessionModule
      : undefined;
  const tenant = await getTenantContext(sessionModule, requiredModule);
  // Navigation is rendered from server-resolved entitlements, never from a
  // browser flag. The value is informational; every page and action re-checks.
  const entitlement = tenant ? await getZeliEntitlement(tenant.tenantId) : null;
  const analyticsAccess = tenant
    ? evaluateZeliAccess({ role: tenant.role, entitlement })
    : null;
  const zeliEnabled = (await getZeliAvailability()).enabled;

  return json({
    ...user,
    // The workspace this answer belongs to. A client that asked for a module
    // always gets that module back; a neutral caller gets the tab's actual
    // session module so its offline scope matches the server identity.
    module: sessionModule,
    tenant: tenant
      ? {
          id: tenant.tenantId,
          code: tenant.tenantCode,
          name: tenant.tenantName,
          momoEnabled: tenant.momoEnabled,
          susuEnabled: tenant.susuEnabled,
          modules: tenant.modules,
          zeliAnalytics: Boolean(analyticsAccess?.allowed),
          zeliEnabled,
        }
      : null,
  });
}
