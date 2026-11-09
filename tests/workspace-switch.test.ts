/**
 * Secure MoMo <-> Susu workspace switching.
 *
 * The browser names only the destination. The server must re-resolve the same
 * authenticated User, re-check the tenant and module capability, preserve MFA
 * assurance, and bind the new session to the destination surface.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { resolveStaffAuth, switchWorkspace } from "@/lib/actions/auth.actions";
import { verifyToken, type JwtPayload } from "@/lib/auth";
import { tabSurfaceForPayload } from "@/lib/security/tab-proof";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const PASSWORD = "Test1234!";

async function seedUser(options: {
  momo: boolean;
  susu: boolean;
  collector?: boolean;
}) {
  const tenant = await createTestTenant({ momo: true, susu: true });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `switch-${Date.now()}-${Math.random()}@test.invalid`,
      fullName: "Switch Test",
      role: "worker",
      status: "active",
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      momoEnabled: options.momo,
      susuEnabled: options.susu,
    },
  });
  if (options.collector) {
    await prisma.collector.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        status: "active",
      },
    });
  }
  return { tenant, user };
}

async function setModuleCookie(module: "momo" | "susu", userId: string) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    module === "momo" ? "bik-worker-session" : "bik-collector-session",
    await new SignJWT({
      userId,
      email: "switch@test.invalid",
      fullName: "Switch Test",
      role: "worker",
      modules: ["momo", "susu"],
      module,
      tokenVersion: 0,
      amr: "pwd+mfa",
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("workspace switching", () => {
  it("binds a dual-role Susu login to the Susu surface, not MoMo", async () => {
    const { user } = await seedUser({ momo: true, susu: true, collector: true });
    const result = await resolveStaffAuth(user.email, PASSWORD, "susu");
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload.module).toBe("susu");
      expect(result.payload.modules).toEqual(
        expect.arrayContaining(["momo", "susu"])
      );
      expect(tabSurfaceForPayload(result.payload)).toBe("susu");
    }
  });

  it("switches MoMo to Susu on the same identity without credentials", async () => {
    const { user } = await seedUser({ momo: true, susu: true, collector: true });
    await setModuleCookie("momo", user.id);

    const result = await switchWorkspace("susu");
    expect(result.success).toBe(true);
    expect(result.redirectTo).toBe("/collector/dashboard");
    expect(result.sessionToken).toBeTruthy();

    const payload = await verifyToken<JwtPayload>(result.sessionToken!);
    expect(payload?.userId).toBe(user.id);
    expect(payload?.module).toBe("susu");
    expect(payload?.modules).toEqual(expect.arrayContaining(["momo", "susu"]));
    expect(payload?.amr).toBe("pwd+mfa");
    expect(tabSurfaceForPayload(payload!)).toBe("susu");
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
  });

  it("switches Susu to MoMo on the same identity", async () => {
    const { user } = await seedUser({ momo: true, susu: true, collector: true });
    await setModuleCookie("susu", user.id);

    const result = await switchWorkspace("momo");
    expect(result.success).toBe(true);
    expect(result.redirectTo).toBe("/worker/dashboard");

    const payload = await verifyToken<JwtPayload>(result.sessionToken!);
    expect(payload?.userId).toBe(user.id);
    expect(payload?.module).toBe("momo");
    expect(tabSurfaceForPayload(payload!)).toBe("momo");
  });

  it("rejects a MoMo-only user switching to Susu", async () => {
    const { user } = await seedUser({ momo: true, susu: false });
    await setModuleCookie("momo", user.id);

    const result = await switchWorkspace("susu");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
    expect(result.sessionToken).toBeUndefined();
  });

  it("rejects a Susu-only user switching to MoMo", async () => {
    const { user } = await seedUser({
      momo: false,
      susu: true,
      collector: true,
    });
    await setModuleCookie("susu", user.id);

    const result = await switchWorkspace("momo");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });

  it("rejects switching when there is no authenticated session", async () => {
    const result = await switchWorkspace("susu");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Not authenticated");
  });

  it("rejects a revoked account", async () => {
    const { user } = await seedUser({ momo: true, susu: true, collector: true });
    await setModuleCookie("momo", user.id);
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "inactive" },
    });

    const result = await switchWorkspace("susu");
    expect(result.success).toBe(false);
  });

  it("rejects a Susu switch without an active Collector assignment", async () => {
    const { user } = await seedUser({ momo: true, susu: true, collector: false });
    await setModuleCookie("momo", user.id);

    const result = await switchWorkspace("susu");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });
});
