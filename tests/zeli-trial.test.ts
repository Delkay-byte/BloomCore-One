import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import type { TenantContext } from "@/lib/tenant";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => {
    const tenant = await prisma.businessTenant.findFirstOrThrow();
    const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const ctx: TenantContext = {
      tenantId: tenant.id,
      tenantCode: tenant.code,
      tenantName: tenant.name,
      momoEnabled: true,
      susuEnabled: true,
      userId: admin.id,
      role: "admin",
      modules: ["momo", "susu"],
    };
    return ctx;
  },
}));

import { startZeliTrial } from "@/lib/actions/zeli-billing.actions";

async function trialPlan(trialDays = 7) {
  return prisma.zeliPlan.create({
    data: {
      code: `zeli-trial-${trialDays}`,
      name: "Zeli Trial",
      billingInterval: "month",
      price: 199,
      currency: "GHS",
      trialDays,
      status: "active",
      isPublic: true,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("owner-configured trial policy", () => {
  it("grants one audited trial with the configured duration", async () => {
    const tenant = await createTestTenant();
    await createTestAdmin({ tenantId: tenant.id });
    const plan = await trialPlan(7);
    const before = Date.now();
    const result = await startZeliTrial(plan.code);
    expect(result.success).toBe(true);

    const subscription = await prisma.zeliSubscription.findFirstOrThrow({
      where: { tenantId: tenant.id, provider: "trial" },
    });
    const days = (subscription.periodEnd!.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(subscription.amount.toString()).toBe("0");

    const entitlement = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: { tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" } },
    });
    expect(entitlement.source).toBe("trial");
    expect(entitlement.expiresAt?.getTime()).toBe(subscription.periodEnd?.getTime());
  });

  it("refuses a second trial for the same business", async () => {
    const tenant = await createTestTenant();
    await createTestAdmin({ tenantId: tenant.id });
    const plan = await trialPlan();
    expect((await startZeliTrial(plan.code)).success).toBe(true);
    const second = await startZeliTrial(plan.code);
    expect(second.success).toBe(false);
    expect(second.error).toContain("already been used");
    expect(
      await prisma.zeliSubscription.count({ where: { tenantId: tenant.id, provider: "trial" } })
    ).toBe(1);
  });

  it("refuses a package that does not publish a trial", async () => {
    const tenant = await createTestTenant();
    await createTestAdmin({ tenantId: tenant.id });
    const plan = await trialPlan(0);
    const result = await startZeliTrial(plan.code);
    expect(result.success).toBe(false);
    expect(
      await prisma.zeliSubscription.count({ where: { tenantId: tenant.id, provider: "trial" } })
    ).toBe(0);
  });

  it("refuses a trial while Zeli is globally unavailable", async () => {
    const tenant = await createTestTenant();
    await createTestAdmin({ tenantId: tenant.id });
    const plan = await trialPlan();
    await prisma.zeliAvailability.upsert({
      where: { id: "global" },
      create: { id: "global", enabled: false, reason: "maintenance" },
      update: { enabled: false, reason: "maintenance" },
    });
    const result = await startZeliTrial(plan.code);
    expect(result.success).toBe(false);
    expect(await prisma.zeliPaymentEvent.count()).toBe(0);
  });
});
