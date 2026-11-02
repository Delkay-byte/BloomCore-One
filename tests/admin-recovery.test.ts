/**
 * Administrator-assisted recovery tests.
 *
 * Covers tenant/platform authority boundaries, code expiry and single use,
 * session revocation and password replacement.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { verifyPassword } from "@/lib/auth";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
  createTestTenant,
} from "./setup";

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

import {
  issueAccountRecoveryCode,
  redeemRecoveryCode,
  resetAccountMfa,
} from "@/lib/actions/account-recovery.actions";

vi.setConfig({ testTimeout: 30000 });

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setSession(cookie: string, payload: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.set(
    cookie,
    await new SignJWT({ ...payload, lastActivityAt: now })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function setTenantAdmin(user: { id: string; email: string }) {
  mockCookieStore.clear();
  await setSession("bik-admin-session", {
    userId: user.id,
    email: user.email,
    fullName: "Admin",
    role: "admin",
    modules: ["momo", "susu"],
    tokenVersion: 0,
  });
}

async function setPlatformAdmin(admin: { id: string; email: string }) {
  mockCookieStore.clear();
  await setSession("bik-platform-session", {
    adminId: admin.id,
    email: admin.email,
    fullName: "Platform",
    kind: "platform",
    tokenVersion: 0,
  });
}

async function createWorker(tenantId: string, suffix: string) {
  const bcrypt = await import("bcryptjs");
  return prisma.user.create({
    data: {
      tenantId,
      email: `worker-${suffix}@example.com`,
      fullName: `Worker ${suffix}`,
      role: "worker",
      status: "active",
      momoEnabled: true,
      passwordHash: await bcrypt.hash("OldPass123", 12),
    },
  });
}

describe("administrator-assisted recovery", () => {
  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
  });

  it("lets a tenant admin issue a code for an ordinary user in the same tenant", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const worker = await createWorker(tenant.id, "a1");
    await setTenantAdmin(admin);

    const result = await issueAccountRecoveryCode({
      targetType: "user",
      targetIdentifier: worker.email,
      reason: "Identity verified by phone call.",
    });

    expect(result.success).toBe(true);
    expect(result.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = await prisma.accountRecoveryRequest.findFirst();
    expect(stored?.targetId).toBe(worker.id);
    expect(stored?.tenantId).toBe(tenant.id);
    expect(JSON.stringify(stored)).not.toContain(result.code!.replace(/-/g, ""));
  });

  it("denies cross-tenant targets and protected tenant administrators", async () => {
    const tenantA = await createTestTenant({ name: "A" });
    const tenantB = await createTestTenant({ name: "B" });
    const adminA = await createTestAdmin({ tenantId: tenantA.id });
    const adminB = await createTestAdmin({ tenantId: tenantB.id });
    const workerB = await createWorker(tenantB.id, "b1");
    await setTenantAdmin(adminA);

    const crossTenant = await issueAccountRecoveryCode({
      targetType: "user",
      targetIdentifier: workerB.email,
      reason: "Attempt across tenant boundary.",
    });
    expect(crossTenant.success).toBe(false);

    const peerAdmin = await issueAccountRecoveryCode({
      targetType: "user",
      targetIdentifier: adminB.email,
      reason: "Attempt to reset another administrator.",
    });
    expect(peerAdmin.success).toBe(false);
  });

  it("lets a platform operator recover a tenant administrator", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const bcrypt = await import("bcryptjs");
    const platform = await prisma.platformSuperAdmin.create({
      data: {
        email: "platform@example.com",
        fullName: "Operator",
        passwordHash: await bcrypt.hash("Platform123", 12),
      },
    });
    await setPlatformAdmin(platform);

    const result = await issueAccountRecoveryCode({
      targetType: "user",
      targetIdentifier: admin.email,
      reason: "Owner verified by established phone number.",
    });
    expect(result.success).toBe(true);
  });

  it("redeems once, changes the password and revokes sessions", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const worker = await createWorker(tenant.id, "c1");
    await setTenantAdmin(admin);

    const issued = await issueAccountRecoveryCode({
      targetType: "user",
      targetIdentifier: worker.email,
      reason: "Identity verified in person at the office.",
    });
    expect(issued.success).toBe(true);

    await prisma.sessionRecord.create({
      data: {
        id: `sess-${Date.now()}`,
        subjectType: "user",
        subjectId: worker.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const redeemed = await redeemRecoveryCode({
      code: issued.code!,
      newPassword: "NewPass123",
      confirmPassword: "NewPass123",
    });
    expect(redeemed.success).toBe(true);

    const updated = await prisma.user.findUnique({ where: { id: worker.id } });
    expect(await verifyPassword("NewPass123", updated!.passwordHash)).toBe(true);
    expect(updated!.tokenVersion).toBe(1);

    const sessions = await prisma.sessionRecord.findMany({
      where: { subjectId: worker.id },
    });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    const replay = await redeemRecoveryCode({
      code: issued.code!,
      newPassword: "Another123",
      confirmPassword: "Another123",
    });
    expect(replay.success).toBe(false);
  });

  it("rejects expired codes", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const worker = await createWorker(tenant.id, "d1");
    await setTenantAdmin(admin);

    const issued = await issueAccountRecoveryCode({
      targetType: "user",
      targetIdentifier: worker.email,
      reason: "Identity verified by phone.",
    });
    await prisma.accountRecoveryRequest.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await redeemRecoveryCode({
      code: issued.code!,
      newPassword: "NewPass123",
      confirmPassword: "NewPass123",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid or has expired/i);
  });

  it("supports customer portal recovery within the tenant", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const { customer } = await createTestCustomer(admin.id, 10, "R1");
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        portalEnabled: true,
        portalPasswordHash:
          "$2b$12$Liry.nw.u149hj.S6S6JfexTBF7uu1EZY8StKjQTA39/jdAco3ZLK",
      },
    });
    await setTenantAdmin(admin);

    const issued = await issueAccountRecoveryCode({
      targetType: "customer",
      targetIdentifier: customer.customerId,
      reason: "Customer verified in person with their card.",
    });
    expect(issued.success).toBe(true);

    const redeemed = await redeemRecoveryCode({
      code: issued.code!,
      newPassword: "NewPass123",
      confirmPassword: "NewPass123",
    });
    expect(redeemed.success).toBe(true);
    const updated = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(await verifyPassword("NewPass123", updated!.portalPasswordHash!)).toBe(true);
  });

  it("resets MFA and revokes sessions without exposing secrets", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const worker = await createWorker(tenant.id, "e1");
    await prisma.user.update({
      where: { id: worker.id },
      data: { mfaEnabled: true, mfaSecret: "v1:fake:fake:fake" },
    });
    await setTenantAdmin(admin);

    const result = await resetAccountMfa({
      targetType: "user",
      targetIdentifier: worker.email,
      reason: "User lost authenticator and recovery codes; identity verified.",
    });
    expect(result.success).toBe(true);
    const updated = await prisma.user.findUnique({ where: { id: worker.id } });
    expect(updated?.mfaEnabled).toBe(false);
    expect(updated?.mfaSecret).toBeNull();
  });
});
