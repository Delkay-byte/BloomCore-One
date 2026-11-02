import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  canTransitionStatus,
  isAccountStatus,
  validateStatusTransition,
} from "@/lib/security/status";

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

import { toggleWorkerStatus } from "@/lib/actions/worker.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdmin(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Admin",
      role: "admin",
      modules: ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

describe("status policy", () => {
  it("accepts only documented statuses and transitions", () => {
    expect(isAccountStatus("active")).toBe(true);
    expect(isAccountStatus("locked")).toBe(false);
    expect(canTransitionStatus("active", "inactive")).toBe(true);
    expect(canTransitionStatus("inactive", "active")).toBe(true);
    expect(canTransitionStatus("locked", "active")).toBe(false);
    expect(validateStatusTransition("active", "deleted").ok).toBe(false);
  });

  it("rejects arbitrary status values at the action boundary", async () => {
    await cleanDatabase();
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `status-worker-${Date.now()}@example.com`,
        fullName: "Status Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
      },
    });
    await setAdmin(admin);

    const bad = await toggleWorkerStatus(worker.id, "locked");
    expect(bad.success).toBe(false);
    expect((await prisma.user.findUnique({ where: { id: worker.id } }))?.status).toBe("active");

    const deactivate = await toggleWorkerStatus(worker.id, "inactive");
    expect(deactivate.success).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: worker.id } }))?.status).toBe("inactive");

    const reactivate = await toggleWorkerStatus(worker.id, "active");
    expect(reactivate.success).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: worker.id } }))?.status).toBe("active");
  });
});
