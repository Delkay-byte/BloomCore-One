import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import type { TenantContext } from "@/lib/tenant";
import {
  createZeliCheckout,
  handlePaystackWebhook,
  retryZeliPaymentRefund,
  verifyAndFulfil,
} from "@/lib/payments/zeli-subscriptions";
import { evaluateZeliAccess } from "@/lib/zeli/entitlements";

/**
 * Regression suite for the release-blocking commerce defects:
 *  - A: a paid renewal while active must extend, never be discarded.
 *  - B: concurrent checkouts and duplicate settlements must be resolved.
 *  - F: every supported webhook event must be idempotent.
 *  - H: the lifecycle must stay correct end to end.
 *
 * All provider calls are mocked. No real charge or refund is made here.
 */

const SECRET = "sk_test_lifecycle_secret";
const DAY = 86_400_000;

function signature(raw: string): string {
  return createHmac("sha512", SECRET).update(raw).digest("hex");
}

async function ctxFor(tenantId: string, adminId: string): Promise<TenantContext> {
  return {
    tenantId,
    tenantCode: "T-LIFE",
    tenantName: "Lifecycle Tenant",
    momoEnabled: true,
    susuEnabled: true,
    userId: adminId,
    role: "admin",
    modules: ["momo", "susu"],
  };
}

async function seedPlan(overrides: Partial<{ code: string; price: number; interval: string }> = {}) {
  return prisma.zeliPlan.create({
    data: {
      code: overrides.code ?? "zeli-monthly",
      name: "Zeli Monthly",
      billingInterval: overrides.interval ?? "month",
      price: overrides.price ?? 199,
      currency: "GHS",
      features: JSON.stringify(["Analytics"]),
      status: "active",
      isPublic: true,
    },
  });
}

function addMonths(start: Date, months: number): Date {
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + months);
  return end;
}

function chargeBody(input: {
  id: number;
  reference: string;
  amount?: number;
  currency?: string;
  paidAt?: string;
  status?: string;
}) {
  return JSON.stringify({
    event: "charge.success",
    data: {
      id: input.id,
      reference: input.reference,
      status: input.status ?? "success",
      amount: input.amount ?? 19900,
      currency: input.currency ?? "GHS",
      paid_at: input.paidAt ?? "2026-11-04T10:00:00.000Z",
      customer: { customer_code: "CUS_LIFE" },
    },
  });
}

function initializeResponse(reference: string) {
  return new Response(
    JSON.stringify({
      status: true,
      data: { authorization_url: "https://checkout.paystack.com/life", reference },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function refundResponse(status = "pending") {
  return new Response(
    JSON.stringify({
      status: true,
      data: { id: 900001, status, amount: 19900, currency: "GHS" },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function pendingCheckout(input?: {
  reference?: string;
  status?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  paidAt?: Date | null;
  periodGranted?: boolean;
  failureReason?: string | null;
  createdAt?: Date;
}) {
  const tenant = await createTestTenant();
  const admin = await createTestAdmin({ tenantId: tenant.id });
  const plan = await seedPlan();
  const subscription = await prisma.zeliSubscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: input?.status ?? "pending",
      provider: "paystack",
      providerReference: input?.reference ?? "ZELI-LIFE-REF-1",
      amount: plan.price,
      currency: plan.currency,
      periodStart: input?.periodStart ?? null,
      periodEnd: input?.periodEnd ?? null,
      paidAt: input?.paidAt ?? null,
      periodGranted: input?.periodGranted ?? false,
      failureReason: input?.failureReason ?? null,
      ...(input?.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
  return { tenant, admin, plan, subscription };
}

async function entitlementFor(tenantId: string) {
  return prisma.zeliEntitlement.findUnique({
    where: { tenantId_featureKey: { tenantId, featureKey: "zeli_analytics" } },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
  vi.stubEnv("NODE_ENV", "test");
});

describe("A. early and late renewals", () => {
  it("extends an active subscription from its current expiry instead of discarding the payment", async () => {
    const currentEnd = new Date(Date.now() + 10 * DAY);
    const { tenant, subscription: current } = await pendingCheckout({
      reference: "ZELI-CURRENT",
      status: "active",
      periodStart: new Date(Date.now() - 20 * DAY),
      periodEnd: currentEnd,
      paidAt: new Date(Date.now() - 20 * DAY),
      periodGranted: true,
    });
    await prisma.zeliEntitlement.create({
      data: {
        tenantId: tenant.id,
        featureKey: "zeli_analytics",
        status: "active",
        source: "subscription",
        startsAt: new Date(Date.now() - 20 * DAY),
        expiresAt: currentEnd,
      },
    });
    const renewal = await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: current.planId,
        status: "pending",
        provider: "paystack",
        providerReference: "ZELI-RENEWAL",
        amount: current.amount,
        currency: current.currency,
      },
    });

    const raw = chargeBody({
      id: 700001,
      reference: renewal.providerReference,
      paidAt: new Date().toISOString(),
    });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(result.decision).toBe("processed");

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: renewal.id },
    });
    expect(fresh.status).toBe("active");
    expect(fresh.periodGranted).toBe(true);
    expect(fresh.periodStart?.getTime()).toBe(currentEnd.getTime());
    expect(fresh.periodEnd?.getTime()).toBe(addMonths(currentEnd, 1).getTime());

    const old = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: current.id } });
    expect(old.status).toBe("superseded");

    const entitlement = await entitlementFor(tenant.id);
    expect(entitlement?.status).toBe("active");
    expect(entitlement?.expiresAt?.getTime()).toBe(addMonths(currentEnd, 1).getTime());
  });

  it("extends from the verified payment time when the previous period already ended", async () => {
    const oldEnd = new Date(Date.now() - 5 * DAY);
    const { tenant, subscription: old } = await pendingCheckout({
      reference: "ZELI-LAPSED",
      status: "expired",
      periodStart: new Date(Date.now() - 35 * DAY),
      periodEnd: oldEnd,
      paidAt: new Date(Date.now() - 35 * DAY),
      periodGranted: true,
    });
    const paymentTime = new Date(Date.now() - 1 * DAY);
    const renewal = await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: old.planId,
        status: "pending",
        provider: "paystack",
        providerReference: "ZELI-REACTIVATE",
        amount: old.amount,
        currency: old.currency,
      },
    });

    const raw = chargeBody({
      id: 700002,
      reference: renewal.providerReference,
      paidAt: paymentTime.toISOString(),
    });
    await handlePaystackWebhook(raw, signature(raw));

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: renewal.id } });
    expect(fresh.periodStart?.getTime()).toBe(paymentTime.getTime());
    expect(fresh.periodEnd?.getTime()).toBe(addMonths(paymentTime, 1).getTime());
    const entitlement = await entitlementFor(tenant.id);
    expect(entitlement?.expiresAt?.getTime()).toBe(addMonths(paymentTime, 1).getTime());
  });

  it("grants the same subscription period only once when the webhook is replayed", async () => {
    const { tenant, subscription } = await pendingCheckout();
    const raw = chargeBody({ id: 700003, reference: subscription.providerReference });
    await handlePaystackWebhook(raw, signature(raw));
    const first = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    await handlePaystackWebhook(raw, signature(raw));
    await handlePaystackWebhook(raw, signature(raw));
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.periodEnd?.getTime()).toBe(first.periodEnd?.getTime());
    const entitlement = await entitlementFor(tenant.id);
    expect(entitlement?.expiresAt?.getTime()).toBe(first.periodEnd?.getTime());
  });

  it("does not extend twice when the callback verification and the webhook both arrive", async () => {
    const { tenant, subscription } = await pendingCheckout();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: true,
          data: {
            id: 700004,
            status: "success",
            reference: subscription.providerReference,
            amount: 19900,
            currency: "GHS",
            paid_at: "2026-11-04T10:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    await verifyAndFulfil(subscription.providerReference, "callback");
    const afterVerify = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    vi.unstubAllGlobals();

    const raw = chargeBody({
      id: 700004,
      reference: subscription.providerReference,
      paidAt: "2026-11-04T10:00:00.000Z",
    });
    const webhook = await handlePaystackWebhook(raw, signature(raw));
    expect(webhook.decision).toBe("ignored");

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.periodEnd?.getTime()).toBe(afterVerify.periodEnd?.getTime());
    const entitlement = await entitlementFor(tenant.id);
    expect(entitlement?.expiresAt?.getTime()).toBe(afterVerify.periodEnd?.getTime());
  });

  it("does not extend twice when the provider omits the charge id", async () => {
    const { tenant, subscription } = await pendingCheckout({ reference: "ZELI-NO-ID" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: true,
            data: {
              status: "success",
              reference: subscription.providerReference,
              amount: 19900,
              currency: "GHS",
              paid_at: "2026-11-04T10:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    await verifyAndFulfil(subscription.providerReference, "callback");
    const afterVerify = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    vi.unstubAllGlobals();

    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        reference: subscription.providerReference,
        status: "success",
        amount: 19900,
        currency: "GHS",
        paid_at: "2026-11-04T10:00:00.000Z",
      },
    });
    const webhook = await handlePaystackWebhook(raw, signature(raw));
    expect(webhook.decision).toBe("ignored");

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.periodEnd?.getTime()).toBe(afterVerify.periodEnd?.getTime());
    const entitlement = await entitlementFor(tenant.id);
    expect(entitlement?.expiresAt?.getTime()).toBe(afterVerify.periodEnd?.getTime());
  });

  it("processes concurrent duplicate renewals once", async () => {
    const { tenant, subscription } = await pendingCheckout();
    const raw = chargeBody({ id: 700005, reference: subscription.providerReference });
    const results = await Promise.all([
      handlePaystackWebhook(raw, signature(raw)),
      handlePaystackWebhook(raw, signature(raw)),
    ]);
    const decisions = results.map((row) => row.decision).sort();
    expect(decisions).toContain("processed");
    expect(decisions.filter((value) => value === "processed")).toHaveLength(1);

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    const entitlement = await entitlementFor(tenant.id);
    expect(entitlement?.expiresAt?.getTime()).toBe(fresh.periodEnd?.getTime());
    const processed = await prisma.zeliPaymentEvent.count({
      where: { reference: subscription.providerReference, decision: "processed" },
    });
    expect(processed).toBe(1);
  });

  it("suspends access when a granted subscription is refunded", async () => {
    const { tenant, subscription } = await pendingCheckout();
    const raw = chargeBody({ id: 700006, reference: subscription.providerReference });
    await handlePaystackWebhook(raw, signature(raw));
    const refund = JSON.stringify({
      event: "refund.processed",
      data: {
        id: 700007,
        reference: subscription.providerReference,
        status: "success",
        amount: 19900,
        currency: "GHS",
      },
    });
    const result = await handlePaystackWebhook(refund, signature(refund));
    expect(result.decision).toBe("processed");
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.status).toBe("refunded");
    const entitlement = await entitlementFor(tenant.id);
    expect(entitlement?.status).toBe("suspended");
    expect(evaluateZeliAccess({ role: "admin", entitlement: entitlement! }).allowed).toBe(false);
  });
});

describe("B. concurrent checkouts and duplicate settlements", () => {
  it("allows only one pending checkout for the same tenant and plan", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await seedPlan();
    const ctx = await ctxFor(tenant.id, admin.id);
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return initializeResponse(body.reference);
    }));

    await createZeliCheckout(ctx, "zeli-monthly");
    await expect(createZeliCheckout(ctx, "zeli-monthly")).rejects.toMatchObject({
      code: "checkout_in_progress",
    });

    const pending = await prisma.zeliSubscription.count({
      where: { tenantId: tenant.id, status: "pending" },
    });
    expect(pending).toBe(1);
    vi.unstubAllGlobals();
  });

  it("keeps a single pending row when checkouts race", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await seedPlan();
    const ctx = await ctxFor(tenant.id, admin.id);
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return initializeResponse(body.reference);
    }));

    const settled = await Promise.allSettled([
      createZeliCheckout(ctx, "zeli-monthly"),
      createZeliCheckout(ctx, "zeli-monthly"),
      createZeliCheckout(ctx, "zeli-monthly"),
    ]);
    const successes = settled.filter((row) => row.status === "fulfilled");
    expect(successes).toHaveLength(1);
    const pending = await prisma.zeliSubscription.count({
      where: { tenantId: tenant.id, status: "pending" },
    });
    expect(pending).toBe(1);
    vi.unstubAllGlobals();
  });

  it("replaces a stale pending checkout instead of blocking the tenant forever", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const plan = await seedPlan();
    const stale = await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "pending",
        provider: "paystack",
        providerReference: "ZELI-STALE",
        amount: plan.price,
        currency: plan.currency,
        pendingKey: `${tenant.id}:${plan.id}`,
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    });
    const ctx = await ctxFor(tenant.id, admin.id);
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return initializeResponse(body.reference);
    }));
    await createZeliCheckout(ctx, "zeli-monthly");
    const old = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: stale.id } });
    expect(old.status).toBe("expired");
    expect(old.pendingKey).toBeNull();
    const pending = await prisma.zeliSubscription.count({
      where: { tenantId: tenant.id, status: "pending" },
    });
    expect(pending).toBe(1);
    vi.unstubAllGlobals();
  });

  it("requests a provider refund for a payment on a superseded checkout and grants no period", async () => {
    const tenant = await createTestTenant();
    const plan = await seedPlan();
    const superseded = await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "expired",
        provider: "paystack",
        providerReference: "ZELI-OLD-TAB",
        amount: plan.price,
        currency: plan.currency,
        failureReason: "Superseded by a newer checkout",
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "active",
        provider: "paystack",
        providerReference: "ZELI-NEW",
        amount: plan.price,
        currency: plan.currency,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 20 * DAY),
        paidAt: new Date(),
        periodGranted: true,
      },
    });
    const fetchMock = vi.fn(async () => refundResponse("pending"));
    vi.stubGlobal("fetch", fetchMock);

    const raw = chargeBody({ id: 710001, reference: superseded.providerReference });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(["refund_requested", "exception"]).toContain(result.decision);

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: superseded.id } });
    expect(fresh.periodGranted).toBe(false);
    expect(fresh.periodEnd).toBeNull();
    expect(fresh.refundStatus).toBe("pending");
    expect(fresh.refundReference).toBeTruthy();

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(String(calls[0][0])).toBe("https://api.paystack.co/refund");
    expect(JSON.parse(String(calls[0][1].body)).transaction).toBe("ZELI-OLD-TAB");
    vi.unstubAllGlobals();
  });

  it("records a visible exception when the automatic refund cannot be completed", async () => {
    const tenant = await createTestTenant();
    const plan = await seedPlan();
    const superseded = await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "expired",
        provider: "paystack",
        providerReference: "ZELI-OLD-FAIL",
        amount: plan.price,
        currency: plan.currency,
        failureReason: "Superseded by a newer checkout",
        createdAt: new Date(Date.now() - 90 * 60 * 1000),
      },
    });
    await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "active",
        provider: "paystack",
        providerReference: "ZELI-NEWER",
        amount: plan.price,
        currency: plan.currency,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 20 * DAY),
        paidAt: new Date(),
        periodGranted: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ status: false, message: "refund unavailable" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    ));

    const raw = chargeBody({ id: 710002, reference: superseded.providerReference });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(result.decision).toBe("exception");

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: superseded.id } });
    expect(fresh.refundStatus).toBe("failed");
    expect(fresh.refundFailureReason).toBeTruthy();
    const exception = await prisma.zeliPaymentException.findFirst({
      where: { reference: superseded.providerReference, status: "open" },
    });
    expect(exception?.kind).toBe("refund_failed");
    vi.unstubAllGlobals();
  });

  it("never calls the provider twice for an already processed refund", async () => {
    const { tenant, subscription } = await pendingCheckout({ status: "active", periodGranted: true });
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { refundStatus: "processed", refundReference: "900123" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await retryZeliPaymentRefund({
      subscriptionId: subscription.id,
      reason: "Duplicate refund request",
      actorId: "platform-actor",
      tenantId: tenant.id,
    });
    expect(result.decision).toBe("already_processed");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("retries a failed refund once and records the provider result", async () => {
    const { tenant, subscription } = await pendingCheckout({
      status: "active",
      periodGranted: true,
      reference: "ZELI-RETRY-REF",
    });
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { refundStatus: "failed", refundFailureReason: "timeout" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => refundResponse("processed")));
    const result = await retryZeliPaymentRefund({
      subscriptionId: subscription.id,
      reason: "Retry failed duplicate refund",
      actorId: "platform-actor",
      tenantId: tenant.id,
    });
    expect(result.decision).toBe("refunded");
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.refundStatus).toBe("processed");
    expect(fresh.refundedAt).not.toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("F. webhook idempotency for every supported event", () => {
  it("deduplicates a non-charge event at the database level", async () => {
    const { subscription } = await pendingCheckout();
    const raw = JSON.stringify({
      event: "charge.failed",
      data: { id: 720001, reference: subscription.providerReference, status: "failed" },
    });
    const first = await handlePaystackWebhook(raw, signature(raw));
    const second = await handlePaystackWebhook(raw, signature(raw));
    expect(first.decision).toBe("processed");
    expect(second.decision).toBe("ignored");
    const events = await prisma.zeliPaymentEvent.count({
      where: { eventId: "paystack:charge.failed:720001" },
    });
    expect(events).toBe(1);
  });

  it("rejects a forged signature before any side effect", async () => {
    const { subscription } = await pendingCheckout();
    const raw = chargeBody({ id: 720002, reference: subscription.providerReference });
    const result = await handlePaystackWebhook(raw, "forged");
    expect(result.status).toBe(401);
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.status).toBe("pending");
    expect(await prisma.zeliPaymentEvent.count()).toBe(0);
  });

  it("rejects a wrong amount and records an auditable exception", async () => {
    const { subscription } = await pendingCheckout();
    const raw = chargeBody({ id: 720003, reference: subscription.providerReference, amount: 1 });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(result.decision).toBe("failed");
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.status).toBe("pending");
    expect(fresh.periodGranted).toBe(false);
    const exception = await prisma.zeliPaymentException.findFirst({
      where: { reference: subscription.providerReference },
    });
    expect(exception?.kind).toBe("payment_mismatch");
  });

  it("rejects a wrong currency without granting access", async () => {
    const { subscription } = await pendingCheckout();
    const raw = chargeBody({
      id: 720004,
      reference: subscription.providerReference,
      currency: "USD",
    });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(result.decision).toBe("failed");
    expect(await entitlementFor(subscription.tenantId)).toBeNull();
  });

  it("records an unknown reference without creating an entitlement", async () => {
    const raw = chargeBody({ id: 720005, reference: "ZELI-NOT-OURS" });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(result.decision).toBe("ignored");
    const event = await prisma.zeliPaymentEvent.findUnique({
      where: { eventId: "paystack:charge.success:720005" },
    });
    expect(event?.reason).toBe("unknown_reference");
  });

  it("does not grant access when a refund arrives before its charge", async () => {
    const { tenant, subscription } = await pendingCheckout();
    const refund = JSON.stringify({
      event: "refund.processed",
      data: {
        id: 720006,
        reference: subscription.providerReference,
        status: "success",
        amount: 19900,
        currency: "GHS",
      },
    });
    await handlePaystackWebhook(refund, signature(refund));
    const charge = chargeBody({ id: 720007, reference: subscription.providerReference });
    const result = await handlePaystackWebhook(charge, signature(charge));
    expect(result.decision).toBe("ignored");
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.status).toBe("refunded");
    expect(await entitlementFor(tenant.id)).toBeNull();
  });

  it("reprocesses an event that was left failed by an earlier attempt", async () => {
    const { subscription } = await pendingCheckout();
    await prisma.zeliPaymentEvent.create({
      data: {
        provider: "paystack",
        eventId: "paystack:charge:720008",
        eventType: "charge.success",
        reference: subscription.providerReference,
        subscriptionId: subscription.id,
        tenantId: subscription.tenantId,
        decision: "failed",
        reason: "processing_failure",
        processedAt: new Date(),
      },
    });
    const raw = chargeBody({ id: 720008, reference: subscription.providerReference });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(result.decision).toBe("processed");
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.status).toBe("active");
  });

  it("ignores an unsupported event type but still records it once", async () => {
    const { subscription } = await pendingCheckout();
    const raw = JSON.stringify({
      event: "transfer.success",
      data: { id: 720009, reference: subscription.providerReference },
    });
    const first = await handlePaystackWebhook(raw, signature(raw));
    const second = await handlePaystackWebhook(raw, signature(raw));
    expect(first.decision).toBe("ignored");
    expect(second.decision).toBe("ignored");
    const count = await prisma.zeliPaymentEvent.count({
      where: { eventId: "paystack:transfer.success:720009" },
    });
    expect(count).toBe(1);
  });
});

describe("H. lifecycle correctness", () => {
  it("refuses checkout while Zeli is globally unavailable", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await seedPlan();
    await prisma.zeliAvailability.upsert({
      where: { id: "global" },
      create: { id: "global", enabled: false, reason: "maintenance" },
      update: { enabled: false, reason: "maintenance" },
    });
    await expect(
      createZeliCheckout(await ctxFor(tenant.id, admin.id), "zeli-monthly")
    ).rejects.toMatchObject({ code: "zeli_unavailable" });
  });

  it("clears the pending guard once a checkout is paid", async () => {
    const { subscription } = await pendingCheckout();
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { pendingKey: `${subscription.tenantId}:${subscription.planId}` },
    });
    const raw = chargeBody({ id: 730001, reference: subscription.providerReference });
    await handlePaystackWebhook(raw, signature(raw));
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(fresh.pendingKey).toBeNull();
  });

  it("keeps access until the paid period ends after cancellation", async () => {
    const { tenant, subscription } = await pendingCheckout({
      status: "active",
      periodStart: new Date(Date.now() - DAY),
      periodEnd: new Date(Date.now() + 10 * DAY),
      paidAt: new Date(Date.now() - DAY),
      periodGranted: true,
    });
    await prisma.zeliEntitlement.create({
      data: {
        tenantId: tenant.id,
        featureKey: "zeli_analytics",
        status: "active",
        source: "subscription",
        startsAt: new Date(Date.now() - DAY),
        expiresAt: new Date(Date.now() + 10 * DAY),
      },
    });
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
    });
    const entitlement = await entitlementFor(tenant.id);
    expect(evaluateZeliAccess({ role: "admin", entitlement: entitlement! }).allowed).toBe(true);
  });
});
