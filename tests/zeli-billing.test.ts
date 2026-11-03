import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import type { TenantContext } from "@/lib/tenant";
import {
  cancelZeliSubscription,
  createZeliCheckout,
  handlePaystackWebhook,
  verifyAndFulfil,
} from "@/lib/payments/zeli-subscriptions";
import { evaluateZeliAccess } from "@/lib/zeli/entitlements";

const SECRET = "sk_test_billing_secret";
const REF = "ZELI-TEST-REFERENCE-1";

async function ctxFor(tenantId: string, adminId: string): Promise<TenantContext> {
  return {
    tenantId,
    tenantCode: "T-A",
    tenantName: "Billing Tenant",
    momoEnabled: true,
    susuEnabled: true,
    userId: adminId,
    role: "admin",
    modules: ["momo", "susu"],
  };
}

async function seedPlan(code = "zeli-monthly", price = 199) {
  return prisma.zeliPlan.create({
    data: {
      code,
      name: "Zeli Monthly",
      billingInterval: "month",
      price,
      currency: "GHS",
      features: JSON.stringify(["Analytics", "Explanations"]),
      status: "active",
      isPublic: true,
    },
  });
}

function initializeResponse(reference: string) {
  return new Response(
    JSON.stringify({
      status: true,
      data: {
        authorization_url: "https://checkout.paystack.com/test-code",
        reference,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function signature(raw: string) {
  return createHmac("sha512", SECRET).update(raw).digest("hex");
}

beforeEach(async () => {
  await cleanDatabase();
  vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
});

describe("Zeli subscription checkout", () => {
  it("initializes payment from the server catalogue and never trusts a client amount", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await seedPlan("zeli-monthly", 199);
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.paystack.co/transaction/initialize");
      const body = JSON.parse(String(init?.body));
      expect(body.amount).toBe("19900");
      expect(body.currency).toBe("GHS");
      return initializeResponse(body.reference);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createZeliCheckout(await ctxFor(tenant.id, admin.id), "zeli-monthly");
    expect(result.authorizationUrl).toContain("checkout.paystack.com");
    const subscription = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: result.reference },
    });
    expect(subscription.status).toBe("pending");
    expect(Number(subscription.amount)).toBe(199);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("rejects an unavailable package", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await expect(
      createZeliCheckout(await ctxFor(tenant.id, admin.id), "missing-package")
    ).rejects.toThrow("not available");
  });
});

describe("Paystack webhook lifecycle", () => {
  async function pendingSubscription() {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const plan = await seedPlan();
    const subscription = await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "pending",
        provider: "paystack",
        providerReference: REF,
        amount: plan.price,
        currency: plan.currency,
      },
    });
    return { tenant, admin, plan, subscription };
  }

  it("rejects a forged webhook signature", async () => {
    const { subscription } = await pendingSubscription();
    const raw = JSON.stringify({
      event: "charge.success",
      data: { id: 1, reference: REF, status: "success", amount: 19900, currency: "GHS" },
    });
    const result = await handlePaystackWebhook(raw, "bad-signature");
    expect(result.status).toBe(401);
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(fresh.status).toBe("pending");
  });

  it("activates entitlement exactly once for duplicate webhooks", async () => {
    const { tenant, subscription } = await pendingSubscription();
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 998877,
        reference: REF,
        status: "success",
        amount: 19900,
        currency: "GHS",
        paid_at: "2026-11-04T10:00:00.000Z",
        customer: { customer_code: "CUS_TEST" },
      },
    });
    const first = await handlePaystackWebhook(raw, signature(raw));
    const second = await handlePaystackWebhook(raw, signature(raw));
    expect(first.decision).toBe("processed");
    expect(second.decision).toBe("ignored");

    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
      include: { events: true },
    });
    expect(fresh.status).toBe("active");
    expect(fresh.periodEnd).not.toBeNull();
    expect(fresh.events.filter((event) => event.decision === "processed")).toHaveLength(1);

    const entitlement = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: {
        tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" },
      },
    });
    expect(
      evaluateZeliAccess({ role: "admin", entitlement }).allowed
    ).toBe(true);
  });

  it("rejects a payment whose amount or currency does not match", async () => {
    const { subscription } = await pendingSubscription();
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 445566,
        reference: REF,
        status: "success",
        amount: 1,
        currency: "GHS",
      },
    });
    const result = await handlePaystackWebhook(raw, signature(raw));
    expect(result.decision).toBe("failed");
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(fresh.status).toBe("pending");
  });

  it("suspends entitlement after a refund", async () => {
    const { tenant, subscription } = await pendingSubscription();
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 111222,
        reference: REF,
        status: "success",
        amount: 19900,
        currency: "GHS",
        paid_at: "2026-11-04T10:00:00.000Z",
      },
    });
    await handlePaystackWebhook(raw, signature(raw));
    const refundRaw = JSON.stringify({
      event: "refund.processed",
      data: { id: 333444, reference: REF, status: "success", amount: 19900, currency: "GHS" },
    });
    await handlePaystackWebhook(refundRaw, signature(refundRaw));
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(fresh.status).toBe("refunded");
    const entitlement = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: {
        tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" },
      },
    });
    expect(entitlement.status).toBe("suspended");
    expect(evaluateZeliAccess({ role: "admin", entitlement }).allowed).toBe(false);
  });

  it("verifies a callback through the provider, not the redirect", async () => {
    const { tenant, subscription } = await pendingSubscription();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: true,
          data: {
            id: 777888,
            status: "success",
            reference: REF,
            amount: 19900,
            currency: "GHS",
            paid_at: "2026-11-04T11:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await verifyAndFulfil(REF, "callback");
    expect(result.decision).toBe("processed");
    const entitlement = await prisma.zeliEntitlement.findUnique({
      where: {
        tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" },
      },
    });
    expect(entitlement?.source).toBe("subscription");
    expect(subscription.status).toBe("pending");
    vi.unstubAllGlobals();
  });

  it("cancels renewal but keeps access until the paid period ends", async () => {
    const { tenant, admin, subscription } = await pendingSubscription();
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 555666,
        reference: REF,
        status: "success",
        amount: 19900,
        currency: "GHS",
        paid_at: "2026-11-04T10:00:00.000Z",
      },
    });
    await handlePaystackWebhook(raw, signature(raw));
    await cancelZeliSubscription(await ctxFor(tenant.id, admin.id));
    const fresh = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(fresh.cancelAtPeriodEnd).toBe(true);
    const entitlement = await prisma.zeliEntitlement.findUniqueOrThrow({
      where: {
        tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" },
      },
    });
    expect(evaluateZeliAccess({ role: "admin", entitlement }).allowed).toBe(true);
  });
});
