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

  // Record the jti and revoke in ONE transaction: recording it first meant a
  // failed revocation was retried into "already applied" and silently lost.
  let outcome: { duplicate: boolean; revoked: number };
  try {
    outcome = await db.$transaction(async (tx) => {
      await tx.oidcRevocationEvent.create({ data: { eventId: jti, source: "idp" } });
      const where: Record<string, unknown> = {
        subjectType: "platform",
        revokedAt: null,
      };
      if (sid) {
        where.idpSid = sid;
        if (sub) where.idpSub = sub;
      } else {
        where.idpSub = sub;
        where.authSource = "sso";
      }
      const rows = (await tx.sessionRecord.findMany({
        where,
        select: { id: true },
      })) as { id: string }[];
      if (rows.length > 0) {
        await tx.sessionRecord.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { revokedAt: new Date(), revokedReason: "idp_backchannel_logout" },
        });
      }
      await tx.platformAuditLog.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_SESSION_REVOKED,
          reason: "idp_backchannel_logout",
          details: JSON.stringify({
            source: "idp",
            revoked: rows.length,
            matchedSid: Boolean(sid),
          }),
        },
      });
      return { duplicate: false, revoked: rows.length };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json({ status: "already_applied" });
    }
    console.error("[backchannel-logout] apply failed", error);
    return NextResponse.json({ error: "revocation failed" }, { status: 500 });
  }

  if (outcome.duplicate) {
    return NextResponse.json({ status: "already_applied" });
  }
  // A valid token with no matching session is still a success (idempotent).
  return NextResponse.json({ status: "revoked", revoked: outcome.revoked });
}
