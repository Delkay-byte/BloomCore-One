import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));
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
  getZeliCommerceOverview,
  listZeliPlansForPlatform,
  upsertZeliPlan,
} from "@/lib/actions/zeli-commerce.actions";
import { setPlatformSession } from "@/lib/platform-auth";

async function platformSession() {
  const admin = await prisma.platformSuperAdmin.create({
    data: {
      email: `commerce-${Date.now()}@test.local`,
      fullName: "Commerce Admin",
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
}

const planInput = {
  code: "zeli-monthly",
  name: "Zeli Monthly",
  description: "Monthly analytics",
  billingInterval: "month",
  price: 149,
  currency: "GHS",
  features: ["Analytics", "Explanations"],
  usageAllowance: 40,
  trialDays: 0,
  status: "active",
  isPublic: true,
  reason: "Owner-approved price and package",
};

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
  vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "commerce-test-rate-limit-secret");
});

describe("platform Zeli commerce", () => {
  it("requires a platform session", async () => {
    await expect(upsertZeliPlan(planInput)).rejects.toThrow("Not authenticated");
  });

  it("creates a package from an approved price and writes an audit event", async () => {
    await platformSession();
    const result = await upsertZeliPlan(planInput);
    expect(result.success).toBe(true);
    const row = await prisma.zeliPlan.findUniqueOrThrow({ where: { code: "zeli-monthly" } });
    expect(Number(row.price)).toBe(149);
    expect(row.currency).toBe("GHS");
    expect(row.isPublic).toBe(true);
    const audit = await prisma.platformAuditLog.findFirst({
      where: { action: "zeli.plan_created" },
    });
    expect(audit?.reason).toBe(planInput.reason);
    const plans = await listZeliPlansForPlatform();
    expect(plans).toHaveLength(1);
  });

  it("rejects missing reason, invalid price and invalid currency", async () => {
    await platformSession();
    expect((await upsertZeliPlan({ ...planInput, reason: "short" })).success).toBe(false);
    expect((await upsertZeliPlan({ ...planInput, price: 0 })).success).toBe(false);
    expect((await upsertZeliPlan({ ...planInput, currency: "CEDIS" })).success).toBe(false);
  });

  it("does not seed a price or enable checkout by itself", async () => {
    await platformSession();
    const overview = await getZeliCommerceOverview();
    expect(overview.subscriptions.total).toBe(0);
    expect(overview.revenue.collected).toBe(0);
    await expect(prisma.zeliPlan.count()).resolves.toBe(0);
  });

  it("keeps tenant administrators out of platform commerce", async () => {
    const tenant = await createTestTenant();
    await createTestAdmin({ tenantId: tenant.id });
    await expect(listZeliPlansForPlatform()).rejects.toThrow("Not authenticated");
  });
});
