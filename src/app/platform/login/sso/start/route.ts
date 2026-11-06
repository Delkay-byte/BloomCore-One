import { NextResponse } from "next/server";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/platform-audit";
import {
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_TTL_SECONDS,
  auditSsoEvent,
  authorizeUrl,
  fetchDiscovery,
  getOidcConfig,
  newOidcFlow,
  oidcEnabled,
  ssoRedirectUri,
  signOidcBlob,
} from "@/lib/security/oidc";

/**
 * GET /platform/login/sso/start
 *
 * Begins the platform SSO flow: creates a single-use PKCE flow, stores it in a
 * short-lived HttpOnly cookie scoped to /platform/login/sso, and redirects to
 * the Identity Provider's authorization endpoint.
 *
 * Node runtime only (PKCE material and HMAC signing must never run in Edge).
 * Returns 404 unless PLATFORM_OIDC_ENABLED is on and the configuration is
 * complete — the route does not exist when the feature is off.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const config = getOidcConfig();
  if (!oidcEnabled()) {
    return new Response("Not Found", { status: 404 });
  }

  const loginUrl = new URL("/platform/login", request.url);
  const failed = () => {
    loginUrl.searchParams.set("error", "sso_failed");
    return NextResponse.redirect(loginUrl, { status: 303 });
  };

  let discovery;
  try {
    discovery = await fetchDiscovery(config.issuer);
  } catch {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      reason: "discovery_failed",
    });
    return failed();
  }

  const flow = newOidcFlow();
  const authorize = authorizeUrl(
    discovery,
    config,
    flow,
    ssoRedirectUri(new URL(request.url).origin)
  );

  const response = NextResponse.redirect(authorize, { status: 303 });
  response.cookies.set(OIDC_FLOW_COOKIE, signOidcBlob(flow), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/platform/login/sso",
    maxAge: OIDC_FLOW_TTL_SECONDS,
  });

  await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_START, {
    details: { issuer: config.issuer },
  });

  return response;
}
