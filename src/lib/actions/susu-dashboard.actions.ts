"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu, requireTenantCollector } from "@/lib/tenant";

/**
 * Susu dashboard aggregates — all tenant scoped.
 *
 * Every aggregate carries tenantId in its where clause, so a business's
 * dashboard only ever reflects its own customers, collectors and money.
 */

export async function getSusuDashboardStats() {
  const ctx = await requireTenantAdminSusu();
  const tenantId = ctx.tenantId;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const todayContributions = await db.contribution.aggregate({
    where: { tenantId, collectionDate: { gte: today, lt: tomorrow } },
    _sum: { amount: true },
    _count: true,
  });

  const todayCollectorContributions = await db.contribution.aggregate({
    where: {
      tenantId,
      channel: "collector",
      collectionDate: { gte: today, lt: tomorrow },
    },
    _sum: { amount: true },
    _count: true,
  });

  const todayOfficeContributions = await db.contribution.aggregate({
    where: {
      tenantId,
      channel: "direct_office",
      collectionDate: { gte: today, lt: tomorrow },
    },
    _sum: { amount: true },
    _count: true,
  });

  const [
    activeCustomers,
    activeCollectors,
    todayWithdrawals,
    todayCommissions,
    todayCardFees,
    totalCustomers,
    paidTodayCustomers,
  ] = await Promise.all([
    db.customer.count({ where: { status: "active", tenantId } }),
    db.collector.count({ where: { status: "active", tenantId } }),
    db.withdrawal.aggregate({
      where: {
        tenantId,
        createdAt: { gte: today, lt: tomorrow },
        status: "completed",
      },
      _sum: { requestedAmount: true, commissionAmount: true, netAmount: true },
      _count: true,
    }),
    db.commission.aggregate({
      where: { tenantId, createdAt: { gte: today, lt: tomorrow } },
      _sum: { amount: true },
    }),
    db.cardFee.aggregate({ where: { tenantId }, _sum: { amount: true } }),
    db.customer.count({ where: { tenantId } }),
    db.contribution.findMany({
      where: { tenantId, collectionDate: { gte: today, lt: tomorrow } },
      select: { accountId: true },
      distinct: ["accountId"],
    }),
  ]);

  // Pending Money Handed In: SUM of max(Expected - Handed In, 0) per collector.
  const collectors = await db.collector.findMany({
    where: { status: "active", tenantId },
    select: { id: true },
  });

  let pendingMoneyHandedIn = 0;
  for (const collector of collectors) {
    const todayContribs = await db.contribution.findMany({
      where: {
        tenantId,
        collectorId: collector.id,
        channel: "collector",
        collectionDate: { gte: today, lt: tomorrow },
      },
      select: { amount: true },
    });
    const todayContributionsAmount = todayContribs.reduce(
      (sum, c) => sum + Number(c.amount),
      0
    );

    const todayRemittances = await db.collectorRemittance.findMany({
      where: {
        tenantId,
        collectorId: collector.id,
        createdAt: { gte: today, lt: tomorrow },
      },
      select: { remittedAmount: true },
    });
    const amountHandedInToday = todayRemittances.reduce(
      (sum, r) => sum + Number(r.remittedAmount),
      0
    );

    const difference = todayContributionsAmount - amountHandedInToday;
    if (difference > 0) pendingMoneyHandedIn += difference;
  }

  const outstandingToday = activeCustomers - paidTodayCustomers.length;

  return {
    activeCustomers,
    activeCollectors,
    totalCustomers,
    paidToday: paidTodayCustomers.length,
    outstandingToday,
    todayContributions: Number(todayContributions._sum.amount || 0),
    todayContributionCount: todayContributions._count,
    todayCollectorContributions: Number(
      todayCollectorContributions._sum.amount || 0
    ),
    todayCollectorContributionCount: todayCollectorContributions._count,
    todayOfficeContributions: Number(todayOfficeContributions._sum.amount || 0),
    todayOfficeContributionCount: todayOfficeContributions._count,
    todayWithdrawals: Number(todayWithdrawals._sum.requestedAmount || 0),
    todayWithdrawalCount: todayWithdrawals._count,
    todayCommission: Number(todayCommissions._sum.amount || 0),
    todayNetPaid: Number(todayWithdrawals._sum.netAmount || 0),
    totalCardFees: Number(todayCardFees._sum.amount || 0),
    pendingMoneyHandedIn: Math.max(0, pendingMoneyHandedIn),
    pendingRemittanceCount: 0,
  };
}

/**
 * Collector dashboard stats. The collector is resolved from the session and
 * every query is scoped to their tenant.
 */
export async function getCollectorDashboardStats(collectorUserId: string) {
  const ctx = await requireTenantCollector().catch(() => null);
  if (!ctx) return null;

  // The requested id must be the authenticated user.
  if (ctx.userId !== collectorUserId) return null;

  const collector = await db.collector.findFirst({
    where: { userId: ctx.userId, tenantId: ctx.tenantId, status: "active" },
    select: { id: true },
  });
  if (!collector) return null;

  const tenantId = ctx.tenantId;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const assignments = await db.collectorCustomerAssignment.findMany({
    where: { collectorId: collector.id, active: true, tenantId },
    include: {
      customer: true,
      account: {
        include: { cycles: { where: { status: "active" }, take: 1 } },
      },
    },
  });

  const todayCollectorContributions = await db.contribution.findMany({
    where: {
      tenantId,
      collectorId: collector.id,
      channel: "collector",
      collectionDate: { gte: today, lt: tomorrow },
    },
    include: { allocations: true },
    orderBy: { collectionDate: "desc" },
  });

  // "Collected today" must only reflect THIS collector's own assignments, so
  // it is scoped to the collector rather than the whole tenant.
  const todayAllContributions = await db.contribution.findMany({
    where: {
      tenantId,
      collectionDate: { gte: today, lt: tomorrow },
      account: {
        assignments: { some: { collectorId: collector.id, active: true } },
      },
    },
    include: { allocations: true },
    orderBy: { collectionDate: "desc" },
  });

  const todayByAccount = new Map<string, typeof todayAllContributions>();
  for (const c of todayAllContributions) {
    const existing = todayByAccount.get(c.accountId) || [];
    existing.push(c);
    todayByAccount.set(c.accountId, existing);
  }

  const toVisit: Array<{
    accountId: string;
    customerName: string;
    customerIdCode: string;
    dailyContribution: number;
    outstandingDays: number;
    expectedAmount: number;
  }> = [];

  const collectedToday: Array<{
    accountId: string;
    customerName: string;
    customerIdCode: string;
    amountCollected: number;
    daysCovered: number;
    collectedAt: string;
  }> = [];

  let totalCollectedToday = 0;

  for (const assignment of assignments) {
    const cycle = assignment.account.cycles[0];
    if (!cycle) continue;

    const todayContribs = todayByAccount.get(assignment.account.id);
    if (todayContribs && todayContribs.length > 0) {
      const latestContrib = todayContribs[0];
      const daysCovered = latestContrib.allocations.length;
      const amountCollected = todayContribs.reduce(
        (sum, c) => sum + Number(c.amount),
        0
      );
      totalCollectedToday += amountCollected;

      collectedToday.push({
        accountId: assignment.account.id,
        customerName: assignment.customer.fullName,
        customerIdCode: assignment.customer.customerId,
        amountCollected,
        daysCovered,
        collectedAt: latestContrib.collectionDate.toISOString(),
      });
    } else {
      const allocations = await db.contributionAllocation.findMany({
        where: { tenantId, contribution: { cycleId: cycle.id, reversedAt: null } },
      });
      const paidDays = new Set(allocations.map((a) => a.cycleDay));
      const outstandingDays: number[] = [];
      for (let d = 1; d <= 31; d++) {
        if (!paidDays.has(d)) outstandingDays.push(d);
      }

      if (outstandingDays.length > 0) {
        toVisit.push({
          accountId: assignment.account.id,
          customerName: assignment.customer.fullName,
          customerIdCode: assignment.customer.customerId,
          dailyContribution: Number(cycle.dailyContribution),
          outstandingDays: outstandingDays.length,
          expectedAmount:
            outstandingDays.length * Number(cycle.dailyContribution),
        });
      }
    }
  }

  const todayContributionsAmount = todayCollectorContributions.reduce(
    (sum, c) => sum + Number(c.amount),
    0
  );

  const todayRemittances = await db.collectorRemittance.findMany({
    where: {
      tenantId,
      collectorId: collector.id,
      createdAt: { gte: today, lt: tomorrow },
    },
  });
  const amountHandedInToday = todayRemittances.reduce(
    (sum, r) => sum + Number(r.remittedAmount),
    0
  );

  const expectedToBringIn = todayContributionsAmount;
  const difference = expectedToBringIn - amountHandedInToday;

  const recentRemittances = await db.collectorRemittance.findMany({
    where: { tenantId, collectorId: collector.id },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return {
    assignedCustomers: assignments.length,
    todayCollected: totalCollectedToday,
    todayCollectionCount: collectedToday.length,
    toVisit,
    collectedToday,
    recentRemittances: recentRemittances.map((r) => ({
      id: r.id,
      expectedAmount: Number(r.expectedAmount),
      remittedAmount: Number(r.remittedAmount),
      variance: Number(r.variance),
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    todayContributions: todayContributionsAmount,
    expectedToBringIn,
    amountHandedInToday,
    difference,
    customersCollected: collectedToday.length,
    customersRemaining: toVisit.length,
  };
}

/**
 * Collector breakdown for the admin dashboard, tenant scoped.
 */
export async function getAdminCollectorBreakdown() {
  const ctx = await requireTenantAdminSusu();
  const tenantId = ctx.tenantId;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const collectors = await db.collector.findMany({
    where: { status: "active", tenantId },
    include: { user: { select: { id: true, fullName: true } } },
  });

  return Promise.all(
    collectors.map(async (collector) => {
      const todayContributions = await db.contribution.findMany({
        where: {
          tenantId,
          collectorId: collector.id,
          channel: "collector",
          collectionDate: { gte: today, lt: tomorrow },
        },
        select: { amount: true },
      });

      const todayContributionsAmount = todayContributions.reduce(
        (sum, c) => sum + Number(c.amount),
        0
      );

      const todayRemittances = await db.collectorRemittance.findMany({
        where: {
          tenantId,
          collectorId: collector.id,
          createdAt: { gte: today, lt: tomorrow },
        },
        select: { remittedAmount: true },
      });
      const amountHandedInToday = todayRemittances.reduce(
        (sum, r) => sum + Number(r.remittedAmount),
        0
      );

      const expectedToBringIn = todayContributionsAmount;
      const difference = expectedToBringIn - amountHandedInToday;

      return {
        collectorId: collector.id,
        collectorName: collector.user.fullName,
        todayContributions: todayContributionsAmount,
        expectedToBringIn,
        amountHandedInToday,
        difference,
      };
    })
  );
}
