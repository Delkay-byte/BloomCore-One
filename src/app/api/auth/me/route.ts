import { NextRequest, NextResponse } from "next/server";
import {
  getAdminSession,
  getMomoSession,
  getSusuSession,
  getCustomerSession,
  isSessionCurrent,
} from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant";

/**
 * Return the authenticated user for the given module.
 * Accepts ?module=admin|susu|customer so dashboards don't accidentally read
 * another role's session when multiple cookies are present.
 *
 * The response now includes the resolved tenant context so the UI can render
 * module navigation from the TENANT's entitlement rather than from a user
 * flag. The tenantId returned here is informational only — server actions
 * always re-resolve it from the session and never accept it from the client.
 */
export async function GET(request: NextRequest) {
  const requestedModule = request.nextUrl.searchParams.get("module");

  let user = null;
  if (requestedModule === "admin") {
    user = await getAdminSession();
  } else if (requestedModule === "momo") {
    user = await getMomoSession();
  } else if (requestedModule === "susu") {
    user = await getSusuSession();
  } else if (requestedModule === "customer") {
    user = await getCustomerSession();
  } else {
    // Fallback: try all, but prefer the most-specific match
    user =
      (await getMomoSession()) ??
      (await getSusuSession()) ??
      (await getAdminSession()) ??
      (await getCustomerSession());
  }

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Re-validate against the database (status, tokenVersion, revocation).
  if (!(await isSessionCurrent(user))) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Resolve the tenant for the module the caller actually asked about.
  const resolvedModule =
    requestedModule === "admin" ||
    requestedModule === "momo" ||
    requestedModule === "susu" ||
    requestedModule === "customer"
      ? requestedModule
      : user.role === "admin"
        ? "admin"
        : user.role === "worker"
          ? "momo"
          : user.role === "collector"
            ? "susu"
            : "customer";

  const tenant = await getTenantContext(resolvedModule);

  return NextResponse.json({
    ...user,
    tenant: tenant
      ? {
          id: tenant.tenantId,
          code: tenant.tenantCode,
          name: tenant.tenantName,
          momoEnabled: tenant.momoEnabled,
          susuEnabled: tenant.susuEnabled,
          modules: tenant.modules,
        }
      : null,
  });
}
