import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "crypto";
import { db } from "@/lib/db";
import { POST as revokePost } from "@/app/api/v1/platform/sessions/revoke/route";

/**
 * Central session revocation (Phase 1.1 / ADR-0004).
 *
 * The route must accept only a correctly signed message from the Control Center
 * and must revoke exactly the SSO-derived platform sessions of one immutable
 * subject — never a local password session, never another identity's session.
 */

const KEY = "test-cc-api-key";
const ISSUER = "bloomcore-control-center";
const AUD = "bloomcore-one";

function sign(body: object, key = KEY): { raw: string; sig: string } {
  const raw = JSON.stringify(body);
  return { raw, sig: createHmac("sha256", key).update(raw).digest("hex") };
}

function makeRequest(raw: string, sig: string, eventId: string): Request {
  return new Request("http://localhost/api/v1/platform/sessions/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bloomcore-signature": sig,
      "x-bloomcore-event": eventId,
    },
    body: raw,
  });
}

function message(overrides: Record<string, unknown> = {}) {
  const eventId = (overrides.event_id as string) ?? `evt-${Math.random()}`;
  return {
    event_id: eventId,
    iss: ISSUER,
    aud: AUD,
    iat: Math.floor(Date.now() / 1000),
    identity_sub: "uid-immutable-1",
    idp_sid: "sid-abc",
    scope: "identity_sessions",
    reason: "logout",
    ...overrides,
  };
}

let adminId: string;

beforeEach(async () => {
  process.env.PLATFORM_OIDC_ENABLED = "true";
  process.env.PLATFORM_OIDC_ISSUER = "http://localhost:9000/application/o/bloomcore-one/";
  process.env.PLATFORM_OIDC_CLIENT_ID = "bloomcore-one-sso";
  process.env.PLATFORM_OIDC_CLIENT_SECRET = "secret";
  process.env.PLATFORM_OIDC_CC_BASE = "http://localhost:8400";
  process.env.PLATFORM_OIDC_CC_API_KEY = KEY;

  await db.oidcRevocationEvent.deleteMany({});
  const admin = await db.platformSuperAdmin.upsert({
    where: { email: "revocation-test@bloomcore.test" },
    update: {},
    create: {
      email: "revocation-test@bloomcore.test",
      fullName: "Revocation Test",
      passwordHash: "x",
      status: "active",
    },
  });
  adminId = admin.id;
  await db.sessionRecord.deleteMany({});
});

afterEach(async () => {
  await db.oidcRevocationEvent.deleteMany({});
  await db.sessionRecord.deleteMany({});
});

async function seedSessions() {
  const expires = new Date(Date.now() + 8 * 3600 * 1000);
  await db.sessionRecord.create({
    data: {
      id: "jti-sso-1",
      subjectType: "platform",
      subjectId: adminId,
      expiresAt: expires,
      authSource: "sso",
      idpSub: "uid-immutable-1",
      idpSid: "sid-abc",
    },
  });
  await db.sessionRecord.create({
    data: {
      id: "jti-local-1",
      subjectType: "platform",
      subjectId: adminId,
      expiresAt: expires,
      authSource: "local",
    },
  });
  await db.sessionRecord.create({
    data: {
      id: "jti-other-identity",
      subjectType: "platform",
      subjectId: adminId,
      expiresAt: expires,
      authSource: "sso",
      idpSub: "uid-someone-else",
      idpSid: "sid-other",
    },
  });
}

async function active() {
  const rows = await db.sessionRecord.findMany({
    where: { revokedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id).sort();
}

describe("central session revocation", () => {
  it("revokes only the matching SSO session", async () => {
    await seedSessions();
    const body = message();
    const { raw, sig } = sign(body);
    const res = await revokePost(makeRequest(raw, sig, body.event_id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { revoked: number };
    expect(json.revoked).toBe(1);
    // The local password session and the other identity survive.
    expect(await active()).toEqual(["jti-local-1", "jti-other-identity"]);
  });

  it("rejects a bad signature", async () => {
    await seedSessions();
    const body = message();
    const { raw } = sign(body, "wrong-key");
    const res = await revokePost(makeRequest(raw, "0".repeat(64), body.event_id));
    expect(res.status).toBe(401);
    expect((await active()).length).toBe(3);
  });

  it("rejects a message signed with the right key but wrong issuer", async () => {
    await seedSessions();
    const body = message({ iss: "impostor" });
    const { raw, sig } = sign(body);
    const res = await revokePost(makeRequest(raw, sig, body.event_id));
    expect(res.status).toBe(401);
    expect((await active()).length).toBe(3);
  });

  it("rejects a message addressed to another product", async () => {
    await seedSessions();
    const body = message({ aud: "schemeknit-sso" });
    const { raw, sig } = sign(body);
    const res = await revokePost(makeRequest(raw, sig, body.event_id));
    expect(res.status).toBe(401);
  });

  it("rejects a stale message", async () => {
    await seedSessions();
    const body = message({ iat: Math.floor(Date.now() / 1000) - 3600 });
    const { raw, sig } = sign(body);
    const res = await revokePost(makeRequest(raw, sig, body.event_id));
    expect(res.status).toBe(401);
  });

  it("rejects an event-id header mismatch", async () => {
    await seedSessions();
    const body = message();
    const { raw, sig } = sign(body);
    const res = await revokePost(makeRequest(raw, sig, "different"));
    expect(res.status).toBe(400);
  });

  it("rejects a tampered body (signature covers exact bytes)", async () => {
    await seedSessions();
    const body = message();
    const { raw, sig } = sign(body);
    const tampered = raw.replace("uid-immutable-1", "uid-someone-else");
    const res = await revokePost(makeRequest(tampered, sig, body.event_id));
    expect(res.status).toBe(401);
  });

  it("is idempotent for a repeated event id", async () => {
    await seedSessions();
    const body = message();
    const { raw, sig } = sign(body);
    const first = await revokePost(makeRequest(raw, sig, body.event_id));
    expect((await first.json()) as { revoked: number }).toMatchObject({ revoked: 1 });
    const second = await revokePost(makeRequest(raw, sig, body.event_id));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "already_applied", revoked: 0 });
  });

  it("revokes by subject when no sid is supplied", async () => {
    await seedSessions();
    const body = message({ idp_sid: null });
    const { raw, sig } = sign(body);
    const res = await revokePost(makeRequest(raw, sig, body.event_id));
    expect((await res.json()) as { revoked: number }).toMatchObject({ revoked: 1 });
    expect(await active()).toEqual(["jti-local-1", "jti-other-identity"]);
  });


  it("does NOT record the event when the revocation fails (so a retry can succeed)", async () => {
    await seedSessions();
    const body = message();
    const { raw, sig } = sign(body);

    // Fail the whole transaction: pre-fix the event id was committed on its own
    // first, so the retry saw "already_applied" and the SSO session stayed
    // alive while the Control Center recorded delivery.
    const txSpy = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("simulated transaction failure"));

    const failed = await revokePost(makeRequest(raw, sig, body.event_id));
    expect(failed.status).toBe(500);
    txSpy.mockRestore();

    // Nothing was applied and the event id was not consumed.
    expect(
      await db.oidcRevocationEvent.findUnique({ where: { eventId: body.event_id } })
    ).toBeNull();
    expect((await active()).length).toBe(3);

    // The Control Center retries the same event and now succeeds.
    const retried = await revokePost(makeRequest(raw, sig, body.event_id));
    expect(retried.status).toBe(200);
    expect((await retried.json()) as { revoked: number }).toMatchObject({ revoked: 1 });
    expect(await active()).toEqual(["jti-local-1", "jti-other-identity"]);
  });

  it("refuses to serve when the SSO feature is disabled", async () => {
    process.env.PLATFORM_OIDC_ENABLED = "false";
    const body = message();
    const { raw, sig } = sign(body);
    const res = await revokePost(makeRequest(raw, sig, body.event_id));
    // A disabled deployment has no SSO surface at all — the endpoint must not
    // exist rather than sit there as an unauthenticated revocation target.
    expect(res.status).toBe(404);
    process.env.PLATFORM_OIDC_ENABLED = "true";
  });
});
