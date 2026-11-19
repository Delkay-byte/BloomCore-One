import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import {
  assignFoundingAllocation,
  consumeFoundingPeriod,
  effectiveMonthlyPrice,
  foundingAvailability,
  foundingRemaining,
  FOUNDING_MAX_BUSINESSES,
} from "@/lib/pricing/founding";
import { runBillingLifecycle } from "@/lib/billing/lifecycle";
import { consumeZeliQuota, zeliUsageSummary, ZeliAccessError } from "@/lib/zeli/usage";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { checkPackageLimit } from "@/lib/pricing/limits";
import { db } from "@/lib/db";

async function plan(overrides: Partial<Parameters<typeof prisma.zeliPlan.create>[0]["data"]> = {}) {
  return prisma.zeliPlan.create({
    data: {
      code: `plan-${Math.random().toString(36).slice(2, 9)}`,
      name: "Business",
      billingInterval: "month",
      price: 169,
      currency: "GHS",
      foundingPrice: 149,
      usageAllowance: 10,
      status: "active",
      isPublic: true,
      ...overrides,
    },
  });
}

async function tenant(name = "Synthetic Business") {
  return prisma.businessTenant.create({
    data: {
      code: `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
}

async function admin(tenantId: string, email = `admin-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`) {
  return prisma.user.create({
    data: {
      tenantId,
      email,
      fullName: "Billing Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("founding allocation", () => {
  it("caps five businesses and never grants a sixth slot", async () => {
    const p = await plan();
    const results = [];
    for (let index = 0; index < FOUNDING_MAX_BUSINESSES + 1; index += 1) {
      const t = await tenant(`Founding ${index}`);
      results.push(await assignFoundingAllocation({ tenantId: t.id, plan: p, actorId: "platform-1" }));
    }
    expect(results.filter((row) => row.ok)).toHaveLength(FOUNDING_MAX_BUSINESSES);
    expect(results[results.length - 1]).toEqual({ ok: false, reason: "capacity_reached" });
    const slots = await prisma.foundingAllocation.findMany({ orderBy: { slot: "asc" } });
    expect(slots.map((row) => row.slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports the slot that is actually free and zero remaining after the fifth allocation", async () => {
    const p = await plan();
    for (let index = 0; index < FOUNDING_MAX_BUSINESSES - 1; index += 1) {
      const t = await tenant(`Early ${index}`);
      expect(await assignFoundingAllocation({ tenantId: t.id, plan: p, actorId: "platform-1" })).toMatchObject({ ok: true });
    }
    expect(await foundingAvailability()).toEqual({
      capacity: FOUNDING_MAX_BUSINESSES,
      allocated: 4,
      remaining: 1,
      available: true,
    });

    const last = await tenant("Last Slot");
    expect(await assignFoundingAllocation({ tenantId: last.id, plan: p, actorId: "platform-1" })).toMatchObject({ ok: true });
    expect(await foundingAvailability()).toEqual({
      capacity: FOUNDING_MAX_BUSINESSES,
      allocated: 5,
      remaining: 0,
      available: false,
    });
  });

  it("lets only one business claim the final slot when two requests race", async () => {
    const p = await plan();
    for (let index = 0; index < FOUNDING_MAX_BUSINESSES - 1; index += 1) {
      const t = await tenant(`Filled ${index}`);
      await assignFoundingAllocation({ tenantId: t.id, plan: p, actorId: "platform-1" });
    }
    const [a, b] = await Promise.all([tenant("Racer A"), tenant("Racer B")]);
    const results = await Promise.all([
      assignFoundingAllocation({ tenantId: a.id, plan: p, actorId: "platform-1" }),
      assignFoundingAllocation({ tenantId: b.id, plan: p, actorId: "platform-1" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ reason: "capacity_reached" });
    const rows = await prisma.foundingAllocation.findMany({ orderBy: { slot: "asc" } });
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.slot)).size).toBe(5);
  });

  it("keeps an existing founding price and consumed periods after all five slots are allocated", async () => {
    const p = await plan();
    const existing = await tenant("Existing Founding");
    const assignment = await assignFoundingAllocation({ tenantId: existing.id, plan: p, actorId: "platform-1" });
    await db.$transaction((tx) => consumeFoundingPeriod(tx, (assignment as { allocationId: string }).allocationId));
    for (let index = 0; index < FOUNDING_MAX_BUSINESSES - 1; index += 1) {
      const t = await tenant(`Later ${index}`);
      await assignFoundingAllocation({ tenantId: t.id, plan: p, actorId: "platform-1" });
    }

    expect((await foundingAvailability()).available).toBe(false);
    const fee = await effectiveMonthlyPrice({ tenantId: existing.id, plan: p });
    expect(fee.source).toBe("founding");
    expect(Number(fee.amount)).toBe(149);
    expect(fee.remainingPeriods).toBe(2);
    const row = await prisma.foundingAllocation.findUniqueOrThrow({ where: { tenantId: existing.id } });
    expect(row.periodsUsed).toBe(1);
    expect(row.status).toBe("active");
  });

  it("grants three discounted monthly periods, then the standard price", async () => {
    const p = await plan();
    const t = await tenant();
    const assignment = await assignFoundingAllocation({ tenantId: t.id, plan: p, actorId: "platform-1" });
    expect(assignment.ok).toBe(true);

    const fee = await effectiveMonthlyPrice({ tenantId: t.id, plan: p });
    expect(Number(fee.amount)).toBe(149);
    expect(fee.source).toBe("founding");
    expect(fee.remainingPeriods).toBe(3);

    for (let period = 0; period < 3; period += 1) {
      await db.$transaction((tx) => consumeFoundingPeriod(tx, (assignment as { allocationId: string }).allocationId));
    }
    const after = await prisma.foundingAllocation.findUnique({ where: { tenantId: t.id } });
    expect(after?.periodsUsed).toBe(3);
    expect(after?.status).toBe("exhausted");
    expect(foundingRemaining(after!)).toBe(0);

    const standard = await effectiveMonthlyPrice({ tenantId: t.id, plan: p });
    expect(Number(standard.amount)).toBe(169);
    expect(standard.source).toBe("standard");
  });

  it("never applies the founding price to annual billing or a different package", async () => {
    const monthly = await plan();
    const annual = await plan({ billingInterval: "year", price: 1825, foundingPrice: null });
    const other = await plan({ price: 339, foundingPrice: 225 });
    const t = await tenant();
    await assignFoundingAllocation({ tenantId: t.id, plan: monthly, actorId: "platform-1" });

    const annualFee = await effectiveMonthlyPrice({ tenantId: t.id, plan: annual });
    expect(annualFee.source).toBe("standard");
    expect(Number(annualFee.amount)).toBe(1825);

    const otherFee = await effectiveMonthlyPrice({ tenantId: t.id, plan: other });
    expect(otherFee.source).toBe("standard");
    expect(Number(otherFee.amount)).toBe(339);
  });

  it("does not reset consumed periods when a revoked allocation is re-issued", async () => {
    const p = await plan();
    const t = await tenant();
    const first = await assignFoundingAllocation({ tenantId: t.id, plan: p, actorId: "platform-1" });
    await db.$transaction((tx) => consumeFoundingPeriod(tx, (first as { allocationId: string }).allocationId));
    await prisma.foundingAllocation.update({
      where: { tenantId: t.id },
      data: { status: "revoked", revokedAt: new Date() },
    });
    const again = await assignFoundingAllocation({ tenantId: t.id, plan: p, actorId: "platform-2" });
    expect(again.ok).toBe(true);
    const row = await prisma.foundingAllocation.findUnique({ where: { tenantId: t.id } });
    expect(row?.periodsUsed).toBe(1);
    expect(foundingRemaining(row!)).toBe(2);
  });
});

describe("subscription lifecycle", () => {
  async function activeSubscription(options: { periodEnd?: Date; graceEndsAt?: Date | null } = {}) {
    const p = await plan();
    const t = await tenant();
    await admin(t.id);
    const subscription = await prisma.zeliSubscription.create({
      data: {
        tenantId: t.id,
        planId: p.id,
        status: "active",
        providerReference: `ZELI-${t.id.slice(0, 6)}-${Math.random().toString(16).slice(2)}`,
        amount: 169,
        currency: "GHS",
        periodStart: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        periodEnd: options.periodEnd ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        paidAt: new Date(),
        graceEndsAt: options.graceEndsAt ?? null,
      },
    });
    return { tenant: t, subscription, plan: p };
  }

  it("sends the seven-day reminder once, then enters grace and suspends", async () => {
    const { tenant: t, subscription } = await activeSubscription({
      periodEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const first = await runBillingLifecycle();
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const reminder = await prisma.tenantNotification.findFirst({
      where: { tenantId: t.id, dedupeKey: { contains: "renewal" } },
    });
    expect(reminder?.title).toContain("renews in 7 days");

    await runBillingLifecycle();
    expect(await prisma.tenantNotification.count({ where: { tenantId: t.id } })).toBe(1);

    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { periodEnd: new Date(Date.now() - 60_000) },
    });
    const grace = await runBillingLifecycle();
    expect(grace.graced).toBe(1);
    const inGrace = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(inGrace.status).toBe("grace_period");
    expect(inGrace.graceEndsAt).toBeTruthy();

    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { graceEndsAt: new Date(Date.now() - 60_000) },
    });
    const suspended = await runBillingLifecycle();
    expect(suspended.suspended).toBe(1);
    const final = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(final.status).toBe("suspended");
  });

  it("restores access when a verified payment already covers the current period", async () => {
    const { subscription } = await activeSubscription();
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { status: "suspended", periodEnd: new Date(Date.now() - 60_000) },
    });
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { periodEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) },
    });
    const result = await runBillingLifecycle();
    expect(result.reactivated).toBe(1);
    const row = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.status).toBe("active");
  });
});

describe("Zeli monthly allowance", () => {
  async function subscribed(usageAllowance: number, status = "active") {
    const p = await plan({ usageAllowance });
    const t = await tenant();
    await prisma.zeliSubscription.create({
      data: {
        tenantId: t.id,
        planId: p.id,
        status,
        providerReference: `ZELI-${Math.random().toString(16).slice(2)}`,
        amount: 169,
        currency: "GHS",
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        paidAt: status === "active" ? new Date() : null,
      },
    });
    return t;
  }

  it("consumes exactly the included requests and then refuses", async () => {
    const t = await subscribed(3);
    expect((await consumeZeliQuota(t.id)).remaining).toBe(2);
    expect((await consumeZeliQuota(t.id)).remaining).toBe(1);
    expect((await consumeZeliQuota(t.id)).remaining).toBe(0);
    await expect(consumeZeliQuota(t.id)).rejects.toBeInstanceOf(ZeliAccessError);

    const summary = await zeliUsageSummary(t.id);
    expect(summary.used).toBe(3);
    expect(summary.limit).toBe(3);
    expect(summary.blocked).toBeNull();
  });

  it("cannot be exceeded by concurrent requests", async () => {
    const t = await subscribed(5);
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeZeliQuota(t.id).then(() => true).catch(() => false)));
    expect(results.filter(Boolean)).toHaveLength(5);
    const row = await prisma.zeliUsagePeriod.findFirst({ where: { tenantId: t.id } });
    expect(row?.requests).toBe(5);
  });

  it("refuses unpaid and suspended subscriptions", async () => {
    const pending = await subscribed(50, "pending_payment");
    await expect(consumeZeliQuota(pending.id)).rejects.toMatchObject({ code: "payment_required" });

    const suspended = await subscribed(50, "suspended");
    await expect(consumeZeliQuota(suspended.id)).rejects.toMatchObject({ code: "subscription_suspended" });

    const summary = await zeliUsageSummary(suspended.id);
    expect(summary.blocked?.code).toBe("subscription_suspended");
  });
});

describe("controlled provisioning", () => {
  it("creates a pending-payment tenant, first admin, plan and founding slot without charging", async () => {
    const p = await plan({ code: "starter", price: 99, foundingPrice: 79 });
    const enquiry = await prisma.accountEnquiry.create({
      data: {
        businessName: "Provisioned Business",
        contactName: "Owner Name",
        phone: "0244000000",
        email: "owner@example.com",
        status: "qualified",
      },
    });

    const result = await provisionBusiness({
      name: "Provisioned Business",
      momoEnabled: true,
      susuEnabled: true,
      adminFullName: "Owner Name",
      adminEmail: "owner@example.com",
      planCode: p.code,
      foundingOptIn: true,
      enquiryId: enquiry.id,
      actorId: "platform-1",
      actorEmail: "platform@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toBe(79);
    expect(result.standardAmount).toBe(99);
    expect(result.foundingSlot).toBe(1);

    const t = await prisma.businessTenant.findUniqueOrThrow({ where: { id: result.tenantId } });
    expect(t.status).toBe("PENDING_PAYMENT");
    expect(t.primaryAdminUserId).toBeTruthy();

    const sub = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: result.subscriptionId } });
    expect(sub.status).toBe("pending_payment");
    expect(Number(sub.amount)).toBe(79);
    expect(sub.foundingAllocationId).toBeTruthy();
    expect(sub.paidAt).toBeNull();

    const updatedEnquiry = await prisma.accountEnquiry.findUniqueOrThrow({ where: { id: enquiry.id } });
    expect(updatedEnquiry.status).toBe("provisioned");
    expect(updatedEnquiry.tenantId).toBe(result.tenantId);
    expect(updatedEnquiry.assignedPlanCode).toBe("starter");

    const allocation = await prisma.foundingAllocation.findUniqueOrThrow({ where: { tenantId: result.tenantId } });
    expect(allocation.slot).toBe(1);
    expect(allocation.periodsUsed).toBe(0);
  });

  it("refuses a duplicate administrator e-mail without leaving partial records", async () => {
    const p = await plan({ code: "business" });
    await admin(await tenant().then((t) => t.id), "owner@example.com");
    const before = await prisma.businessTenant.count();
    const result = await provisionBusiness({
      name: "Another Business",
      momoEnabled: true,
      susuEnabled: false,
      adminFullName: "Owner",
      adminEmail: "owner@example.com",
      planCode: p.code,
      foundingOptIn: false,
      actorId: "platform-1",
      actorEmail: "platform@example.com",
    });
    expect(result.ok).toBe(false);
    expect(await prisma.businessTenant.count()).toBe(before);
  });
});

describe("package limits", () => {
  async function tenantWithPlan(locationLimit: number, staffLimit: number, status = "active") {
    const p = await plan({ locationLimit, staffLimit });
    const t = await tenant();
    await prisma.zeliSubscription.create({
      data: {
        tenantId: t.id,
        planId: p.id,
        status,
        providerReference: `ZELI-${Math.random().toString(16).slice(2)}`,
        amount: 169,
        currency: "GHS",
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        paidAt: status === "active" ? new Date() : null,
      },
    });
    return t;
  }

  it("blocks a location beyond the package allowance", async () => {
    const t = await tenantWithPlan(1, 3);
    await prisma.location.create({
      data: { tenantId: t.id, name: "Main", code: "MAIN", status: "active" },
    });
    const check = await checkPackageLimit(t.id, "locations");
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("limit_reached");
    expect(check.message).toContain("1 active location");
  });

  it("blocks staff beyond the package allowance and honours inactive records", async () => {
    const t = await tenantWithPlan(2, 1);
    await admin(t.id, "worker-a@test.local").then((u) =>
      prisma.user.update({ where: { id: u.id }, data: { role: "worker" } })
    );
    expect((await checkPackageLimit(t.id, "staff")).allowed).toBe(false);

    await prisma.user.updateMany({ where: { tenantId: t.id }, data: { status: "inactive" } });
    expect((await checkPackageLimit(t.id, "staff")).allowed).toBe(true);
  });

  it("refuses every create for a suspended business", async () => {
    const t = await tenantWithPlan(3, 3, "suspended");
    const check = await checkPackageLimit(t.id, "staff");
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("subscription_suspended");
  });

  it("never limits a grandfathered tenant without a subscription", async () => {
    const t = await tenant();
    const check = await checkPackageLimit(t.id, "locations");
    expect(check.allowed).toBe(true);
    expect(check.limit).toBeNull();
  });
});
