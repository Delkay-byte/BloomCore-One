import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { isPublicMarketingRoute } from "@/lib/public-routes";
import {
  TAB_SESSION_HEADER,
  allowLegacyCookieSessions,
} from "@/lib/security/tab-session";

// Require JWT_SECRET — fail hard if missing
const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW) {
  throw new Error(
    "FATAL: JWT_SECRET environment variable is required. " +
    "Set it in your .env file. See .env.example for details."
  );
}
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW);
const MFA_ENFORCED = process.env.MFA_ENFORCEMENT === "enforce";

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

// Public routes (login, health check). "/workspace" is handled explicitly
// above as a redirect-only entry point.
const PUBLIC_ROUTES = ["/access", "/login", "/forgot-password", "/reset-password", "/mfa", "/recover-account", "/api/health", "/api/diag"];
const CUSTOMER_PUBLIC_ROUTES = ["/customer/login", "/customer/forgot-password"];
// The dedicated administrator login must be reachable without any session.
const ADMIN_PUBLIC_ROUTES = ["/admin/login"];

interface TokenClaims {
  role?: string;
  modules?: string[];
  forcePasswordReset?: boolean;
  kind?: string;
  adminId?: string;
  amr?: "pwd" | "pwd+mfa";
  tokenUse?: string;
  aud?: string | string[];
}

/** Sessions created before MFA verification are refused while enforcing. */
function missingMfa(claims: TokenClaims | null): boolean {
  return MFA_ENFORCED && claims?.amr !== "pwd+mfa";
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
function isPlatformClaims(claims: TokenClaims | null): claims is TokenClaims {
  return Boolean(claims && claims.kind === "platform" && claims.adminId);
}

async function readClaims(
  token: string | undefined | null,
  options: { allowSelection?: boolean } = {}
): Promise<TokenClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const claims = payload as unknown as TokenClaims;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    // An MFA challenge is never a login. It must not pass a route guard even
    // if it is somehow placed in the tab transport header.
    if (
      claims.tokenUse === "mfa-challenge" ||
      audience.includes("bloomcore-one:mfa-challenge")
    ) {
      return null;
    }
    // Workspace selection is public only on /select-workspace.
    if (!options.allowSelection) {
      if (
        claims.kind === "workspace-selection" ||
        claims.tokenUse === "workspace-selection"
      ) {
        return null;
      }
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * Resolve the tab-scoped session token.
 *
 * The service worker injects the header for this tab only. A shared cookie is
 * used solely by the explicit test compatibility bridge; browser cookies are
 * never accepted as a tab identity in production.
 */
function sessionToken(
  request: NextRequest,
  cookieName: string
): string | null {
  const header = request.headers.get(TAB_SESSION_HEADER);
  if (header) return header;
  if (!allowLegacyCookieSessions()) return null;
  return request.cookies.get(cookieName)?.value ?? null;
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
      // Deliberately NO auto-forward here. The edge runtime can only validate
      // the JWT's signature and timestamps, not the server-side session
      // registry; a revoked-but-unexpired cookie would then bounce
      // dashboard -> login -> dashboard forever. The login page performs the
      // same forwarding using getPlatformSession(), which consults the
      // registry, so an operator with a live session still lands on the
      // dashboard and a revoked one simply sees the sign-in form.
      return NextResponse.next();
    }

    const platformClaims = await readClaims(
      sessionToken(request, PLATFORM_COOKIE)
    );
    if (!isPlatformClaims(platformClaims)) {
      return redirectTo("/platform/login");
    }
    if (missingMfa(platformClaims)) {
      return redirectTo("/platform/login?reason=mfa_required");
    }

    // A first-login operator may only reach the standalone password screen.
    // The console layout no longer redirects to a page it also wraps, so this
    // path cannot loop.
    if (platformClaims.forcePasswordReset) {
      if (pathname !== "/platform/first-login") {
        return redirectTo("/platform/first-login");
      }
    } else if (pathname === "/platform/first-login") {
      return redirectTo("/platform/dashboard");
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

  // ---------------------------------------------------------------------
  // WORKSPACE ENTRY POINT — "/workspace".
  //
  // The public landing page's Sign In link points here. A person with a valid
  // session goes straight to the workspace that session covers; everyone else
  // goes to the sign-in page. It is a redirect, never a page, so it exposes
  // nothing: every destination re-checks the session below.
  // ---------------------------------------------------------------------
  if (pathname === "/workspace") {
    const platformClaims = await readClaims(
      sessionToken(request, PLATFORM_COOKIE)
    );
    if (isPlatformClaims(platformClaims)) {
      return redirectTo(
        platformClaims.forcePasswordReset
          ? "/platform/first-login"
          : "/platform/dashboard"
      );
    }
    for (const [mod, cookieName] of Object.entries(SESSION_COOKIES)) {
      const claims = await readClaims(sessionToken(request, cookieName));
      if (!claims) continue;
      if (!claimsMatchModule(claims, mod as keyof typeof SESSION_COOKIES)) continue;
      if (claims.forcePasswordReset) {
        return redirectTo(
          mod === "admin"
            ? "/admin/first-login"
            : mod === "momo"
              ? "/worker/first-login"
              : mod === "susu"
                ? "/collector/first-login"
                : "/customer/first-login"
        );
      }
      return redirectTo(
        mod === "admin"
          ? "/admin/dashboard"
          : mod === "momo"
            ? "/worker/dashboard"
            : mod === "susu"
              ? "/collector/dashboard"
              : "/customer/dashboard"
      );
    }
    return redirectTo("/login");
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
    const customerClaims = await readClaims(
      sessionToken(request, SESSION_COOKIES.customer)
    );
    if (!customerClaims) {
      return redirectTo("/login?role=customer");
    }
    if (customerClaims.role !== "customer") {
      return redirectTo("/login?role=customer");
    }
    if (missingMfa(customerClaims)) {
      return redirectTo("/login?role=customer&reason=mfa_required");
    }
    // First-login mandatory password change for customer. The standalone
    // screen is outside the portal shell; every other customer page waits.
    if (customerClaims.forcePasswordReset) {
      if (!pathname.startsWith("/customer/first-login")) {
        return redirectTo("/customer/first-login");
      }
    } else if (pathname.startsWith("/customer/first-login")) {
      return redirectTo("/customer/dashboard");
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
    const claims = await readClaims(sessionToken(request, SELECTION_COOKIE), {
      allowSelection: true,
    });
    if (!claims) return redirectTo("/login");
    return res();
  }

  // Shared legacy pages keep working with any active module session.
  if (pathname.startsWith("/settings") || pathname.startsWith("/change-password")) {
    const anySession = await Promise.all(
      Object.values(SESSION_COOKIES).map((name) =>
        readClaims(sessionToken(request, name))
      )
    );
    const legacy = allowLegacyCookieSessions()
      ? await readClaims(request.cookies.get(LEGACY_COOKIE)?.value)
      : null;
    if (!anySession.some(Boolean) && !legacy) return redirectTo("/login");
    return res();
  }

  if (!pathModule) {
    // Unknown protected route — require at least some session.
    const anySession = await Promise.all(
      Object.values(SESSION_COOKIES).map((name) =>
        readClaims(sessionToken(request, name))
      )
    );
    if (!anySession.some(Boolean)) return redirectTo("/login");
    return res();
  }

  // Resolve this module's session: scoped cookie first, then legacy fallback.
  let claims = await readClaims(
    sessionToken(request, SESSION_COOKIES[pathModule])
  );
  if (!claims && allowLegacyCookieSessions()) {
    const legacy = await readClaims(request.cookies.get(LEGACY_COOKIE)?.value);
    if (legacy && claimsMatchModule(legacy, pathModule)) claims = legacy;
  }

  if (!claims || !claimsMatchModule(claims, pathModule)) {
    return redirectTo("/login");
  }
  if (missingMfa(claims)) {
    return redirectTo("/login?reason=mfa_required");
  }

  // First-login mandatory password change: only the standalone screen (and
  // workspace selection) is reachable until the temporary password is replaced.
  const firstLoginRoot =
    pathModule === "admin"
      ? "/admin/first-login"
      : pathModule === "momo"
        ? "/worker/first-login"
        : "/collector/first-login";
  const dashboardRoot =
    pathModule === "admin"
      ? "/admin/dashboard"
      : pathModule === "momo"
        ? "/worker/dashboard"
        : "/collector/dashboard";

  if (claims.forcePasswordReset) {
    const allowed =
      pathname.startsWith(firstLoginRoot) ||
      pathname.startsWith("/select-workspace");
    if (!allowed) {
      return redirectTo(firstLoginRoot);
    }
  } else if (pathname === firstLoginRoot) {
    return redirectTo(dashboardRoot);
  }

  return res();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
