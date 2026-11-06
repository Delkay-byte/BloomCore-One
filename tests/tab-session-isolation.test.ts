import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, cleanDatabase, createTestAdmin } from "./setup";
import { TAB_SESSION_HEADER } from "@/lib/security/tab-session";
import { createMfaChallenge } from "@/lib/security/mfa-challenge";

const store = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => store.headers,
  cookies: async () => ({
    get: (name: string) =>
      store.cookies.has(name) ? { name, value: store.cookies.get(name)! } : undefined,
    set: (name: string, value: string) => store.cookies.set(name, value),
    delete: (name: string) => store.cookies.delete(name),
  }),
}));

import {
  createToken,
  getAdminSession,
  getAnyAuthUser,
  getMomoSession,
  getSelectionUser,
  readModuleCookie,
  revokeSessionToken,
  setModuleSession,
  verifyToken,
  type JwtPayload,
} from "@/lib/auth";
import { createSelectionToken } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant";
import {
  consumeMfaChallenge,
  consumeMfaEnrollmentProof,
  isSessionRecordActive,
} from "@/lib/security/session-store";

function adminPayload(userId: string, tokenVersion = 0): JwtPayload {
  return {
    userId,
    email: "tab-test@example.com",
    fullName: "Tab Test",
    role: "admin",
    modules: [],
    tenantId: "tenant-1",
    tokenVersion,
    amr: "pwd+mfa",
  };
}

function workerPayload(userId: string): JwtPayload {
  return {
    userId,
    email: "worker@example.com",
    fullName: "Worker",
    role: "worker",
    modules: ["momo"],
    tokenVersion: 0,
    amr: "pwd+mfa",
  };
}

function useToken(token: string | null) {
  store.headers = new Headers();
  if (token) store.headers.set(TAB_SESSION_HEADER, token);
}

async function sessionId(token: string): Promise<string> {
  const payload = await verifyToken<JwtPayload>(token);
  if (!payload?.jti) throw new Error("token has no jti");
  return payload.jti;
}

describe("tab-scoped server sessions", () => {
  beforeEach(async () => {
    await cleanDatabase();
    store.headers = new Headers();
    store.cookies.clear();
    vi.stubEnv("ALLOW_LEGACY_COOKIE_SESSIONS", "0");
    vi.stubEnv("MFA_ENFORCEMENT", "optional");
  });

  it("accepts a session only from the tab transport header", async () => {
    const admin = await createTestAdmin();
    const token = await setModuleSession("admin", {
      ...adminPayload(admin.id, admin.tokenVersion),
      tenantId: admin.tenantId,
    });

    useToken(token);
    const session = await getAdminSession();
    expect(session?.userId).toBe(admin.id);
    expect(session?.jti).toBe(await sessionId(token));

    // The same token in a browser-wide cookie is not an identity in strict mode.
    useToken(null);
    store.cookies.set("bik-admin-session", token);
    expect(await getAdminSession()).toBeNull();
  });

  it("gives two tabs independent session ids and revocation state", async () => {
    const admin = await createTestAdmin();
    const tokenA = await setModuleSession("admin", {
      ...adminPayload(admin.id, admin.tokenVersion),
      tenantId: admin.tenantId,
    });
    const tokenB = await setModuleSession("admin", {
      ...adminPayload(admin.id, admin.tokenVersion),
      tenantId: admin.tenantId,
    });
    expect(await sessionId(tokenA)).not.toBe(await sessionId(tokenB));
    expect(await isSessionRecordActive(await sessionId(tokenA))).toBe(true);
    expect(await isSessionRecordActive(await sessionId(tokenB))).toBe(true);

    const payloadA = await verifyToken<JwtPayload>(tokenA);
    await revokeSessionToken(payloadA, "logout");

    useToken(tokenA);
    expect(await getAdminSession()).toBeNull();
    useToken(tokenB);
    expect((await getAdminSession())?.userId).toBe(admin.id);
  });

  it("rejects a token issued for another module", async () => {
    const admin = await createTestAdmin();
    const worker = await prisma.user.create({
      data: {
        tenantId: admin.tenantId!,
        email: `worker-${randomUUID()}@example.com`,
        fullName: "Worker",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        momoEnabled: true,
      },
    });
    const workerToken = await setModuleSession("momo", workerPayload(worker.id));

    useToken(workerToken);
    expect(await getMomoSession()).not.toBeNull();
    expect(await getAdminSession()).toBeNull();

    const adminToken = await setModuleSession("admin", {
      ...adminPayload(admin.id, admin.tokenVersion),
      tenantId: admin.tenantId,
    });
    useToken(adminToken);
    expect(await getAdminSession()).not.toBeNull();
    expect(await getMomoSession()).toBeNull();
  });

  it("rejects expired and revoked server records even when the JWT is valid", async () => {
    const admin = await createTestAdmin();
    const token = await setModuleSession("admin", {
      ...adminPayload(admin.id, admin.tokenVersion),
      tenantId: admin.tenantId,
    });
    const jti = await sessionId(token);

    await prisma.sessionRecord.update({
      where: { id: jti },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    useToken(token);
    expect(await getAdminSession()).toBeNull();

    await prisma.sessionRecord.update({
      where: { id: jti },
      data: { expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() },
    });
    expect(await getAdminSession()).toBeNull();
  });

  it("enforces MFA policy per session", async () => {
    const admin = await createTestAdmin();
    const token = await setModuleSession("admin", {
      ...adminPayload(admin.id, admin.tokenVersion),
      amr: "pwd",
      tenantId: admin.tenantId,
    });
    useToken(token);
    expect(await getAdminSession()).not.toBeNull();

    vi.stubEnv("MFA_ENFORCEMENT", "enforce");
    expect(await getAdminSession()).toBeNull();
  });

  it("resolves tenant context from the tab header, not browser-supplied ids", async () => {
    const admin = await createTestAdmin();
    const token = await setModuleSession("admin", {
      ...adminPayload(admin.id, admin.tokenVersion),
      tenantId: "browser-supplied-tenant",
    });
    useToken(token);
    const ctx = await getTenantContext("admin");
    expect(ctx?.tenantId).toBe(admin.tenantId);
    expect(ctx?.userId).toBe(admin.id);
  });

  it("carries workspace selection in the tab header and never as a session", async () => {
    const selection = await createSelectionToken({
      userId: "user-1",
      email: "person@example.com",
      fullName: "Person",
      modules: ["momo", "susu"],
    });
    useToken(selection);
    expect(await getSelectionUser()).toMatchObject({
      userId: "user-1",
      modules: ["momo", "susu"],
    });
    expect(await readModuleCookie("admin")).toBeNull();
  });

  it("consumes an MFA verification challenge exactly once", async () => {
    const id = `challenge-${randomUUID()}`;
    const input = {
      id,
      purpose: "verified" as const,
      subjectType: "user" as const,
      subjectId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await consumeMfaChallenge(input)).toBe(true);
    expect(await consumeMfaChallenge(input)).toBe(false);
  });

  it("requires a completed enrolment proof before issuing a session", async () => {
    const id = `enroll-${randomUUID()}`;
    // Finish without a proof is denied.
    expect(await consumeMfaEnrollmentProof(id)).toBe(false);

    expect(
      await consumeMfaChallenge({
        id,
        purpose: "enrolled",
        subjectType: "user",
        subjectId: "user-1",
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).toBe(true);
    expect(await consumeMfaEnrollmentProof(id)).toBe(true);
    // A replay cannot finish twice.
    expect(await consumeMfaEnrollmentProof(id)).toBe(false);
  });

  it("keeps MFA challenges tab-scoped and non-authenticating", async () => {
    const challenge = await createMfaChallenge({
      subjectType: "user",
      subjectId: "user-1",
      module: "admin",
      email: "person@example.com",
      fullName: "Person",
      mode: "verify",
      forcePasswordReset: false,
      tokenVersion: 0,
    });
    expect(challenge).toBeTruthy();
    expect(await readModuleCookie("admin")).toBeNull();
    expect(await getAnyAuthUser()).toBeNull();
  });
});

describe("middleware tab transport", () => {
  it("uses the injected header and ignores a cookie-only session", async () => {
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("../src/middleware");
    const token = await createToken(adminPayload("user-1"));

    const withHeader = new NextRequest("http://localhost:3000/admin/dashboard", {
      headers: { [TAB_SESSION_HEADER]: token },
    });
    expect((await middleware(withHeader)).status).toBe(200);

    const cookieOnly = new NextRequest("http://localhost:3000/admin/dashboard");
    cookieOnly.cookies.set("bik-admin-session", token);
    const res = await middleware(cookieOnly);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});
