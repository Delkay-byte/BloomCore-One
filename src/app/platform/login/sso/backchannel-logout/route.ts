import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/platform-audit";
import {
  auditSsoEvent,
  fetchDiscovery,
  getOidcConfig,
  oidcEnabled,
  validateLogoutToken,
} from "@/lib/security/oidc";

/**
 * OIDC Back-Channel Logout receiver (ADR-0004).
 *
 * Authentik POSTs `logout_token` here when its own session ends. The token is a
 * signed `logout+jwt` carrying iss/aud/iat/exp/jti, the back-channel-logout
 * `events` member and — for this deployment — the same `sid` value the ID token
 * carried, which lets us match the exact platform session.
 *
 * Only SSO-derived platform sessions are revoked; a local password session of
 * the same administrator is untouched. Idempotent: a repeated `jti` is
 * acknowledged without revoking twice.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!oidcEnabled()) {
    return new Response("Not Found", { status: 404 });
  }
  const config = getOidcConfig();
  if (!config.complete) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  let logoutToken = "";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      logout_token?: string;
    };
    logoutToken = body.logout_token ?? "";
  } else {
    const form = await request.formData().catch(() => null);
    logoutToken = String(form?.get("logout_token") ?? "");
  }
  if (!logoutToken) {
    return NextResponse.json({ error: "missing logout_token" }, { status: 400 });
  }

  let discovery;
  try {
    discovery = await fetchDiscovery(config.issuer);
  } catch {
    return NextResponse.json({ error: "discovery unavailable" }, { status: 503 });
  }

  const result = await validateLogoutToken(logoutToken, discovery.jwks_uri, {
    issuer: config.issuer,
    clientId: config.clientId,
  });
  if (!result.ok) {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      reason: `backchannel_logout_${result.reason}`,
    });
    return NextResponse.json({ error: "invalid logout token" }, { status: 400 });
  }

  const { sub, sid, jti } = result.claims;
  const already = await db.oidcRevocationEvent.findUnique({ where: { eventId: jti } });
  if (already) {
    return NextResponse.json({ status: "already_applied" });
  }
  try {
    await db.oidcRevocationEvent.create({ data: { eventId: jti, source: "idp" } });
  } catch {
    return NextResponse.json({ status: "already_applied" });
  }

  const where: Record<string, unknown> = { subjectType: "platform", revokedAt: null };
  if (sid) {
    where.idpSid = sid;
    if (sub) where.idpSub = sub;
  } else {
    where.idpSub = sub;
    where.authSource = "sso";
  }
  const rows = (await db.sessionRecord.findMany({ where, select: { id: true } })) as {
    id: string;
  }[];
  if (rows.length > 0) {
    await db.sessionRecord.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { revokedAt: new Date(), revokedReason: "idp_backchannel_logout" },
    });
  }

  await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_SESSION_REVOKED, {
    reason: "idp_backchannel_logout",
    details: { source: "idp", revoked: rows.length, matchedSid: Boolean(sid) },
  });

  // A valid token with no matching session is still a success (idempotent).
  return NextResponse.json({ status: "revoked", revoked: rows.length });
}
