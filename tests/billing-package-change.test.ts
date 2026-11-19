import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
}));

import {
  cancelScheduledPlanChangeAction,
  getBillingOverview,
  schedulePlanChangeAction,
  selectPackageAction,
} from "@/lib/actions/billing.actions";
import { assignFoundingAllocation } from "@/lib/pricing/founding";

async function seedTenant(options: { locations?: number; staff?: number } = {}) {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Billing Test Business",
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `billing-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`,
      fullName: "Billing Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  for (let index = 0; index < (options.locations ?? 0); index += 1) {
    await prisma.location.create({
      data: { tenantId: tenant.id, name: `Location ${index}`, code: `LOC${index}`, status: "active" },
    });
  }
  for (let index = 0; index < (options.staff ?? 0); index += 1) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `staff-${tenant.id}-${index}@test.local`,
        fullName: `Staff ${index}`,
        role: "worker",
        status: "active",
        passwordHash: "not-used",
      },
    });
  }
  ctxHolder.current = {
    tenantId: tenant.id,
    tenantName: tenant.name,
    userId: admin.id,
    role: "admin",
    modules: ["momo", "susu"],
    momoEnabled: true,
    susuEnabled: true,
  };
  return { tenant, admin };
}

async function plan(overrides: Partial<Parameters<typeof prisma.zeliPlan.create>[0]["data"]> = {}) {
  return prisma.zeliPlan.create({
    data: {
      code: `plan-${Math.random().toString(36).slice(2, 8)}`,
      name: "Starter",
      billingInterval: "month",
      price: 99,
      currency: "GHS",
      foundingPrice: 79,
      usageAllowance: 250,
      locationLimit: 1,
      staffLimit: 3,
      supportLevel: "Standard support",
      status: "active",
      isPublic: true,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  ctxHolder.current = null;
});

describe("billing readiness for the authenticated workspace", () => {
  it("reports availability without exposing key mode or local guard details", async () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    await seedTenant();
    const overview = await getBillingOverview();
    expect(overview.paymentsAvailable).toBe(false);
    expect("liveReadiness" in overview).toBe(false);
    expect("providerMode" in overview).toBe(false);
    expect("localLiveTest" in overview).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("package selection before payment", () => {
  it("creates one pending_payment subscription and never charges", async () => {
    const { tenant } = await seedTenant();
    const starter = await plan({ code: "starter" });

    const result = await selectPackageAction({ planCode: starter.code });
    expect(result.ok).toBe(true);

    const subscriptions = await prisma.zeliSubscription.findMany({ where: { tenantId: tenant.id } });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].status).toBe("pending_payment");
    expect(Number(subscriptions[0].amount)).toBe(99);
    expect(subscriptions[0].paidAt).toBeNull();
    expect(result.subscriptionId).toBe(subscriptions[0].id);
  });

  it("uses the founding price only when the business holds an allocation", async () => {
    const { tenant } = await seedTenant();
    const starter = await plan({ code: "starter" });
    await assignFoundingAllocation({ tenantId: tenant.id, plan: starter, actorId: "platform-1" });

    await selectPackageAction({ planCode: "starter" });
    const subscription = await prisma.zeliSubscription.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(Number(subscription.amount)).toBe(79);
    expect(Number(subscription.standardAmount)).toBe(99);
    expect(subscription.foundingAllocationId).toBeTruthy();
  });

  it("asks before replacing a pending intent and keeps its reference intact", async () => {
    const { tenant } = await seedTenant();
    await plan({ code: "starter" });
    await plan({ code: "business", name: "Business", price: 169, foundingPrice: 149, locationLimit: 3, staffLimit: 10 });

    const first = await selectPackageAction({ planCode: "starter" });
    const guarded = await selectPackageAction({ planCode: "business" });

    expect(guarded.ok).toBe(false);
    expect(guarded.needsConfirmation).toBe(true);
    expect(guarded.existing?.reference).toBe(first.reference);
    const stillPending = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: first.subscriptionId! },
    });
    expect(stillPending.status).toBe("pending_payment");
    expect(await prisma.zeliSubscription.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it("expires the previous intent only after an explicit replacement confirmation", async () => {
    const { tenant } = await seedTenant();
    await plan({ code: "starter" });
    await plan({ code: "business", name: "Business", price: 169, foundingPrice: 149, locationLimit: 3, staffLimit: 10 });

    const first = await selectPackageAction({ planCode: "starter" });
    const replaced = await selectPackageAction({ planCode: "business", confirmReplace: true });
    expect(replaced.ok).toBe(true);

    const rows = await prisma.zeliSubscription.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    const expired = rows.find((row) => row.id === first.subscriptionId)!;
    expect(expired.status).toBe("expired");
    expect(expired.pendingKey).toBeNull();
    expect(expired.failureReason).toContain("Replaced by the owner");
    const current = rows.find((row) => row.id !== first.subscriptionId)!;
    expect(current.status).toBe("pending_payment");
    expect(Number(current.amount)).toBe(169);
    expect(current.providerReference).not.toBe(first.reference);
  });

  it("allows switching to annual billing and prices it from the catalogue", async () => {
    const { tenant } = await seedTenant();
    await plan({ code: "starter" });
    await plan({
      code: "starter-annual",
      name: "Starter Annual",
      billingInterval: "year",
      price: 1070,
      foundingPrice: null,
    });

    await selectPackageAction({ planCode: "starter-annual" });
    const subscription = await prisma.zeliSubscription.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(subscription.billingTerm).toBe("annual");
    expect(Number(subscription.amount)).toBe(1070);
    expect(subscription.foundingAllocationId).toBeNull();
  });
});

describe("package change on an active subscription", () => {
  async function activeSubscription(tenantId: string, planId: string) {
    return prisma.zeliSubscription.create({
      data: {
        tenantId,
        planId,
        status: "active",
        providerReference: `ZELI-${Math.random().toString(16).slice(2)}`,
        amount: 99,
        currency: "GHS",
        periodStart: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        periodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        paidAt: new Date(),
      },
    });
  }

  it("schedules the change for the next renewal without touching the paid period", async () => {
    const { tenant } = await seedTenant({ locations: 1, staff: 2 });
    const starter = await plan({ code: "starter" });
    const business = await plan({ code: "business", name: "Business", price: 169, locationLimit: 3, staffLimit: 10 });
    const subscription = await activeSubscription(tenant.id, starter.id);

    const result = await schedulePlanChangeAction({ planCode: business.code });
    expect(result.ok).toBe(true);

    const updated = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.scheduledPlanCode).toBe("business");
    expect(updated.scheduledBillingTerm).toBe("monthly");
    expect(updated.status).toBe("active");
    expect(Number(updated.amount)).toBe(99);
    expect(updated.periodEnd?.getTime()).toBe(subscription.periodEnd?.getTime());
  });

  it("reports the exact usage conflict and deletes nothing", async () => {
    const { tenant } = await seedTenant({ locations: 2, staff: 3 });
    const starter = await plan({ code: "starter" });
    const business = await plan({ code: "business", name: "Business", price: 169, locationLimit: 3, staffLimit: 10 });
    const subscription = await activeSubscription(tenant.id, business.id);

    const result = await schedulePlanChangeAction({ planCode: starter.code });
    expect(result.ok).toBe(false);
    expect(result.conflict).toEqual({
      planName: "Starter",
      locations: 2,
      locationLimit: 1,
      staff: 3,
      staffLimit: 3,
    });
    expect(result.error).toContain("2 active locations");
    expect(result.error).toContain("Nothing was deleted");

    expect(await prisma.location.count({ where: { tenantId: tenant.id } })).toBe(2);
    expect(await prisma.user.count({ where: { tenantId: tenant.id, role: "worker" } })).toBe(3);
    const unchanged = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(unchanged.scheduledPlanCode).toBeNull();
  });

  it("confirms that Business fits the two locations Starter cannot", async () => {
    const { tenant } = await seedTenant({ locations: 2, staff: 3 });
    const starter = await plan({ code: "starter" });
    const business = await plan({ code: "business", name: "Business", price: 169, locationLimit: 3, staffLimit: 10 });
    await activeSubscription(tenant.id, starter.id);

    const result = await schedulePlanChangeAction({ planCode: business.code });
    expect(result.ok).toBe(true);
  });

  it("cancels a scheduled change without changing the active package", async () => {
    const { tenant } = await seedTenant({ locations: 1 });
    const starter = await plan({ code: "starter" });
    const business = await plan({ code: "business", name: "Business", price: 169, locationLimit: 3, staffLimit: 10 });
    const subscription = await activeSubscription(tenant.id, starter.id);
    await schedulePlanChangeAction({ planCode: business.code });

    await cancelScheduledPlanChangeAction();
    const updated = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updated.scheduledPlanCode).toBeNull();
    expect(updated.planId).toBe(starter.id);
  });

  it("requires an active subscription to schedule anything", async () => {
    await seedTenant();
    await plan({ code: "business", name: "Business", price: 169 });
    const result = await schedulePlanChangeAction({ planCode: "business" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no active subscription");
  });
});

describe("billing overview", () => {
  it("shows no package as a neutral empty state and exposes the catalogue", async () => {
    await seedTenant({ locations: 2, staff: 3 });
    await plan({ code: "starter" });
    await plan({ code: "starter-annual", name: "Starter Annual", billingInterval: "year", price: 1070 });

    const overview = await getBillingOverview();
    expect(overview.lifecycle).toBe("ended");
    expect(overview.plan).toBeNull();
    expect(overview.availablePlans).toHaveLength(2);
    expect(overview.availablePlans.find((row) => row.code === "starter")?.foundingPrice).toBe(79);
    expect(overview.entitlements).toEqual({ locations: 2, staff: 3 });
    expect(overview.foundingEligible).toBe(false);
  });

  it("reports the scheduled change and its future price", async () => {
    const { tenant } = await seedTenant({ locations: 1 });
    const starter = await plan({ code: "starter" });
    const business = await plan({ code: "business", name: "Business", price: 169, locationLimit: 3, staffLimit: 10 });
    await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: starter.id,
        status: "active",
        providerReference: `ZELI-${Math.random().toString(16).slice(2)}`,
        amount: 99,
        currency: "GHS",
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        paidAt: new Date(),
      },
    });
    await schedulePlanChangeAction({ planCode: business.code });

    const overview = await getBillingOverview();
    expect(overview.scheduled?.planName).toBe("Business");
    expect(overview.scheduled?.price).toBe(169);
    expect(overview.scheduled?.billingTerm).toBe("monthly");
  });
});

describe("billing package selector", () => {
  it("maps the monthly/annual toggle to the catalogue's month/year intervals", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/app/admin/(workspace)/billing/BillingClient.tsx"),
      "utf8"
    );
    expect(source).toMatch(/term === "annual" \? "year" : "month"/);
    expect(source).not.toMatch(/billingInterval === term/);
  });
});
