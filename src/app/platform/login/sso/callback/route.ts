import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/platform-audit";
import {
  OIDC_FLOW_COOKIE,
  auditSsoEvent,
  exchangeCode,
  fetchDiscovery,
  flowExpired,
  getOidcConfig,
  idpAmr,
  newOidcAttempt,
  oidcEnabled,
  resolveLinking,
  ssoRedirectUri,
  signOidcBlob,
  validateIdToken,
  verifyOidcBlob,
  type OidcFlow,
} from "@/lib/security/oidc";
import { completeSsoSignIn } from "@/lib/security/oidc-login";
import {
  PLATFORM_COOKIE,
  PLATFORM_SESSION_POLICY,
} from "@/lib/platform-auth";

/**
 * GET /platform/login/sso/callback
 *
 * Completes the platform SSO flow (Node runtime only):
 *   1. Validates and consumes the single-use flow cookie (state/nonce/verifier).
 *   2. Exchanges the authorization code with PKCE at the token endpoint.
 *   3. Validates the ID token against the IdP JWKS (exact issuer, aud ==
 *      client_id, exp/iat leeway 30s, single-use nonce).
 *   4. Asks the Control Center whether this email may use SSO:
 *        none    → denied, audited, no session
 *        pending → redirect to /platform/login/sso/confirm (local password proof)
 *        verified→ mint the NATIVE platform session and continue
 *
 * Returns 404 unless the feature flag is on.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const config = getOidcConfig();
  const url = new URL(request.url);
  const loginUrl = new URL("/platform/login", url);

  if (!oidcEnabled()) {
    return new Response("Not Found", { status: 404 });
  }

  const redirectToLogin = (
    param: "error" | "notice",
    value: string
  ): NextResponse => {
    loginUrl.searchParams.set(param, value);
    const response = NextResponse.redirect(loginUrl, { status: 303 });
    response.cookies.delete({ name: OIDC_FLOW_COOKIE, path: "/platform/login/sso" });
    return response;
  };

  const deny = async (
    reason: string,
    errorParam: string,
    details?: Record<string, unknown>
  ): Promise<NextResponse> => {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      reason,
      details: details ?? null,
    });
    return redirectToLogin("error", errorParam);
  };

  // ------------------------------------------------------------------ flow
  const flowCookie = (await cookies()).get(OIDC_FLOW_COOKIE)?.value;
  const flow = verifyOidcBlob<OidcFlow>(flowCookie);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const idpError = url.searchParams.get("error");

  if (idpError) {
    return deny("idp_error", "sso_denied", { idpError });
  }
  if (!code || !state || !flow || flow.state !== state || flowExpired(flow)) {
    return deny("invalid_flow", "sso_failed");
  }
  // From here the flow is consumed: every outgoing response deletes the flow
  // cookie, so a replayed callback can never reuse the nonce or the verifier.

  let discovery;
  try {
    discovery = await fetchDiscovery(config.issuer);
  } catch {
    return deny("discovery_failed", "sso_failed");
  }

  // -------------------------------------------------------- token exchange
  const tokens = await exchangeCode(discovery, config, {
    code,
    redirectUri: ssoRedirectUri(url.origin),
    verifier: flow.verifier,
  });
  if (!tokens?.id_token) {
    return deny("token_exchange_failed", "sso_failed");
  }

  const idResult = await validateIdToken(tokens.id_token, discovery.jwks_uri, {
    issuer: config.issuer,
    clientId: config.clientId,
    nonce: flow.nonce,
  });
  if (!idResult.ok) {
    return deny(`id_token_${idResult.reason}`, "sso_failed");
  }
  const claims = idResult.claims;
  const email = String(claims.email).trim().toLowerCase();
  const amr = idpAmr(claims);

  // ---------------------------------------------------------- authorisation
  const resolve = await resolveLinking(config, email);
  if (!resolve) {
    return deny("cc_resolve_failed", "sso_failed", { email });
  }
  if (resolve.status === "none") {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      actorEmail: email,
      reason: "not_authorised",
    });
    return redirectToLogin("error", "sso_not_authorised");
  }

  if (resolve.status === "pending") {
    if (!resolve.identity_sub) {
      return deny("cc_resolve_missing_sub", "sso_failed", { email });
    }
    const attempt = newOidcAttempt({
      sub: resolve.identity_sub,
      idpEmail: email,
      ccEmail: resolve.email,
      issuer: config.issuer,
    });
    const confirmUrl = new URL("/platform/login/sso/confirm", url);
    confirmUrl.searchParams.set("attempt", signOidcBlob(attempt));
    const response = NextResponse.redirect(confirmUrl, { status: 303 });
    response.cookies.delete({ name: OIDC_FLOW_COOKIE, path: "/platform/login/sso" });
    return response;
  }

  // status === "verified": the Control Center has a confirmed association.
  // Mirror it locally if the product-side link is missing (e.g. a restore) —
  // CC `verified` already implies the local-credential proof happened.
  let link = resolve.identity_sub
    ? await db.platformOidcLink.findUnique({ where: { idpSub: resolve.identity_sub } })
    : null;
  if (!link && resolve.identity_sub) {
    const admin = await db.platformSuperAdmin.findUnique({ where: { email } });
    if (!admin || admin.status !== "active") {
      await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
        actorEmail: email,
        reason: admin ? "admin_inactive" : "no_matching_local_admin",
      });
      return redirectToLogin("error", "sso_not_authorised");
    }
    link = await db.platformOidcLink.create({
      data: {
        platformAdminId: admin.id,
        issuer: config.issuer,
        idpSub: resolve.identity_sub,
        linkedVia: "cc_verified",
        createdBy: admin.id,
      },
    });
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_CREATED, {
      actorId: admin.id,
      actorEmail: admin.email,
      entityId: link.id,
      details: { linkedVia: "cc_verified" },
    });
  }

  if (!link || !resolve.identity_sub) {
    return deny("no_local_link", "sso_not_authorised", { email });
  }

  // ------------------------------------------------------- session minting
  const result = await completeSsoSignIn({
    issuer: config.issuer,
    idpSub: resolve.identity_sub,
    idpAmr: amr,
    refreshToken: tokens.refresh_token,
  });

  if (!result.ok) {
    const errorParam =
      result.reason === "mfa_required"
        ? "sso_mfa_required"
        : result.reason === "inactive"
          ? "sso_not_authorised"
          : "sso_failed";
    return redirectToLogin("error", errorParam);
  }

  const destination = result.forcePasswordReset
    ? new URL("/platform/first-login", url)
    : new URL("/platform/dashboard", url);
  const response = NextResponse.redirect(destination, { status: 303 });
  response.cookies.delete({ name: OIDC_FLOW_COOKIE, path: "/platform/login/sso" });
  // setPlatformSession() (inside completeSsoSignIn) wrote the cookie to the
  // request-scoped store; carry it onto this redirect response explicitly so
  // the session survives the 303 in every runtime. Flags mirror
  // setPlatformSession() exactly; maxAge mirrors the platform session policy.
  const minted = (await cookies()).get(PLATFORM_COOKIE)?.value;
  if (minted) {
    response.cookies.set(PLATFORM_COOKIE, minted, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: PLATFORM_SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS + 60,
      priority: "high",
    });
  }
  return response;
}
