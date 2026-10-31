/**
 * BIK Prestige Enterprise — Enrollment & module enforcement tests.
 *
 * Covers:
 *   * Enrolling MoMo-only, Susu-only and dual-module businesses
 *   * Server-generated tenant codes, one-time administrator credentials
 *   * Invalid module combinations rejected
 *   * The provisioned administrator belongs to the new tenant and can resolve
 *     a tenant context through the normal session chain
 *   * Module entitlement is enforced server-side from the TENANT record:
 *     MoMo-only tenants cannot run Susu actions and vice versa
 *   * Suspension blocks all tenant operations while preserving every record
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestTenant,
  createTestCustomer,
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

import { getTenantContext } from "@/lib/tenant";
import {
  enrollTenant,
  setTenantStatus,
  updateTenantModules,
  resetTenantAdminAccess,
} from "@/lib/actions/platform.actions";
import { requireTenantAdminSusu } from "@/lib/tenant";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const now = Math.floor(Date.now() / 1000);

async function setPlatformSessionCookie(adminId: string) {
  mockCookieStore.set(
    "bik-platform-session",
    await new SignJWT({
      kind: "platform",
      adminId,
      email: "operator@bloomcore.test",
      fullName: "Platform Operator",
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function createPlatformAdmin() {
  return prisma.platformSuperAdmin.create({
    data: {
      email: `enroll-operator-${Date.now()}@bloomcore.test`,
      fullName: "Platform Operator",
      passwordHash: await bcrypt.hash("SuperPass123", 12),
      status: "active",
    },
  });
}

async function setStaffSession(user: { id: string; email: string; role: string; momoEnabled: boolean; susuEnabled: boolean }) {
  const modules = [
    ...(user.momoEnabled ? ["momo"] : []),
    ...(user.susuEnabled ? ["susu"] : []),
  ];
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Tenant Admin",
      role: user.role,
      modules,
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function enrollOperator() {
  const operator = await createPlatformAdmin();
  await setPlatformSessionCookie(operator.id);
  return operator;
}

function enrollInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Adom Mobile Money",
    contactEmail: "owner@adom.test",
    momoEnabled: true,
    susuEnabled: true,
    adminFullName: "Adom Admin",
    adminEmail: `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@adom.test`,
    ...overrides,
  };
}

describe("Business enrollment", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    await enrollOperator();
  });

  it("enrolls a MoMo-only business with its own administrator", async () => {
    const result = await enrollTenant(enrollInput({ momoEnabled: true, susuEnabled: false }));
    expect(result.success).toBe(true);

    const data = result.data as { tenantId: string; tenantCode: string; temporaryPassword: string };
    const tenant = await prisma.businessTenant.findUniqueOrThrow({ where: { id: data.tenantId } });
    expect(tenant.momoEnabled).toBe(true);
    expect(tenant.susuEnabled).toBe(false);
    expect(tenant.status).toBe("ACTIVE");
    expect(tenant.code).toMatch(/^BT-[A-Z2-9]{6}$/); // server-generated

    const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: "admin" } });
    expect(admin.forcePasswordReset).toBe(true);
    expect(admin.passwordHash).not.toBe(data.temporaryPassword); // stored hashed only
    expect(tenant.primaryAdminUserId).toBe(admin.id);

    // The one-time credential must satisfy the password policy.
    expect(data.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    expect(/[A-Z]/.test(data.temporaryPassword)).toBe(true);
    expect(/[0-9]/.test(data.temporaryPassword)).toBe(true);
  });

  it("enrolls a Susu-only agency", async () => {
    const result = await enrollTenant(enrollInput({ momoEnabled: false, susuEnabled: true }));
    expect(result.success).toBe(true);
    const data = result.data as { tenantId: string };
    const tenant = await prisma.businessTenant.findUniqueOrThrow({ where: { id: data.tenantId } });
    expect(tenant.momoEnabled).toBe(false);
    expect(tenant.susuEnabled).toBe(true);
  });

  it("enrolls a dual-module business", async () => {
    const result = await enrollTenant(enrollInput({ momoEnabled: true, susuEnabled: true }));
    expect(result.success).toBe(true);
    const data = result.data as { tenantId: string };
    const tenant = await prisma.businessTenant.findUniqueOrThrow({ where: { id: data.tenantId } });
    expect(tenant.momoEnabled).toBe(true);
    expect(tenant.susuEnabled).toBe(true);
  });

  it("rejects an invalid module combination (both disabled)", async () => {
    const result = await enrollTenant(enrollInput({ momoEnabled: false, susuEnabled: false }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/module/i);
    expect(await prisma.businessTenant.count()).toBe(0);
  });

  it("rejects enrolling when the administrator email already exists (no partial records)", async () => {
    const existing = await createTestAdmin();
    const result = await enrollTenant(
      enrollInput({ adminEmail: existing.email })
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already exists/i);
    // No tenant and no second admin were created — nothing partial.
    expect(await prisma.businessTenant.count()).toBe(1); // only the fixture tenant
    expect(await prisma.user.count({ where: { role: "admin" } })).toBe(1);
  });

  it("the provisioned administrator resolves a tenant context through the normal session chain", async () => {
    const result = await enrollTenant(
      enrollInput({ momoEnabled: true, susuEnabled: true, adminEmail: `ctx-${Date.now()}@adom.test` })
    );
    const data = result.data as { tenantId: string; adminEmail: string };
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: data.adminEmail } });

    await setStaffSession({
      id: admin.id,
      email: admin.email,
      role: admin.role,
      momoEnabled: admin.momoEnabled,
      susuEnabled: admin.susuEnabled,
    });
    const ctx = await getTenantContext("admin");
    expect(ctx).not.toBeNull();
    expect(ctx!.tenantId).toBe(data.tenantId);
    expect(ctx!.modules.sort()).toEqual(["momo", "susu"]);
  });

  it("generates distinct tenant codes for consecutive enrollments", async () => {
    const r1 = await enrollTenant(enrollInput({ adminEmail: `a1-${Date.now()}@adom.test` }));
    const r2 = await enrollTenant(enrollInput({ adminEmail: `a2-${Date.now()}@adom.test` }));
    const c1 = (r1.data as { tenantCode: string }).tenantCode;
    const c2 = (r2.data as { tenantCode: string }).tenantCode;
    expect(c1).not.toBe(c2);
  });
});

describe("Tenant module enforcement (server-side entitlement)", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
  });

  it("a MoMo-only tenant: MoMo resolves, Susu is denied", async () => {
    const tenant = await createTestTenant({ momo: true, susu: false, name: "MoMo Only Ltd" });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    await setStaffSession({ id: admin.id, email: admin.email, role: "admin", momoEnabled: true, susuEnabled: false });

    const momoCtx = await getTenantContext("admin", "momo");
    expect(momoCtx).not.toBeNull();
    expect(momoCtx!.susuEnabled).toBe(false);

    const susuCtx = await getTenantContext("admin", "susu");
    expect(susuCtx).toBeNull();
    await expect(requireTenantAdminSusu()).rejects.toThrow("REDIRECT:");
  });

  it("a Susu-only tenant: Susu resolves, MoMo is denied", async () => {
    const tenant = await createTestTenant({ momo: false, susu: true, name: "Susu Only Agency" });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: false, susu: true });
    await setStaffSession({ id: admin.id, email: admin.email, role: "admin", momoEnabled: false, susuEnabled: true });

    const susuCtx = await getTenantContext("admin", "susu");
    expect(susuCtx).not.toBeNull();
    expect(susuCtx!.momoEnabled).toBe(false);

    const momoCtx = await getTenantContext("admin", "momo");
    expect(momoCtx).toBeNull();
  });

  it("a dual-module tenant resolves both modules", async () => {
    const tenant = await createTestTenant({ momo: true, susu: true });
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await setStaffSession({ id: admin.id, email: admin.email, role: "admin", momoEnabled: true, susuEnabled: true });

    expect(await getTenantContext("admin", "momo")).not.toBeNull();
    expect(await getTenantContext("admin", "susu")).not.toBeNull();
  });

  it("a user flag can NEVER grant a module the tenant has not purchased", async () => {
    // The admin's own susuEnabled flag is true, but the tenant is MoMo-only.
    const tenant = await createTestTenant({ momo: true, susu: false });
    const admin = await prisma.user.create({
      data: {
        email: `overflagged-${Date.now()}@bikprestige.com`,
        fullName: "Overflagged Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
        tenantId: tenant.id,
        momoEnabled: true,
        susuEnabled: true, // user-level flag lies — the tenant record decides
      },
    });
    await setStaffSession({ id: admin.id, email: admin.email, role: "admin", momoEnabled: true, susuEnabled: true });
    expect(await getTenantContext("admin", "susu")).toBeNull();
  });
});

describe("Tenant lifecycle — suspension without data loss", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    await enrollOperator();
  });

  it("suspension blocks every tenant operation but preserves all records; reactivation restores access", async () => {
    const tenant = await createTestTenant({ name: "Suspendee Ltd" });
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const { customer, account, cycle } = await createTestCustomer(admin.id, 50, "SUS1");
    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 100,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: `SUS-${Date.now()}`,
      },
    });
    const contributionsBefore = await prisma.contribution.count({ where: { tenantId: tenant.id } });

    await setStaffSession({ id: admin.id, email: admin.email, role: "admin", momoEnabled: true, susuEnabled: true });
    expect(await getTenantContext("admin")).not.toBeNull();

    const result = await setTenantStatus(tenant.id, "suspend", "Non-payment of platform fees");
    expect(result.success).toBe(true);

    const suspended = await prisma.businessTenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.suspensionReason).toBe("Non-payment of platform fees");

    // The suspended tenant's session can no longer resolve any tenant context…
    expect(await getTenantContext("admin")).toBeNull();

    // …but every record is preserved untouched.
    expect(await prisma.contribution.count({ where: { tenantId: tenant.id } })).toBe(contributionsBefore);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }).then((c) => c.tenantId)).toBe(tenant.id);

    const reactivate = await setTenantStatus(tenant.id, "reactivate");
    expect(reactivate.success).toBe(true);
    expect(await getTenantContext("admin")).not.toBeNull();
  });

  it("suspension requires a reason", async () => {
    const tenant = await createTestTenant();
    const result = await setTenantStatus(tenant.id, "suspend", "  ");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason/i);
  });

  it("module configuration cannot disable both modules", async () => {
    const tenant = await createTestTenant();
    const result = await updateTenantModules(tenant.id, false, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/suspend/i);
  });

  it("module configuration changes persist and audit", async () => {
    const tenant = await createTestTenant({ momo: true, susu: true });
    const result = await updateTenantModules(tenant.id, true, false);
    expect(result.success).toBe(true);
    const updated = await prisma.businessTenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(updated.momoEnabled).toBe(true);
    expect(updated.susuEnabled).toBe(false);
    const audit = await prisma.platformAuditLog.findFirst({ where: { action: "tenant.modules_changed", tenantId: tenant.id } });
    expect(audit).not.toBeNull();
  });

  it("administrator recovery issues a one-time credential and forces a reset", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });

    const result = await resetTenantAdminAccess(tenant.id, admin.id);
    expect(result.success).toBe(true);
    const data = result.data as { temporaryPassword: string; adminEmail: string };
    expect(data.adminEmail).toBe(admin.email);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(updated.forcePasswordReset).toBe(true);
    expect(updated.tokenVersion).toBe(1); // old sessions invalidated
    expect(await bcrypt.compare(data.temporaryPassword, updated.passwordHash)).toBe(true);
    // The stored hash is never the plaintext.
    expect(updated.passwordHash).not.toBe(data.temporaryPassword);
  });
});
