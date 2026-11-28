import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, prisma } from "./setup";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { redirectPathFromError } from "@/lib/errors";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function tenant(status: "ACTIVE" | "PENDING_PAYMENT" | "SUSPENDED" = "ACTIVE") {
  return prisma.businessTenant.create({
    data: {
      code: `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Synthetic Access Business",
      status,
      onboardingStatus: "COMPLETED",
    },
  });
}

async function plan() {
  return prisma.zeliPlan.create({
    data: {
      code: `access-${Math.random().toString(36).slice(2, 9)}`,
      name: "Access Plan",
      billingInterval: "month",
      price: 169,
      currency: "GHS",
      usageAllowance: 10,
      status: "active",
      isPublic: true,
    },
  });
}

async function subscription(
  tenantId: string,
  planId: string,
  overrides: {
    status: string;
    periodEnd?: Date | null;
    graceEndsAt?: Date | null;
    createdAt?: Date;
  }
) {
  return prisma.zeliSubscription.create({
    data: {
      tenantId,
      planId,
      status: overrides.status,
      providerReference: `ref-${Math.random().toString(36).slice(2, 12)}`,
      amount: 169,
      periodStart: overrides.periodEnd ? new Date(overrides.periodEnd.getTime() - 30 * DAY) : null,
      periodEnd: overrides.periodEnd ?? null,
      graceEndsAt: overrides.graceEndsAt ?? null,
      createdAt: overrides.createdAt,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("subscription access states", () => {
  it("keeps an active paid period operable", async () => {
    const t = await tenant();
    const p = await plan();
    await subscription(t.id, p.id, {
      status: "active",
      periodEnd: new Date(NOW.getTime() + 10 * DAY),
    });
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access).toMatchObject({ reason: "active", operable: true, billingRequired: false });
  });

  it("keeps the approved grace window operable and reports its end", async () => {
    const t = await tenant();
    const p = await plan();
    await subscription(t.id, p.id, {
      status: "active",
      periodEnd: new Date(NOW.getTime() - 2 * DAY),
      graceEndsAt: new Date(NOW.getTime() + 3 * DAY),
    });
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access.reason).toBe("grace_period");
    expect(access.operable).toBe(true);
    expect(access.graceEndsAt?.toISOString()).toBe("2026-11-30T12:00:00.000Z");
  });

  it("blocks an active record whose paid period and grace have both ended", async () => {
    const t = await tenant();
    const p = await plan();
    await subscription(t.id, p.id, {
      status: "active",
      periodEnd: new Date(NOW.getTime() - 8 * DAY),
      graceEndsAt: new Date(NOW.getTime() - 3 * DAY),
    });
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access).toMatchObject({ reason: "expired", operable: false, billingRequired: true });
  });

  it("blocks a pending first payment", async () => {
    const t = await tenant("PENDING_PAYMENT");
    const p = await plan();
    await subscription(t.id, p.id, { status: "pending_payment" });
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access).toMatchObject({ reason: "pending_payment", operable: false, billingRequired: true });
  });

  it("distinguishes a newly provisioned business with no package yet", async () => {
    const t = await tenant("PENDING_PAYMENT");
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access).toMatchObject({ reason: "pending_payment", operable: false, billingRequired: true });
    expect(access.headline).toBe("Choose a package");
  });

  it("keeps a legacy active business with no subscription grandfathered", async () => {
    const t = await tenant("ACTIVE");
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access).toMatchObject({ reason: "none", operable: true, billingRequired: false });
  });

  it("reports failed, suspended, cancelled and refunded packages separately", async () => {
    for (const status of ["failed", "suspended", "cancelled", "refunded"] as const) {
      await cleanDatabase();
      const t = await tenant();
      const p = await plan();
      await subscription(t.id, p.id, { status });
      const access = await resolveSubscriptionAccess(t.id, NOW);
      expect(access.reason).toBe(status);
      expect(access.operable).toBe(false);
      expect(access.billingRequired).toBe(true);
    }
  });

  it("refuses a business that is not open for operations", async () => {
    const t = await tenant("SUSPENDED");
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access.reason).toBe("tenant_unavailable");
    expect(access.operable).toBe(false);
    expect(access.detail).not.toMatch(/password|token|cookie/i);
  });

  it("uses a usable active package even when an older pending row exists", async () => {
    const t = await tenant();
    const p = await plan();
    await subscription(t.id, p.id, {
      status: "pending_payment",
      createdAt: new Date(NOW.getTime() - 20 * DAY),
    });
    await subscription(t.id, p.id, {
      status: "active",
      periodEnd: new Date(NOW.getTime() + 5 * DAY),
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    const access = await resolveSubscriptionAccess(t.id, NOW);
    expect(access.reason).toBe("active");
  });
});

describe("redirect destinations", () => {
  it("returns the destination chosen by the server instead of collapsing to login", () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/admin/billing?payment=required&state=expired;307;",
    });
    expect(redirectPathFromError(redirect)).toBe("/admin/billing?payment=required&state=expired");
  });

  it("accepts push redirects and rejects unsafe or foreign destinations", () => {
    expect(
      redirectPathFromError(
        Object.assign(new Error("NEXT_REDIRECT"), {
          digest: "NEXT_REDIRECT;push;/unauthorized?reason=role_denied;303;",
        }),
      ),
    ).toBe("/unauthorized?reason=role_denied");
    for (const digest of [
      "NEXT_REDIRECT;replace;//evil.example/steal;307;",
      "NEXT_REDIRECT;replace;https://evil.example/steal;307;",
      "NEXT_REDIRECT;replace;;307;",
    ]) {
      expect(
        redirectPathFromError(Object.assign(new Error("NEXT_REDIRECT"), { digest })),
      ).toBeNull();
    }
  });

  it("ignores ordinary errors", () => {
    expect(redirectPathFromError(new Error("database unavailable"))).toBeNull();
  });
});
