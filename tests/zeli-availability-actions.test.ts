import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({ mockCookieStore: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  getZeliAvailabilityAdminState,
  setZeliAvailability,
} from "@/lib/actions/zeli-availability.actions";
import { setZeliProviderMode } from "@/lib/actions/zeli-provider.actions";
import { setPlatformSession } from "@/lib/platform-auth";
import { handlePaystackWebhook } from "@/lib/payments/zeli-subscriptions";
import { getZeliAvailability } from "@/lib/zeli/availability";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function platformSession() {
  const admin = await prisma.platformSuperAdmin.create({
    data: {
      email: `availability-${Date.now()}@test.local`,
      fullName: "Availability Admin",
      passwordHash: "not-used",
      status: "active",
    },
  });
  await setPlatformSession({
    adminId: admin.id,
    email: admin.email,
    fullName: admin.fullName,
    tokenVersion: 0,
  });
  return admin;
}

async function tenantSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Tenant Admin",
      role: "admin",
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

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
  vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "availability-test-rate-limit-secret");
});

describe("Platform global Zeli availability control", () => {
  it("requires a platform session", async () => {
    await expect(
      setZeliAvailability({ enabled: false, reason: "Must not be allowed" })
    ).rejects.toThrow("Not authenticated");
  });

  it("rejects a tenant administrator", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await tenantSession(admin);
    await expect(
      setZeliAvailability({ enabled: false, reason: "Tenant must not control this" })
    ).rejects.toThrow("Not authenticated");
  });

  it("requires a reason and records previous/new state in the audit", async () => {
    const platform = await platformSession();
    const short = await setZeliAvailability({ enabled: false, reason: "short" });
    expect(short.success).toBe(false);

    const disabled = await setZeliAvailability({
      enabled: false,
      reason: "Emergency product maintenance window",
    });
    expect(disabled.success).toBe(true);
    expect((await getZeliAvailability()).enabled).toBe(false);

    const audit = await prisma.platformAuditLog.findFirst({
      where: { action: "zeli.availability_disabled" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.actorId).toBe(platform.id);
    expect(audit?.reason).toBe("Emergency product maintenance window");
    const details = JSON.parse(audit?.details ?? "{}");
    expect(details.previousValue).toBe(true);
    expect(details.newValue).toBe(false);
    expect(details.timestamp).toBeTruthy();

    const enabled = await setZeliAvailability({
      enabled: true,
      reason: "Maintenance complete and verified",
    });
    expect(enabled.success).toBe(true);
    expect((await getZeliAvailability()).enabled).toBe(true);
    const state = await getZeliAvailabilityAdminState();
    expect(state.updatedByName).toBe("Availability Admin");
  });

  it("keeps external-AI controls available while entire Zeli is OFF", async () => {
    await platformSession();
    await setZeliAvailability({
      enabled: false,
      reason: "Entire product maintenance window",
    });
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    const provider = await setZeliProviderMode({
      mode: "synthetic",
      reason: "Independent provider control test",
    });
    expect(provider.success).toBe(true);
    expect((await getZeliAvailability()).enabled).toBe(false);
  });

  it("does not block Paystack webhook/entitlement lifecycle", async () => {
    const tenant = await createTestTenant();
    const plan = await prisma.zeliPlan.create({
      data: {
        code: `availability-plan-${Date.now()}`,
        name: "Availability Plan",
        billingInterval: "month",
        price: 50,
        currency: "GHS",
        status: "active",
        isPublic: true,
      },
    });
    const reference = `ZELI-AVAIL-${Date.now()}`;
    await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "pending",
        provider: "paystack",
        providerReference: reference,
        amount: plan.price,
        currency: "GHS",
      },
    });
    await platformSession();
    await setZeliAvailability({
      enabled: false,
      reason: "Product unavailable while payments continue",
    });
    const secret = "sk_test_availability";
    vi.stubEnv("PAYSTACK_SECRET_KEY", secret);
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 991122,
        reference,
        status: "success",
        amount: 5000,
        currency: "GHS",
        paid_at: "2026-11-03T20:00:00.000Z",
      },
    });
    const signature = createHmac("sha512", secret).update(raw).digest("hex");
    const result = await handlePaystackWebhook(raw, signature);
    expect(result.decision).toBe("processed");
    const entitlement = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: { tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" } },
    });
    expect(entitlement.status).toBe("active");
    expect((await getZeliAvailability()).enabled).toBe(false);
  });
});
