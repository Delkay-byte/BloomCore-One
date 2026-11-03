import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  buildAnalyticsSnapshot,
  refreshAnalyticsRange,
} from "@/lib/zeli/intelligence/metrics";
import { detectInsights, recommendationsFrom } from "@/lib/zeli/intelligence/insights";
import { resolvePeriod, PeriodValidationError } from "@/lib/zeli/intelligence/period";
import { evaluateZeliAccess, ZELI_ANALYTICS_FEATURE } from "@/lib/zeli/entitlements";

const NOW = new Date("2026-11-15T12:00:00.000Z");

async function seedFinancials() {
  const tenantA = await createTestTenant({ name: "Analytics Tenant A" });
  const tenantB = await createTestTenant({ name: "Analytics Tenant B" });
  const adminA = await createTestAdmin({ tenantId: tenantA.id });
  const adminB = await createTestAdmin({ tenantId: tenantB.id });

  const location = await prisma.location.create({
    data: {
      tenantId: tenantA.id,
      code: "ACC-01",
      name: "Accra Main",
      status: "active",
    },
  });
  await prisma.user.update({
    where: { id: adminA.id },
    data: { locationId: location.id },
  });

  const collectorUser = await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: "analytics-collector@test.local",
      fullName: "Analytics Collector",
      role: "collector",
      status: "active",
      passwordHash: "not-used",
      locationId: location.id,
      susuEnabled: true,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId: tenantA.id, userId: collectorUser.id, status: "active" },
  });

  const customer = await prisma.customer.create({
    data: {
      tenantId: tenantA.id,
      customerId: "BIK-C-AN-001",
      fullName: "Analytics Customer",
      phone: "+233200000001",
      status: "active",
      registeredAt: new Date("2026-11-03T10:00:00.000Z"),
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenantA.id,
      accountId: "BIK-S-AN-001",
      customerId: customer.id,
      dailyContribution: 10,
      status: "active",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenantA.id,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date("2026-11-01T00:00:00.000Z"),
      endDate: new Date("2026-11-30T23:59:59.000Z"),
      dailyContribution: 10,
      status: "active",
    },
  });

  await prisma.contribution.createMany({
    data: [
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 100,
        collectionDate: new Date("2026-11-05T09:00:00.000Z"),
        channel: "direct_office",
        recordedById: adminA.id,
        referenceId: "AN-CON-1",
      },
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 150,
        collectionDate: new Date("2026-11-12T09:00:00.000Z"),
        channel: "collector",
        collectorId: collector.id,
        recordedById: adminA.id,
        referenceId: "AN-CON-2",
      },
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 200,
        collectionDate: new Date("2026-10-10T09:00:00.000Z"),
        channel: "direct_office",
        recordedById: adminA.id,
        referenceId: "AN-CON-PREV",
      },
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 999,
        collectionDate: new Date("2026-11-08T09:00:00.000Z"),
        channel: "direct_office",
        recordedById: adminA.id,
        referenceId: "AN-CON-REVERSED",
        reversedAt: new Date("2026-11-09T09:00:00.000Z"),
      },
    ],
  });

  await prisma.withdrawal.createMany({
    data: [
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        requestedAmount: 50,
        commissionAmount: 0,
        netAmount: 50,
        remainingBalance: 0,
        status: "completed",
        authorizedById: adminA.id,
        referenceId: "AN-WDR-1",
        createdAt: new Date("2026-11-10T09:00:00.000Z"),
      },
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        requestedAmount: 40,
        commissionAmount: 0,
        netAmount: 40,
        remainingBalance: 0,
        status: "completed",
        authorizedById: adminA.id,
        referenceId: "AN-WDR-PREV",
        createdAt: new Date("2026-10-12T09:00:00.000Z"),
      },
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        requestedAmount: 999,
        commissionAmount: 0,
        netAmount: 999,
        remainingBalance: 0,
        status: "completed",
        authorizedById: adminA.id,
        referenceId: "AN-WDR-REVERSED",
        createdAt: new Date("2026-11-11T09:00:00.000Z"),
        reversedAt: new Date("2026-11-12T09:00:00.000Z"),
      },
      {
        tenantId: tenantA.id,
        accountId: account.id,
        cycleId: cycle.id,
        requestedAmount: 20,
        commissionAmount: 0,
        netAmount: 20,
        remainingBalance: 0,
        status: "pending",
        authorizedById: adminA.id,
        referenceId: "AN-WDR-PENDING",
        createdAt: new Date("2026-11-14T09:00:00.000Z"),
      },
    ],
  });

  await prisma.commission.create({
    data: {
      tenantId: tenantA.id,
      accountId: account.id,
      cycleId: cycle.id,
      amount: 5,
      basis: "one_day_contribution",
      triggeredBy: "first_withdrawal",
      recordedById: adminA.id,
      createdAt: new Date("2026-11-10T10:00:00.000Z"),
    },
  });

  await prisma.collectorRemittance.createMany({
    data: [
      {
        tenantId: tenantA.id,
        collectorId: collector.id,
        expectedAmount: 300,
        remittedAmount: 280,
        variance: 20,
        status: "discrepancy",
        recordedById: adminA.id,
        referenceId: "AN-REM-1",
        createdAt: new Date("2026-11-13T09:00:00.000Z"),
      },
      {
        tenantId: tenantA.id,
        collectorId: collector.id,
        expectedAmount: 10,
        remittedAmount: 10,
        variance: 0,
        status: "reconciled",
        recordedById: adminA.id,
        referenceId: "AN-REM-REVERSED",
        createdAt: new Date("2026-11-14T09:00:00.000Z"),
        reversedAt: new Date("2026-11-14T10:00:00.000Z"),
      },
    ],
  });

  const dailyAccount = await prisma.dailyAccount.create({
    data: {
      tenantId: tenantA.id,
      locationId: location.id,
      workerId: collectorUser.id,
      businessDate: new Date("2026-11-13T00:00:00.000Z"),
      commission: 7,
      otherIncome: 3,
      status: "submitted",
      submittedAt: new Date("2026-11-13T18:00:00.000Z"),
      expenses: {
        create: [
          {
            tenantId: tenantA.id,
            description: "Transport",
            amount: 10,
            createdAt: new Date("2026-11-13T12:00:00.000Z"),
          },
        ],
      },
    },
  });

  // Tenant B data must never appear in Tenant A results.
  await prisma.customer.create({
    data: {
      tenantId: tenantB.id,
      customerId: "BIK-C-AN-B",
      fullName: "Tenant B Customer",
      status: "active",
      registeredAt: new Date("2026-11-04T10:00:00.000Z"),
    },
  });

  return {
    tenantA,
    tenantB,
    adminA,
    adminB,
    location,
    collector,
    collectorUser,
    customer,
    account,
    cycle,
    dailyAccount,
  };
}

async function snapshotFor(tenant: { id: string; name: string; code: string }) {
  return buildAnalyticsSnapshot({
    tenant,
    filters: { period: "this_month" },
    now: NOW,
    forceRefresh: true,
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("Zeli analytics aggregation", () => {
  it("reconciles with authoritative records and excludes reversed rows", async () => {
    const { tenantA, adminA, collector, account, cycle, customer } = await seedFinancials();
    const snapshot = await snapshotFor(tenantA);

    expect(snapshot.totals.contributions).toBe(250);
    expect(snapshot.totals.contributionCount).toBe(2);
    expect(snapshot.totals.withdrawals).toBe(50);
    expect(snapshot.totals.withdrawalCount).toBe(1);
    expect(snapshot.totals.remittances).toBe(280);
    expect(snapshot.totals.remittanceVariance).toBe(20);
    expect(snapshot.totals.expenses).toBe(10);
    expect(snapshot.totals.cashIncome).toBe(10);
    expect(snapshot.totals.transactionCount).toBe(4);
    expect(snapshot.totals.netCashFlow).toBe(200);
    expect(snapshot.totals.activeAccounts).toBe(1);
    expect(snapshot.totals.newCustomers).toBe(1);

    // Independent direct queries must produce the same figures.
    const directContributions = await prisma.contribution.aggregate({
      where: {
        tenantId: tenantA.id,
        reversedAt: null,
        collectionDate: {
          gte: new Date("2026-11-01T00:00:00.000Z"),
          lt: new Date("2026-12-01T00:00:00.000Z"),
        },
      },
      _sum: { amount: true },
      _count: true,
    });
    expect(Number(directContributions._sum.amount)).toBe(snapshot.totals.contributions);
    expect(directContributions._count).toBe(snapshot.totals.contributionCount);

    const reversed = await prisma.contribution.findUniqueOrThrow({
      where: { referenceId: "AN-CON-REVERSED" },
    });
    expect(reversed.reversedAt).not.toBeNull();

    // The daily series must sum to the period totals.
    const seriesContributions = snapshot.series.reduce(
      (sum, point) => sum + point.contributions,
      0
    );
    expect(Math.round(seriesContributions * 100) / 100).toBe(250);
    expect(snapshot.previousTotals.contributions).toBe(200);
    expect(snapshot.previousTotals.withdrawals).toBe(40);

    // Record references remain discoverable for reconciliation.
    expect(account.customerId).toBe(customer.id);
    expect(cycle.accountId).toBe(account.id);
    expect(collector.tenantId).toBe(tenantA.id);
    expect(adminA.tenantId).toBe(tenantA.id);
  });

  it("isolates tenants and validates branch filters", async () => {
    const { tenantA, tenantB, location } = await seedFinancials();
    const snapshot = await snapshotFor(tenantA);
    const snapshotB = await snapshotFor(tenantB);
    expect(snapshotB.totals.contributions).toBe(0);
    expect(snapshot.totals.contributions).toBe(250);

    const branch = await buildAnalyticsSnapshot({
      tenant: tenantA,
      filters: { period: "this_month", locationId: location.id },
      now: NOW,
      forceRefresh: true,
    });
    expect(branch.filters.locationId).toBe(location.id);
    expect(branch.totals.contributions).toBe(250);
    expect(branch.totals.withdrawals).toBe(50);

    await expect(
      buildAnalyticsSnapshot({
        tenant: tenantA,
        filters: { period: "this_month", locationId: "location-from-another-tenant" },
        now: NOW,
      })
    ).rejects.toThrow("Location not found");
  });

  it("is idempotent across repeated refreshes", async () => {
    const { tenantA } = await seedFinancials();
    const period = resolvePeriod("this_month", { now: NOW });
    await refreshAnalyticsRange({
      tenantId: tenantA.id,
      scope: "all",
      range: period,
      force: true,
    });
    await refreshAnalyticsRange({
      tenantId: tenantA.id,
      scope: "all",
      range: period,
      force: true,
    });
    const rows = await prisma.zeliAnalyticsDaily.findMany({
      where: { tenantId: tenantA.id, scope: "all" },
    });
    const days = new Set(rows.map((row) => row.businessDate));
    expect(rows).toHaveLength(days.size);
    const total = rows.reduce((sum, row) => sum + Number(row.contributions), 0);
    expect(Math.round(total * 100) / 100).toBe(250);
  });

  it("detects remittance variance and pending review without claiming causation", async () => {
    const { tenantA } = await seedFinancials();
    const snapshot = await snapshotFor(tenantA);
    const insights = detectInsights(snapshot);
    const ids = insights.map((insight) => insight.id);
    expect(ids).toContain("remittance-variance");
    expect(ids).toContain("daily-accounts-awaiting-review");
    expect(ids).toContain("pending-withdrawals");
    for (const insight of insights) {
      expect(insight.period).toBeTruthy();
      expect(insight.metric).toBeTruthy();
      expect(insight.calculation).toBeTruthy();
      expect(insight.source).toBeTruthy();
      expect(insight.freshness).toBeTruthy();
      expect(insight.type).toBe("detected_pattern");
    }
    const recommendations = recommendationsFrom(insights);
    expect(recommendations.length).toBeGreaterThan(0);
    expect(
      recommendations.some((recommendation) =>
        /review|check|confirm|compare|open/i.test(recommendation.action)
      )
    ).toBe(true);
  });

  it("rejects invalid periods and future custom ranges", () => {
    expect(() => resolvePeriod("all_time", { now: NOW })).toThrow(PeriodValidationError);
    expect(() =>
      resolvePeriod("custom", { from: "2026-11-01", to: "2025-11-01", now: NOW })
    ).toThrow(PeriodValidationError);
    expect(() => resolvePeriod("custom", { from: "2026-01-01", to: "2026-12-31", now: NOW })).toThrow(
      PeriodValidationError
    );
  });
});

describe("Zeli entitlement matrix", () => {
  const base = {
    id: "ent-1",
    tenantId: "tenant-1",
    featureKey: ZELI_ANALYTICS_FEATURE,
    source: "manual",
    startsAt: new Date("2026-11-01T00:00:00.000Z"),
    expiresAt: null,
    suspendedAt: null,
    revokedAt: null,
  };

  it("allows only an active, unexpired tenant administrator", () => {
    expect(
      evaluateZeliAccess({
        role: "admin",
        entitlement: { ...base, status: "active" },
        now: NOW,
      }).allowed
    ).toBe(true);
    for (const role of ["worker", "collector", "customer"]) {
      expect(
        evaluateZeliAccess({
          role,
          entitlement: { ...base, status: "active" },
          now: NOW,
        }).reason
      ).toBe("role_not_permitted");
    }
  });

  it("denies missing, expired, suspended and revoked entitlements", () => {
    expect(
      evaluateZeliAccess({ role: "admin", entitlement: null, now: NOW }).reason
    ).toBe("no_entitlement");
    expect(
      evaluateZeliAccess({
        role: "admin",
        entitlement: { ...base, status: "active", expiresAt: new Date("2026-11-14T00:00:00Z") },
        now: NOW,
      }).reason
    ).toBe("expired");
    expect(
      evaluateZeliAccess({
        role: "admin",
        entitlement: { ...base, status: "suspended" },
        now: NOW,
      }).reason
    ).toBe("suspended");
    expect(
      evaluateZeliAccess({
        role: "admin",
        entitlement: { ...base, status: "revoked" },
        now: NOW,
      }).reason
    ).toBe("revoked");
  });
});
