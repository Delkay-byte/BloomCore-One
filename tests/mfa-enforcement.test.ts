import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestCustomer, createTestTenant } from "./setup";
import { hashPassword } from "@/lib/auth";

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

import { getAdminSession } from "@/lib/auth";
import {
  resolveCustomerAuth,
  resolveStaffAuth,
} from "@/lib/actions/auth.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const PASSWORD = "Test1234!";

async function setAdminCookie(amr: "pwd" | "pwd+mfa") {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: "any-admin",
      email: "admin@example.com",
      fullName: "Admin",
      role: "admin",
      modules: ["momo"],
      tokenVersion: 0,
      amr,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

describe("mandatory MFA policy", () => {
  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forces enrolment for an unenrolled worker and customer when enforcing", async () => {
    vi.stubEnv("MFA_ENFORCEMENT", "enforce");
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const passwordHash = await hashPassword(PASSWORD);
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `mfa-worker-${Date.now()}@example.com`,
        fullName: "MFA Worker",
        role: "worker",
        status: "active",
        momoEnabled: true,
        passwordHash,
      },
    });
    const { customer } = await createTestCustomer(admin.id, 10, "MFA");
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        portalEnabled: true,
        portalPasswordHash: passwordHash,
      },
    });

    const staff = await resolveStaffAuth(worker.email, PASSWORD, "momo");
    expect("mfa" in staff && staff.mfa).toBe("enroll");

    const portal = await resolveCustomerAuth(customer.customerId, PASSWORD);
    expect("mfa" in portal && portal.mfa).toBe("enroll");
  });

  it("rejects password-only sessions while enforcing", async () => {
    vi.stubEnv("MFA_ENFORCEMENT", "enforce");
    await setAdminCookie("pwd");
    expect(await getAdminSession()).toBeNull();

    await setAdminCookie("pwd+mfa");
    expect(await getAdminSession()).not.toBeNull();
  });
});
