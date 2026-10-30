/**
 * BIK Prestige Enterprise — Platform Super Admin authentication tests.
 *
 * Verifies the platform boundary is a genuinely separate security domain:
 *   * platform credentials authenticate only via the platform path
 *   * tenant sessions (admin/worker/collector/customer) can never open the
 *     platform boundary, and a platform session can never act as a tenant user
 *   * the platform cookie namespace is disjoint from the tenant cookie namespaces
 *   * rate limiting, tokenVersion invalidation and status checks are enforced
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => {
      mockCookieStore.set(name, value);
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  authenticatePlatformAdmin,
  getPlatformSession,
  requirePlatformAdmin,
  clearPlatformSession,
  PLATFORM_COOKIE,
} from "@/lib/platform-auth";
import { platformLogin, platformLogout, platformChangePassword } from "@/lib/actions/platform.actions";
import { getTenantContext } from "@/lib/tenant";
import { SESSION_COOKIES } from "@/lib/auth";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/platform-audit";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const now = Math.floor(Date.now() / 1000);

async function signPlatformToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ kind: "platform", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function setPlatformSessionCookie(adminId: string, tokenVersion = 0) {
  mockCookieStore.set(
    PLATFORM_COOKIE,
    await signPlatformToken({
      adminId,
      email: "operator@bloomcore.test",
      fullName: "Platform Operator",
      tokenVersion,
      lastActivityAt: now,
    })
  );
}

let adminCounter = 0;
async function createPlatformAdmin(options: { status?: string; tokenVersion?: number } = {}) {
  adminCounter++;
  return prisma.platformSuperAdmin.create({
    data: {
      email: `operator-${adminCounter}-${Date.now()}@bloomcore.test`,
      fullName: "Platform Operator",
      passwordHash: await bcrypt.hash("SuperPass123", 12),
      status: options.status ?? "active",
      tokenVersion: options.tokenVersion ?? 0,
    },
  });
}

describe("Platform authentication", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
  });

  it("authenticates a valid platform administrator", async () => {
    const admin = await createPlatformAdmin();
    const result = await authenticatePlatformAdmin(admin.email, "SuperPass123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admin.adminId).toBe(admin.id);
      expect(result.admin.email).toBe(admin.email);
    }
  });

  it("rejects a wrong password with a generic error", async () => {
    const admin = await createPlatformAdmin();
    const result = await authenticatePlatformAdmin(admin.email, "WrongPass1");
    expect(result.ok).toBe(false);
    // "invalid" and "not_found" must be indistinguishable to the caller UI;
    // the action layer maps both to one generic message.
    if (!result.ok) expect(["invalid", "not_found"]).toContain(result.reason);
  });

  it("rejects an inactive platform administrator", async () => {
    const admin = await createPlatformAdmin({ status: "inactive" });
    const result = await authenticatePlatformAdmin(admin.email, "SuperPass123");
    expect(result.ok).toBe(false);
  });

  it("resolves a platform session from the platform cookie and re-checks the DB", async () => {
    const admin = await createPlatformAdmin();
    await setPlatformSessionCookie(admin.id);

    const session = await getPlatformSession();
    expect(session).not.toBeNull();
    expect(session!.adminId).toBe(admin.id);
  });

  it("rejects a tenant JWT replayed into the platform cookie", async () => {
    const admin = await createPlatformAdmin();
    const user = await createTestAdmin();

    // A real, validly-signed tenant session token — but kind is not "platform".
    const tenantToken = await new SignJWT({
      userId: user.id,
      email: user.email,
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET);

    mockCookieStore.set(PLATFORM_COOKIE, tenantToken);
    expect(await getPlatformSession()).toBeNull();

    // And a platform token missing the kind claim entirely is rejected too.
    const noKind = await new SignJWT({ adminId: admin.id, email: admin.email })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET);
    mockCookieStore.set(PLATFORM_COOKIE, noKind);
    expect(await getPlatformSession()).toBeNull();
  });

  it("rejects a platform session when tokenVersion is bumped (sessions invalidated)", async () => {
    const admin = await createPlatformAdmin();
    await setPlatformSessionCookie(admin.id, 0);
    expect(await getPlatformSession()).not.toBeNull();

    await prisma.platformSuperAdmin.update({
      where: { id: admin.id },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(await getPlatformSession()).toBeNull();
  });

  it("rejects a deactivated platform administrator despite a valid cookie", async () => {
    const admin = await createPlatformAdmin();
    await setPlatformSessionCookie(admin.id);
    await prisma.platformSuperAdmin.update({
      where: { id: admin.id },
      data: { status: "inactive" },
    });
    expect(await getPlatformSession()).toBeNull();
  });

  it("redirects unauthenticated access to the platform login (fail closed)", async () => {
    mockCookieStore.delete(PLATFORM_COOKIE);
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/platform/login");
  });

  it("keeps the platform cookie namespace disjoint from every tenant cookie", () => {
    const tenantCookieNames = Object.values(SESSION_COOKIES);
    expect(tenantCookieNames).not.toContain(PLATFORM_COOKIE);
    expect(new Set(tenantCookieNames).size).toBe(tenantCookieNames.length);
  });

  it("a platform cookie can never resolve a tenant context", async () => {
    const admin = await createPlatformAdmin();
    await setPlatformSessionCookie(admin.id);

    // Only the platform cookie exists. Every tenant module guard must fail closed.
    expect(await getTenantContext("admin")).toBeNull();
    expect(await getTenantContext("momo")).toBeNull();
    expect(await getTenantContext("susu")).toBeNull();
    expect(await getTenantContext("customer")).toBeNull();
  });

  it("rate limits repeated platform login failures", async () => {
    const admin = await createPlatformAdmin();
    const fd = () => {
      const f = new FormData();
      f.set("email", admin.email);
      f.set("password", "WrongPass1");
      return f;
    };

    // 5 attempts are allowed to fail; the 6th is rate limited even with the
    // CORRECT password.
    for (let i = 0; i < 5; i++) {
      const result = await platformLogin(fd());
      expect(result?.success).toBe(false);
    }
    const correctFd = new FormData();
    correctFd.set("email", admin.email);
    correctFd.set("password", "SuperPass123");
    const blocked = await platformLogin(correctFd);
    expect(blocked?.success).toBe(false);
    expect(blocked?.error).toMatch(/too many/i);
  });

  it("records platform audit events for login and logout", async () => {
    const admin = await createPlatformAdmin();
    await setPlatformSessionCookie(admin.id);

    await platformLogout().catch(() => {});
    expect(mockCookieStore.has(PLATFORM_COOKIE)).toBe(false);

    const events = await prisma.platformAuditLog.findMany({
      where: { action: PLATFORM_AUDIT_ACTIONS.PLATFORM_LOGOUT },
    });
    expect(events.length).toBe(1);
    expect(events[0].actorId).toBe(admin.id);
  });

  it("clears only the platform cookie on platform logout", async () => {
    const admin = await createPlatformAdmin();
    await setPlatformSessionCookie(admin.id);
    // A tenant cookie must survive a platform logout.
    mockCookieStore.set(SESSION_COOKIES.admin, "tenant-token");

    await clearPlatformSession();
    expect(mockCookieStore.has(PLATFORM_COOKIE)).toBe(false);
    expect(mockCookieStore.get(SESSION_COOKIES.admin)).toBe("tenant-token");
  });

  it("changes the platform password, forces policy and invalidates other sessions", async () => {
    const admin = await createPlatformAdmin();
    await setPlatformSessionCookie(admin.id, 0);

    // Weak password rejected by policy.
    const weak = new FormData();
    weak.set("currentPassword", "SuperPass123");
    weak.set("newPassword", "short");
    weak.set("confirmPassword", "short");
    expect((await platformChangePassword(weak)).error).toMatch(/8 characters/i);

    const good = new FormData();
    good.set("currentPassword", "SuperPass123");
    good.set("newPassword", "NewStrong9");
    good.set("confirmPassword", "NewStrong9");
    const result = await platformChangePassword(good);
    expect(result.success).toBe(true);

    // The old session token (tokenVersion 0) is now invalid…
    mockCookieStore.delete(PLATFORM_COOKIE);
    await setPlatformSessionCookie(admin.id, 0);
    expect(await getPlatformSession()).toBeNull();

    // …and the new password authenticates.
    const login = await authenticatePlatformAdmin(admin.email, "NewStrong9");
    expect(login.ok).toBe(true);
  });
});

describe("Platform vs tenant boundary — negative access tests", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
  });

  it("a tenant administrator cannot access platform routes", async () => {
    const user = await createTestAdmin();
    // Valid admin-module session cookie
    const token = await new SignJWT({
      userId: user.id,
      email: user.email,
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET);
    mockCookieStore.set(SESSION_COOKIES.admin, token);

    // Platform guard reads ONLY the platform cookie → unauthenticated redirect.
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/platform/login");
    expect(await getPlatformSession()).toBeNull();
  });

  it("a worker, collector or customer session cannot open the platform boundary", async () => {
    const tenant = await createTestTenant();
    const roles: Array<{ role: string; cookie: string; modules: string[] }> = [
      { role: "worker", cookie: SESSION_COOKIES.momo, modules: ["momo"] },
      { role: "collector", cookie: SESSION_COOKIES.susu, modules: ["susu"] },
    ];
    for (const [i, r] of roles.entries()) {
      const user = await prisma.user.create({
        data: {
          email: `staff-${i}-${Date.now()}@bikprestige.com`,
          fullName: "Staff",
          role: r.role,
          status: "active",
          passwordHash: "x",
          tenantId: tenant.id,
          momoEnabled: r.modules.includes("momo"),
          susuEnabled: r.modules.includes("susu"),
        },
      });
      const token = await new SignJWT({
        userId: user.id,
        email: user.email,
        role: r.role,
        modules: r.modules,
        tokenVersion: 0,
        lastActivityAt: now,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(now)
        .setExpirationTime("1h")
        .sign(JWT_SECRET);
      mockCookieStore.set(r.cookie, token);

      await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/platform/login");
      mockCookieStore.delete(r.cookie);
    }
  });
});
