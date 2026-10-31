import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { isPublicMarketingRoute } from "@/lib/public-routes";

// Require JWT_SECRET — fail hard if missing
const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW) {
  throw new Error(
    "FATAL: JWT_SECRET environment variable is required. " +
    "Set it in your .env file. See .env.example for details."
  );
}
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW);

/**
 * Module-scoped session architecture (see src/lib/auth.ts):
 *
 *   bik-admin-session     → administration module
 *   bik-worker-session    → MoMo module
 *   bik-collector-session → Susu module
 *   bik-workspace-select  → short-lived dual-role workspace choice
 *
 * Each login writes ONLY its own module cookie, so an admin signed in on one
 * tab is never overwritten by a worker/collector signing in on another tab.
 */

const SESSION_COOKIES = {
  admin: "bik-admin-session",
  momo: "bik-worker-session",
  susu: "bik-collector-session",
  customer: "bik-customer-session",
} as const;

const SELECTION_COOKIE = "bik-workspace-select";
const LEGACY_COOKIE = "bik-prestige-token";

/**
 * Platform Super Admin session (BloomCore operator).
 *
 * This cookie is deliberately NOT part of SESSION_COOKIES. The platform
 * boundary is one-way isolated:
 *   * /platform/* accepts ONLY bik-platform-session (checked below, before any
 *     tenant logic runs), so a tenant administrator can never reach the
 *     platform dashboard with their tenant cookie.
 *   * Tenant routes only ever read SESSION_COOKIES, so a platform session can
 *     never act as a tenant user.
 */
const PLATFORM_COOKIE = "bik-platform-session";
const PLATFORM_PUBLIC_ROUTES = ["/platform/login"];

const PUBLIC_ROUTES = ["/access", "/login", "/forgot-password", "/reset-password", "/api/health", "/api/diag"];
const CUSTOMER_PUBLIC_ROUTES = ["/customer/login", "/customer/forgot-password"];
// The dedicated administrator login must be reachable without any session.
const ADMIN_PUBLIC_ROUTES = ["/admin/login"];

interface TokenClaims {
  role?: string;
  modules?: string[];
  forcePasswordReset?: boolean;
  kind?: string;
  adminId?: string;
}

function claimsMatchModule(claims: TokenClaims, module: keyof typeof SESSION_COOKIES): boolean {
  const explicitModules = Array.isArray(claims.modules) ? claims.modules : undefined;
  if (module === "admin") return claims.role === "admin";
  if (explicitModules) return explicitModules.includes(module);
  // Legacy tokens carry only the primary role
  return module === "momo" ? claims.role === "worker" : claims.role === "collector";
}

/**
 * Platform token check. Requires the explicit `kind: "platform"` claim, so a
 * tenant JWT can never be replayed as a platform session even if it were
 * somehow written into the platform cookie.
 */
function isPlatformClaims(claims: TokenClaims | null): boolean {
  return Boolean(claims && claims.kind === "platform" && claims.adminId);
}

async function readClaims(token: string | undefined): Promise<TokenClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as TokenClaims;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, request.url));

  const res = () => {
    const r = NextResponse.next();
    // Protected pages must never be served from browser cache/back navigation.
    r.headers.set("Cache-Control", "no-store, must-revalidate");
    return r;
  };

  // ---------------------------------------------------------------------
  // PLATFORM BOUNDARY — evaluated before every tenant rule.
  //
  // /platform/* is reachable ONLY with a valid platform session. Tenant
  // cookies are not consulted here at all, so a tenant administrator (or a
  // worker/collector/customer) cannot open the platform dashboard by any
  // cookie they legitimately hold.
  // ---------------------------------------------------------------------
  if (pathname.startsWith("/platform")) {
    // The platform login itself is public.
    if (PLATFORM_PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
      // An already-authenticated operator is sent straight to the dashboard.
      const existing = await readClaims(
        request.cookies.get(PLATFORM_COOKIE)?.value
      );
      if (isPlatformClaims(existing) && pathname === "/platform/login") {
        return redirectTo("/platform/dashboard");
      }
      return NextResponse.next();
    }

    const platformClaims = await readClaims(
      request.cookies.get(PLATFORM_COOKIE)?.value
    );
    if (!isPlatformClaims(platformClaims)) {
      return redirectTo("/platform/login");
    }

    const r = NextResponse.next();
    r.headers.set("Cache-Control", "no-store, must-revalidate");
    return r;
  }

  // ---------------------------------------------------------------------
  // PUBLIC MARKETING SITE — BloomCore One.
  //
  // Evaluated AFTER the platform boundary, so no /platform route can ever be
  // made public by a marketing route match, and BEFORE every tenant rule.
  // Only the routes listed in src/lib/public-routes.ts are exempt: the rest of
  // the application keeps exactly the guards it had.
  // ---------------------------------------------------------------------
  if (isPublicMarketingRoute(pathname)) {
    return NextResponse.next();
  }

  // Allow public routes (login, health check)
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Allow customer public routes (separate from staff).
  // These are public login/recovery pages — never bounce visitors to the staff
  // login. Authenticated /customer/* data routes remain protected below.
  if (CUSTOMER_PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Allow the dedicated administrator login without a session.
  if (ADMIN_PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith("/_next") || pathname.includes(".")) {
    return NextResponse.next();
  }

  // API routes perform their own authorization — never leak HTML redirects.
  if (pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  // Customer portal: completely separate session, never mixed with staff
  if (pathname.startsWith("/customer")) {
    const customerClaims = await readClaims(request.cookies.get(SESSION_COOKIES.customer)?.value);
    if (!customerClaims) {
      return redirectTo("/login?role=customer");
    }
    if (customerClaims.role !== "customer") {
      return redirectTo("/login?role=customer");
    }
    // First-login mandatory password change for customer
    if (customerClaims.forcePasswordReset) {
      const settingsAllowed = pathname.startsWith("/customer/settings");
      if (!settingsAllowed) {
        return redirectTo("/customer/settings?tab=password");
      }
    }
    return res();
  }

  // Staff routes below — customers must not access staff areas
  // (Already handled: /customer/* is caught above)

  // Which module does this path belong to?
  let pathModule: keyof typeof SESSION_COOKIES | null = null;
  if (pathname.startsWith("/admin") || pathname.startsWith("/susu")) pathModule = "admin";
  else if (pathname.startsWith("/worker")) pathModule = "momo";
  else if (pathname.startsWith("/collector")) pathModule = "susu";

  // "/" is the public BloomCore One landing page and was returned above by
  // isPublicMarketingRoute(). Signed-in people reach their workspace from the
  // landing page's Sign In link, which keeps the public page genuinely public
  // for every visitor (including signed-in ones).

  // Dual-role workspace selection page requires a valid selection token.
  if (pathname.startsWith("/select-workspace")) {
    const claims = await readClaims(request.cookies.get(SELECTION_COOKIE)?.value);
    if (!claims) return redirectTo("/login");
    return res();
  }

  // Shared legacy pages keep working with any active module session.
  if (pathname.startsWith("/settings") || pathname.startsWith("/change-password")) {
    const anySession = await Promise.all(
      Object.values(SESSION_COOKIES).map((name) => readClaims(request.cookies.get(name)?.value))
    );
    const legacy = await readClaims(request.cookies.get(LEGACY_COOKIE)?.value);
    if (!anySession.some(Boolean) && !legacy) return redirectTo("/login");
    return res();
  }

  if (!pathModule) {
    // Unknown protected route — require at least some session.
    const anySession = await Promise.all(
      Object.values(SESSION_COOKIES).map((name) => readClaims(request.cookies.get(name)?.value))
    );
    if (!anySession.some(Boolean)) return redirectTo("/login");
    return res();
  }

  // Resolve this module's session: scoped cookie first, then legacy fallback.
  let claims = await readClaims(request.cookies.get(SESSION_COOKIES[pathModule])?.value);
  if (!claims) {
    const legacy = await readClaims(request.cookies.get(LEGACY_COOKIE)?.value);
    if (legacy && claimsMatchModule(legacy, pathModule)) claims = legacy;
  }

  if (!claims || !claimsMatchModule(claims, pathModule)) {
    return redirectTo("/login");
  }

  // First-login mandatory password change: only module settings/logout allowed.
  if (claims.forcePasswordReset) {
    const settingsRoot =
      pathModule === "admin" ? "/admin/settings" : pathModule === "momo" ? "/worker/settings" : "/collector/settings";
    const allowed =
      pathname.startsWith(settingsRoot) ||
      pathname.startsWith("/select-workspace");
    if (!allowed) {
      return redirectTo(`${settingsRoot}?tab=password`);
    }
  }

  return res();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
