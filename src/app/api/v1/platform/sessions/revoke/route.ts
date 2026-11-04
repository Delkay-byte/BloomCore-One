import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { auditSsoEvent, getOidcConfig, oidcEnabled } from "@/lib/security/oidc";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/platform-audit";

/**
 * Central session revocation + OIDC back-channel logout (ADR-0004).
 *
 * Two distinct mechanisms, both scoped to *SSO-derived platform sessions* of
 * one immutable Authentik subject. A platform admin's local password session is
 * never touched by either path.
 *
 *   POST /api/v1/platform/sessions/revoke   (Control Center, HMAC-signed)
 *   POST /platform/login/sso/backchannel-logout (Authentik, logout_token)
 *
 * Neither requires the Control Center at runtime.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REVOCATION_ISSUER = "bloomcore-control-center";
const MAX_MESSAGE_AGE_SECONDS = 300;

interface RevokedRow {
  id: string;
}

async function revokeSsoSessions(
  idpSub: string | null,
  idpSid: string | null,
  scope: string
): Promise<number> {
  if (!idpSub && !idpSid) return 0;
  const where: Record<string, unknown> = {
    subjectType: "platform",
    revokedAt: null,
  };
  // "identity_sessions" (a Control Center logout) ends every SSO session of
  // this immutable subject, in every browser. "session" is the narrow,
  // sid-targeted variant.
  if (scope === "session" && idpSid) {
    where.idpSid = idpSid;
    if (idpSub) where.idpSub = idpSub;
  } else {
    where.idpSub = idpSub;
    where.authSource = "sso";
  }

  const rows = (await db.sessionRecord.findMany({
    where,
    select: { id: true },
  })) as RevokedRow[];

  if (rows.length > 0) {
    await db.sessionRecord.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { revokedAt: new Date(), revokedReason: "central_revocation" },
    });
  }
  return rows.length;
}

async function seenOrRecord(
  eventId: string,
  source: string
): Promise<boolean> {
  const existing = await db.oidcRevocationEvent.findUnique({
    where: { eventId },
  });
  if (existing) return true;
  try {
    await db.oidcRevocationEvent.create({ data: { eventId, source } });
  } catch {
    // Unique violation from a concurrent delivery: treat as already applied.
    return true;
  }
  return false;
}

/** Control Center-initiated revocation. */
export async function POST(request: Request): Promise<Response> {
  // The flag gates the whole SSO surface: with it off this deployment has no
  // SSO sessions to revoke, so the endpoint does not exist at all.
  if (!oidcEnabled()) {
    return new Response("Not Found", { status: 404 });
  }
  const config = getOidcConfig();
  if (!config.complete) {
    return NextResponse.json({ error: "revocation not configured" }, { status: 503 });
  }
  const raw = await request.text();
  const signature = request.headers.get("x-bloomcore-signature") ?? "";
  const eventHeader = request.headers.get("x-bloomcore-event") ?? "";
  if (!raw || !signature || !eventHeader) {
    return NextResponse.json({ error: "missing revocation message" }, { status: 400 });
  }

  const expected = createHmac("sha256", config.ccApiKey).update(raw).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      reason: "revocation_bad_signature",
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "malformed message" }, { status: 400 });
  }

  if (body.iss !== REVOCATION_ISSUER || body.aud !== "bloomcore-one") {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      reason: "revocation_wrong_sender",
      details: { iss: String(body.iss), aud: String(body.aud) },
    });
    return NextResponse.json({ error: "invalid sender or audience" }, { status: 401 });
  }
  if (String(body.event_id) !== eventHeader) {
    return NextResponse.json({ error: "event id mismatch" }, { status: 400 });
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(body.iat ?? 0));
  if (!Number.isFinite(age) || age > MAX_MESSAGE_AGE_SECONDS) {
    return NextResponse.json({ error: "stale message" }, { status: 401 });
  }
  const idpSub = typeof body.identity_sub === "string" ? body.identity_sub : "";
  if (!idpSub) {
    return NextResponse.json({ error: "missing identity_sub" }, { status: 400 });
  }
  const idpSid = typeof body.idp_sid === "string" ? body.idp_sid : null;

  if (await seenOrRecord(String(body.event_id), "control_center")) {
    return NextResponse.json({ status: "already_applied", revoked: 0 });
  }

  const revoked = await revokeSsoSessions(
    idpSub,
    idpSid,
    typeof body.scope === "string" ? body.scope : "identity_sessions"
  );
  await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_SESSION_REVOKED, {
    actorEmail: null,
    reason: String(body.reason ?? "logout"),
    details: { source: "control_center", revoked, idpSub },
  });
  return NextResponse.json({ status: "revoked", revoked });
}
