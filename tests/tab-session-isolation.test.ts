import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, cleanDatabase, createTestAdmin } from "./setup";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

import {
  createSessionRecord,
  isSessionRecordActive,
  revokeSession,
} from "@/lib/security/session-store";
import { createTabAssertion, TAB_ASSERTION_HEADER } from "@/lib/security/tab-assertion";
import type { JwtPayload } from "@/lib/auth";

function adminPayload(userId: string, jti: string): JwtPayload {
  return {
    userId,
    email: "tab-test@example.com",
    fullName: "Tab Test",
    role: "admin",
    modules: [],
    tokenVersion: 0,
    amr: "pwd+mfa",
    jti,
  };
}

describe("tab session registry", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.stubEnv("MFA_ENFORCEMENT", "optional");
  });

  it("gives two tabs distinct session ids and independent revocation", async () => {
    const admin = await createTestAdmin();
    const a = randomUUID();
    const b = randomUUID();
    for (const id of [a, b]) {
      await createSessionRecord({
        id,
        subjectType: "user",
        subjectId: admin.id,
        tenantId: admin.tenantId,
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    await revokeSession(a, "logout");
    expect(await isSessionRecordActive(a)).toBe(false);
    expect(await isSessionRecordActive(b)).toBe(true);
  });

  it("rejects missing and expired registry records", async () => {
    const admin = await createTestAdmin();
    const id = randomUUID();
    await createSessionRecord({
      id,
      subjectType: "user",
      subjectId: admin.id,
      tenantId: admin.tenantId,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await isSessionRecordActive(id)).toBe(false);
    expect(await isSessionRecordActive(randomUUID())).toBe(false);
  });

  it("counts sessions independently per subject", async () => {
    const one = await createTestAdmin();
    const two = await createTestAdmin();
    const a = randomUUID();
    const b = randomUUID();
    await createSessionRecord({
      id: a,
      subjectType: "user",
      subjectId: one.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await createSessionRecord({
      id: b,
      subjectType: "user",
      subjectId: two.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const count = await prisma.sessionRecord.count({
      where: { subjectId: one.id, revokedAt: null },
    });
    expect(count).toBe(1);
  });
});

describe("middleware tab assertion", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.stubEnv("ALLOW_LEGACY_COOKIE_SESSIONS", "0");
  });

  it("accepts a valid assertion and ignores a cookie-only session", async () => {
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("../src/middleware");
    const admin = await createTestAdmin();
    const assertion = await createTabAssertion({
      sessionId: randomUUID(),
      module: "admin",
      payload: adminPayload(admin.id, randomUUID()),
    });

    const withAssertion = new NextRequest(
      "http://localhost:3000/admin/dashboard",
      { headers: { [TAB_ASSERTION_HEADER]: assertion } }
    );
    expect((await middleware(withAssertion)).status).toBe(200);

    const cookieOnly = new NextRequest("http://localhost:3000/admin/dashboard");
    cookieOnly.cookies.set("bik-admin-session", assertion);
    const res = await middleware(cookieOnly);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("rejects malformed assertions and a platform assertion on tenant routes", async () => {
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("../src/middleware");
    const malformed = new NextRequest("http://localhost:3000/admin/dashboard", {
      headers: { [TAB_ASSERTION_HEADER]: "bogus" },
    });
    expect((await middleware(malformed)).status).toBe(307);

    const admin = await createTestAdmin();
    const platformAssertion = await createTabAssertion({
      sessionId: randomUUID(),
      module: "platform",
      payload: {
        ...adminPayload(admin.id, randomUUID()),
        role: "admin",
        kind: "platform",
        adminId: "platform-1",
      },
    });
    const tenantRoute = new NextRequest(
      "http://localhost:3000/admin/dashboard",
      { headers: { [TAB_ASSERTION_HEADER]: platformAssertion } }
    );
    expect((await middleware(tenantRoute)).status).toBe(307);
  });
});
