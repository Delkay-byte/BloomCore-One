import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
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
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), {
      digest: `NEXT_REDIRECT;replace;${path};307;`,
    });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  getApiZeliAnalyticsContext,
  ZELI_ANALYTICS_FEATURE,
} from "@/lib/zeli/entitlements";
import { getZeliAnalyticsDashboard } from "@/lib/actions/zeli-analytics.actions";
import {
  getZeliTenantDetail,
  updateZeliEntitlement,
} from "@/lib/actions/zeli-platform.actions";
import { setPlatformSession } from "@/lib/platform-auth";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string }, role = "admin") {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Admin",
      role,
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function grant(tenantId: string, overrides: Record<string, unknown> = {}) {
  return prisma.zeliEntitlement.create({
    data: {
      tenantId,
      featureKey: ZELI_ANALYTICS_FEATURE,
      status: "active",
      source: "manual",
      reason: "Test entitlement",
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("server-side Zeli Analytics entitlement", () => {
  it("allows an entitled tenant administrator", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await grant(tenant.id);
    await setAdminSession(admin);
    const ctx = await getApiZeliAnalyticsContext();
    expect(ctx?.tenantId).toBe(tenant.id);
    expect(ctx?.role).toBe("admin");
  });

  it("denies no, expired, suspended and revoked entitlements", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });

    await setAdminSession(admin);
    expect(await getApiZeliAnalyticsContext()).toBeNull();

    const entitlement = await grant(tenant.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await getApiZeliAnalyticsContext()).toBeNull();
    await prisma.zeliEntitlement.update({
      where: { id: entitlement.id },
      data: { expiresAt: null, status: "suspended" },
    });
    expect(await getApiZeliAnalyticsContext()).toBeNull();
    await prisma.zeliEntitlement.update({
      where: { id: entitlement.id },
      data: { status: "revoked" },
    });
    expect(await getApiZeliAnalyticsContext()).toBeNull();
  });

  it("denies workers, collectors and customers by default", async () => {
    const tenant = await createTestTenant();
    await grant(tenant.id);
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "analytics-worker@test.local",
        fullName: "Analytics Worker",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        momoEnabled: true,
      },
    });
    await setAdminSession(worker, "worker");
    expect(await getApiZeliAnalyticsContext()).toBeNull();
  });

  it("redirects a page/action call when the entitlement is missing", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await setAdminSession(admin);
    await expect(
      getZeliAnalyticsDashboard({ period: "this_month" })
    ).rejects.toMatchObject({ digest: expect.stringContaining("zeli-analytics/upgrade") });
  });

  it("does not accept another tenant's location filter", async () => {
    const tenantA = await createTestTenant({ name: "Access Tenant A" });
    const tenantB = await createTestTenant({ name: "Access Tenant B" });
    const adminB = await createTestAdmin({ tenantId: tenantB.id });
    const locationA = await prisma.location.create({
      data: { tenantId: tenantA.id, code: "SCOPE-A", name: "Tenant A Branch", status: "active" },
    });
    await grant(tenantB.id);
    await setAdminSession(adminB);

    const result = await getZeliAnalyticsDashboard({
      period: "this_month",
      locationId: locationA.id,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Tenant A Branch");
  });

  it("prevents tenant users from calling platform entitlement management", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await setAdminSession(admin);
    await expect(
      updateZeliEntitlement({
        tenantId: tenant.id,
        action: "grant",
        reason: "Tenant admin must not grant this to itself",
      })
    ).rejects.toThrow("Not authenticated");
  });

  it("audits platform entitlement grant, suspension and revocation", async () => {
    vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "test-rate-limit-secret-for-zeli-tests");
    const tenant = await createTestTenant({ name: "Platform Zeli Tenant" });
    const platform = await prisma.platformSuperAdmin.create({
      data: {
        email: `platform-zeli-${Date.now()}@test.local`,
        fullName: "Platform Operator",
        passwordHash: "not-used",
        status: "active",
      },
    });
    await setPlatformSession({
      adminId: platform.id,
      email: platform.email,
      fullName: platform.fullName,
      tokenVersion: 0,
    });

    const granted = await updateZeliEntitlement({
      tenantId: tenant.id,
      action: "grant",
      reason: "Approved Zeli Analytics pilot for this business",
      expiresAt: "2027-12-31",
    });
    expect(granted.success).toBe(true);
    const entitlement = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: {
        tenantId_featureKey: {
          tenantId: tenant.id,
          featureKey: ZELI_ANALYTICS_FEATURE,
        },
      },
    });
    expect(entitlement.status).toBe("active");
    expect(entitlement.grantedById).toBe(platform.id);

    const missingReason = await updateZeliEntitlement({
      tenantId: tenant.id,
      action: "suspend",
      reason: "short",
    });
    expect(missingReason.success).toBe(false);

    const suspended = await updateZeliEntitlement({
      tenantId: tenant.id,
      action: "suspend",
      reason: "Payment review pending with the owner",
    });
    expect(suspended.success).toBe(true);

    const revoked = await updateZeliEntitlement({
      tenantId: tenant.id,
      action: "revoke",
      reason: "Pilot ended and the business requested removal",
    });
    expect(revoked.success).toBe(true);

    const detail = await getZeliTenantDetail(tenant.id);
    expect(detail?.entitlement?.status).toBe("revoked");
    expect(detail?.history.map((row) => row.action)).toEqual(
      expect.arrayContaining(["granted", "suspended", "revoked"])
    );
    for (const row of detail?.history ?? []) {
      expect(row.reason.length).toBeGreaterThanOrEqual(10);
      expect(row.actorType).toBe("platform");
    }

    const audits = await prisma.platformAuditLog.findMany({
      where: { tenantId: tenant.id },
    });
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "zeli.entitlement_grant",
        "zeli.entitlement_suspend",
        "zeli.entitlement_revoke",
      ])
    );
    expect(JSON.stringify(audits)).not.toContain("password");
    vi.unstubAllEnvs();
  });
});
