import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  isSessionCurrent,
  verifyToken,
  SESSION_POLICY,
  type JwtPayload,
} from "@/lib/auth";
import { createTabAssertion } from "@/lib/security/tab-assertion";
import { tabSurfaceForPayload } from "@/lib/security/tab-proof";
import { verifyPlatformToken } from "@/lib/platform-auth";
import { mfaPolicy } from "@/lib/security/config";
import {
  createSessionRecord,
  isSessionRecordActive,
} from "@/lib/security/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/tab/enroll
 *
 * One-time exchange of a just-issued login token for a tab-scoped
 * proof-of-possession credential. The browser generates a non-extractable
 * ECDSA key pair and sends only the public JWK. The login token is never stored
 * by the tab transport after this call.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let payload = await verifyToken<JwtPayload>(token);
  if (!payload) {
    const platform = await verifyPlatformToken(token);
    if (platform) {
      payload = {
        ...platform,
        role: "admin",
        tokenVersion: platform.tokenVersion ?? 0,
      } as unknown as JwtPayload;
    }
  }
  if (
    !payload?.jti ||
    (!payload.userId &&
      !(payload.kind === "platform" && typeof payload.adminId === "string"))
  ) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (mfaPolicy() === "enforce" && payload.amr !== "pwd+mfa") {
    return NextResponse.json({ error: "MFA required" }, { status: 401 });
  }

  const surface = tabSurfaceForPayload(payload);
  if (!surface) {
    return NextResponse.json({ error: "No tab surface" }, { status: 401 });
  }

  let body: { publicKeyJwk?: unknown };
  try {
    body = (await request.json()) as { publicKeyJwk?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const rawKey = typeof body.publicKeyJwk === "string" ? body.publicKeyJwk : "";
  if (!rawKey || rawKey.length > 4096) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }
  try {
    const jwk = JSON.parse(rawKey) as JsonWebKey;
    if (
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string"
    ) {
      return NextResponse.json({ error: "Invalid key" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  // Selection tokens are short-lived and do not have a registry row yet.
  if (payload.tokenUse === "workspace-selection") {
    await createSessionRecord({
      id: payload.jti,
      subjectType: "user",
      subjectId: payload.userId,
      tenantId: payload.tenantId ?? null,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    }).catch(() => undefined);
  } else if (surface === "platform") {
    const admin = payload.adminId
      ? await db.platformSuperAdmin.findUnique({
          where: { id: payload.adminId },
          select: { status: true, tokenVersion: true },
        })
      : null;
    if (
      !admin ||
      admin.status !== "active" ||
      admin.tokenVersion !== (payload.tokenVersion ?? 0) ||
      !(await isSessionRecordActive(payload.jti))
    ) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
  } else if (!(await isSessionCurrent(payload))) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const subjectType =
    surface === "platform"
      ? "platform"
      : payload.role === "customer"
        ? "customer"
        : "user";
  const subjectId = payload.userId ?? payload.adminId ?? "";
  const amr = payload.amr === "pwd+mfa" ? "pwd+mfa" : "pwd";

  const credential = await db.tabCredential.upsert({
    where: { sessionId: payload.jti },
    create: {
      sessionId: payload.jti,
      subjectType,
      subjectId,
      tenantId: payload.tenantId ?? null,
      module: surface,
      amr,
      payloadJson: JSON.stringify(payload),
      publicKeyJwk: rawKey,
    },
    update: {
      subjectType,
      subjectId,
      tenantId: payload.tenantId ?? null,
      module: surface,
      amr,
      payloadJson: JSON.stringify(payload),
      publicKeyJwk: rawKey,
      lastUsedAt: new Date(),
    },
  });

  const assertion = await createTabAssertion({
    sessionId: payload.jti,
    module: surface,
    payload,
  });

  return NextResponse.json(
    {
      credentialId: credential.id,
      sessionId: credential.sessionId,
      module: surface,
      assertion,
      assertionExpiresIn: 120,
      sessionExpiresIn: SESSION_POLICY.ABSOLUTE_TIMEOUT_SECONDS,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
