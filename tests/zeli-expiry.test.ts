import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase, createTestTenant } from "./setup";
import { expireZeliLifecycle } from "@/lib/zeli/expiry";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function seedPlan(code = "zeli-monthly") {
  return prisma.zeliPlan.create({
    data: {
      code,
      name: "Zeli Monthly",
      billingInterval: "month",
      price: 199,
      currency: "GHS",
      features: JSON.stringify(["Analytics"]),
      status: "active",
      isPublic: true,
    },
  });
}

async function seedEntitlement(
  tenantId: string,
  overrides: {
    status?: string;
    source?: string;
    startsAt?: Date;
    expiresAt?: Date | null;
  } = {}
) {
  return prisma.zeliEntitlement.create({
    data: {
      tenantId,
      featureKey: "zeli_analytics",
      status: overrides.status ?? "active",
      source: overrides.source ?? "subscription",
      startsAt: overrides.startsAt ?? new Date(Date.now() - 30 * DAY),
      expiresAt:
        overrides.expiresAt === undefined
          ? new Date(Date.now() - HOUR)
          : overrides.expiresAt,
    },
  });
}

async function seedSubscription(
  tenantId: string,
  planId: string,
  overrides: {
    status?: string;
    periodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    pendingKey?: string | null;
    providerReference?: string;
  } = {}
) {
  return prisma.zeliSubscription.create({
    data: {
      tenantId,
      planId,
      status: overrides.status ?? "active",
      provider: "paystack",
      providerReference:
        overrides.providerReference ??
        `ZELI-EXPIRY-${Math.random().toString(36).slice(2, 12)}`,
      amount: 199,
      currency: "GHS",
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd:
        overrides.periodEnd === undefined
          ? new Date(Date.now() - HOUR)
          : overrides.periodEnd,
      cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
      pendingKey: overrides.pendingKey ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("Zeli lifecycle expiry sweep", () => {
  it("expires an active entitlement past its expiry and records system history", async () => {
    const tenant = await createTestTenant();
    const expiresAt = new Date(Date.now() - 2 * HOUR);
    const entitlement = await seedEntitlement(tenant.id, { expiresAt });

    const result = await expireZeliLifecycle();

    expect(result).toEqual({ subscriptions: 0, entitlements: 1, skipped: 0 });

    const after = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.status).toBe("expired");

    const events = await prisma.zeliEntitlementEvent.findMany({
      where: { entitlementId: entitlement.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenant.id,
      featureKey: "zeli_analytics",
      action: "expired",
      previousStatus: "active",
      status: "expired",
      actorType: "system",
    });
    expect(events[0].reason).toContain(expiresAt.toISOString());
  });

  it("is idempotent: a repeated run changes no rows and adds no events", async () => {
    const tenant = await createTestTenant();
    const plan = await seedPlan();
    await seedEntitlement(tenant.id, {
      expiresAt: new Date(Date.now() - HOUR),
    });
    await seedSubscription(tenant.id, plan.id, {
      periodEnd: new Date(Date.now() - HOUR),
    });

    const first = await expireZeliLifecycle();
    expect(first).toEqual({ subscriptions: 1, entitlements: 1, skipped: 0 });
    const eventCount = await prisma.zeliEntitlementEvent.count();

    const second = await expireZeliLifecycle();
    expect(second).toEqual({ subscriptions: 0, entitlements: 0, skipped: 0 });
    expect(await prisma.zeliEntitlementEvent.count()).toBe(eventCount);
  });

  it("does not expire an entitlement renewed before the sweep", async () => {
    const tenant = await createTestTenant();
    const future = new Date(Date.now() + 10 * DAY);
    const entitlement = await seedEntitlement(tenant.id, { expiresAt: future });

    const result = await expireZeliLifecycle();

    expect(result.entitlements).toBe(0);
    const after = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.status).toBe("active");
    expect(after.expiresAt?.toISOString()).toBe(future.toISOString());
    expect(await prisma.zeliEntitlementEvent.count()).toBe(0);
  });

  it("a subscription renewal that extended periodEnd wins the sweep", async () => {
    const tenant = await createTestTenant();
    const plan = await seedPlan();
    const now = new Date();
    const subscription = await seedSubscription(tenant.id, plan.id, {
      periodEnd: new Date(now.getTime() - HOUR),
    });

    // Renewal lands before the sweep uses its stale candidate snapshot.
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { periodEnd: new Date(now.getTime() + 30 * DAY), status: "active" },
    });

    const result = await expireZeliLifecycle(now);

    expect(result.subscriptions).toBe(0);
    const after = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(after.status).toBe("active");
  });

  it("catches an entitlement that expired days ago when a run was missed", async () => {
    const tenant = await createTestTenant();
    const expiresAt = new Date(Date.now() - 5 * DAY);
    const entitlement = await seedEntitlement(tenant.id, { expiresAt });

    const result = await expireZeliLifecycle();

    expect(result.entitlements).toBe(1);
    const after = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    expect(after.status).toBe("expired");
    const events = await prisma.zeliEntitlementEvent.findMany({
      where: { entitlementId: entitlement.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain(expiresAt.toISOString());
  });

  it("marks a cancelled subscription cancelled at period end, otherwise expired", async () => {
    const tenant = await createTestTenant();
    const plan = await seedPlan();
    const cancelled = await seedSubscription(tenant.id, plan.id, {
      cancelAtPeriodEnd: true,
      periodEnd: new Date(Date.now() - HOUR),
      pendingKey: "stale-pending-key",
    });
    const lapsed = await seedSubscription(tenant.id, plan.id, {
      cancelAtPeriodEnd: false,
      periodEnd: new Date(Date.now() - HOUR),
    });
    const stillActive = await seedSubscription(tenant.id, plan.id, {
      periodEnd: new Date(Date.now() + 5 * DAY),
    });

    const result = await expireZeliLifecycle();

    expect(result.subscriptions).toBe(2);
    const cancelledAfter = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: cancelled.id },
    });
    expect(cancelledAfter.status).toBe("cancelled");
    expect(cancelledAfter.pendingKey).toBeNull();
    const lapsedAfter = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: lapsed.id },
    });
    expect(lapsedAfter.status).toBe("expired");
    const activeAfter = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: stillActive.id },
    });
    expect(activeAfter.status).toBe("active");
  });

  it("never expires a manual entitlement without an expiry date", async () => {
    const tenant = await createTestTenant();
    const manual = await seedEntitlement(tenant.id, {
      source: "manual",
      expiresAt: null,
    });

    const result = await expireZeliLifecycle();

    expect(result.entitlements).toBe(0);
    const after = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: { id: manual.id },
    });
    expect(after.status).toBe("active");
    expect(after.expiresAt).toBeNull();
    expect(await prisma.zeliEntitlementEvent.count()).toBe(0);
  });
});
