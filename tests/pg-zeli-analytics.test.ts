import { beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  cleanDatabase,
  refId,
} from "./pg-setup";
import {
  buildAnalyticsSnapshot,
  refreshAnalyticsRange,
} from "@/lib/zeli/intelligence/metrics";
import { resolvePeriod } from "@/lib/zeli/intelligence/period";
import { evaluateZeliAccess } from "@/lib/zeli/entitlements";

const NOW = new Date("2026-11-15T12:00:00.000Z");

async function seed() {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PG-ZELI-${Date.now()}`,
      name: "PG Zeli Tenant",
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pg-zeli-${Date.now()}@test.local`,
      fullName: "PG Zeli Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `PG-C-${Date.now()}`,
      fullName: "PG Customer",
      status: "active",
      registeredAt: new Date("2026-11-02T10:00:00.000Z"),
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `PG-S-${Date.now()}`,
      customerId: customer.id,
      dailyContribution: 10,
      status: "active",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date("2026-11-01T00:00:00.000Z"),
      endDate: new Date("2026-11-30T00:00:00.000Z"),
      dailyContribution: 10,
      status: "active",
    },
  });
  await prisma.contribution.createMany({
    data: [
      {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 300,
        collectionDate: new Date("2026-11-06T09:00:00.000Z"),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: refId("PG-ZCON"),
      },
      {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 111,
        collectionDate: new Date("2026-11-07T09:00:00.000Z"),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: refId("PG-ZCON"),
        reversedAt: new Date("2026-11-08T09:00:00.000Z"),
      },
    ],
  });
  return { tenant, admin, customer, account, cycle };
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("PostgreSQL Zeli analytics", () => {
  it("reconciles aggregates and stays idempotent under concurrent refresh", async () => {
    const { tenant } = await seed();
    const period = resolvePeriod("this_month", { now: NOW });
    await Promise.all([
      refreshAnalyticsRange({ tenantId: tenant.id, scope: "all", range: period, force: true }),
      refreshAnalyticsRange({ tenantId: tenant.id, scope: "all", range: period, force: true }),
    ]);
    const rows = await prisma.zeliAnalyticsDaily.findMany({
      where: { tenantId: tenant.id, scope: "all" },
    });
    expect(new Set(rows.map((row) => row.businessDate)).size).toBe(rows.length);
    expect(rows.reduce((sum, row) => sum + Number(row.contributions), 0)).toBe(300);

    const snapshot = await buildAnalyticsSnapshot({
      tenant: { id: tenant.id, name: tenant.name, code: tenant.code },
      filters: { period: "this_month" },
      now: NOW,
      forceRefresh: true,
    });
    expect(snapshot.totals.contributions).toBe(300);
    expect(snapshot.totals.contributionCount).toBe(1);
    expect(snapshot.totals.netCashFlow).toBe(300);
  });

  it("persists and evaluates entitlement lifecycle in PostgreSQL", async () => {
    const { tenant } = await seed();
    const row = await prisma.zeliEntitlement.create({
      data: {
        tenantId: tenant.id,
        featureKey: "zeli_analytics",
        status: "active",
        source: "manual",
        reason: "PostgreSQL entitlement lifecycle test",
        expiresAt: new Date("2026-12-31T23:59:59.000Z"),
      },
    });
    expect(
      evaluateZeliAccess({
        role: "admin",
        entitlement: row,
        now: NOW,
      }).allowed
    ).toBe(true);
    await prisma.zeliEntitlement.update({
      where: { id: row.id },
      data: { status: "revoked", revokedAt: NOW },
    });
    const revoked = await prisma.zeliEntitlement.findUniqueOrThrow({ where: { id: row.id } });
    expect(
      evaluateZeliAccess({ role: "admin", entitlement: revoked, now: NOW }).reason
    ).toBe("revoked");
  });
});

describe("PostgreSQL Zeli commerce tables", () => {
  it("persists the catalogue, subscription and unique payment event", async () => {
    const { tenant } = await seed();
    const plan = await prisma.zeliPlan.create({
      data: {
        code: `pg-plan-${Date.now()}`,
        name: "PG Plan",
        billingInterval: "month",
        price: 149,
        currency: "GHS",
        status: "active",
        isPublic: true,
      },
    });
    const reference = refId("PG-ZSUB");
    const subscription = await prisma.zeliSubscription.create({
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
    const eventId = `pg-event-${Date.now()}`;
    await prisma.zeliPaymentEvent.create({
      data: {
        provider: "paystack",
        eventId,
        eventType: "charge.success",
        reference,
        subscriptionId: subscription.id,
        tenantId: tenant.id,
        decision: "processed",
      },
    });
    await expect(
      prisma.zeliPaymentEvent.create({
        data: {
          provider: "paystack",
          eventId,
          eventType: "charge.success",
          reference,
          subscriptionId: subscription.id,
          tenantId: tenant.id,
          decision: "processed",
        },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
