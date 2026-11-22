/**
 * AI Investigation add-on: automatic activation by verified payment.
 *
 * The owner's requirement is that a genuine, provider-verified add-on purchase turns
 * the feature on by itself — a Super Admin must not be a queue for every customer —
 * while a browser redirect, a duplicate webhook, a wrong amount, a mismatched
 * currency, a zero price, a refund or a revocation is never able to grant access.
 *
 * Every provider call is mocked. No real charge is made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { prisma, cleanDatabase, createTestTenant } from "./setup";
import { handlePaystackWebhook, ADDON_PAYMENT_ACTOR_ID } from "@/lib/payments/zeli-subscriptions";
import {
  AI_INVESTIGATION_ADDON,
  resolveAiInvestigationAccess,
} from "@/lib/zeli/investigation/entitlement";
import { usagePeriodKey } from "@/lib/zeli/usage";

const SECRET = "sk_test_addon_secret";
const DAY = 86_400_000;

function signature(raw: string): string {
  return createHmac("sha512", SECRET).update(raw).digest("hex");
}

function chargeBody(input: {
  id: number;
  reference: string;
  amount?: number;
  currency?: string;
  status?: string;
  event?: string;
}) {
  return JSON.stringify({
    event: input.event ?? "charge.success",
    data: {
      id: input.id,
      reference: input.reference,
      status: input.status ?? "success",
      amount: input.amount ?? 5000,
      currency: input.currency ?? "GHS",
      paid_at: "2026-12-05T10:00:00.000Z",
      customer: { customer_code: "CUS_ADDON" },
    },
  });
}

async function post(raw: string) {
  return handlePaystackWebhook(raw, signature(raw));
}

async function addonCheckout(input: { price?: number; amount?: number } = {}) {
  const tenant = await createTestTenant({ momo: true, susu: false });
  const plan = await prisma.zeliPlan.create({
    data: {
      code: "ai-investigation",
      name: "AI Investigation",
      description: "Dedicated AI investigation package",
      billingInterval: "month",
      price: input.price ?? 50,
      currency: "GHS",
      status: "active",
      isPublic: true,
      usageAllowance: 50,
      zeliIncluded: false,
      addonKey: AI_INVESTIGATION_ADDON,
    },
  });
  const subscription = await prisma.zeliSubscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: "pending",
      provider: "paystack",
      providerReference: `ADDON-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      amount: input.amount ?? (input.price ?? 50),
      currency: "GHS",
      periodStart: null,
      periodEnd: null,
      paidAt: null,
    },
  });
  return { tenant, plan, subscription };
}

beforeEach(async () => {
  await cleanDatabase();
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  process.env.PAYSTACK_ENABLED = "true";
});

describe("automatic activation after a verified payment", () => {
  it("activates the entitlement and grants the allowance immediately", async () => {
    const { tenant, subscription } = await addonCheckout({ price: 50 });
    const raw = chargeBody({ id: 5001, reference: subscription.providerReference, amount: 5000 });

    const response = await post(raw);
    expect(response.ok, response.decision).toBe(true);
    expect(response.status).toBe(200);

    const entitlement = await prisma.aiInvestigationEntitlement.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(entitlement.status).toBe("active");
    expect(entitlement.planCode).toBe("ai-investigation");
    expect(entitlement.subscriptionId).toBe(subscription.id);
    // The record must not claim a human activated it.
    expect(entitlement.activatedById).toBe(ADDON_PAYMENT_ACTOR_ID);
    expect(entitlement.reason).toMatch(/Verified provider payment/);
    expect(entitlement.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Access is available in the same month, with the package allowance.
    const access = await resolveAiInvestigationAccess(tenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(access.allowed, access.reason ?? "").toBe(true);
    expect(access.planCode).toBe("ai-investigation");
    expect(access.allowance).toBe(50);
    expect(access.used).toBe(0);
    expect(access.activatedAt).not.toBeNull();

    // The audit trail names the payment, not a person.
    const audit = await prisma.platformAuditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: "ai_investigation.auto_activated" },
    });
    expect(audit.actorId).toBeNull();
    const details = JSON.parse(String(audit.details));
    expect(details.source).toBe("payment_provider");
    expect(details.providerReference).toBe(subscription.providerReference);
    expect(details.financialMutation).toBe(false);
  });

  it("never grants the base analytics entitlement from an add-on payment", async () => {
    const { tenant, subscription } = await addonCheckout();
    await post(chargeBody({ id: 5002, reference: subscription.providerReference }));
    const base = await prisma.zeliEntitlement.findUnique({
      where: {
        tenantId_featureKey: { tenantId: tenant.id, featureKey: "zeli_analytics" },
      },
    });
    expect(base).toBeNull();
  });

  it("is idempotent: a duplicate event cannot activate twice", async () => {
    const { tenant, subscription } = await addonCheckout();
    const raw = chargeBody({ id: 5003, reference: subscription.providerReference });
    await post(raw);
    await post(raw);

    const entitlements = await prisma.aiInvestigationEntitlement.count({
      where: { tenantId: tenant.id },
    });
    expect(entitlements).toBe(1);
    const audit = await prisma.platformAuditLog.count({
      where: { tenantId: tenant.id, action: "ai_investigation.auto_activated" },
    });
    expect(audit).toBe(1);

    const usage = await prisma.aiInvestigationUsage.count({
      where: { tenantId: tenant.id, period: usagePeriodKey() },
    });
    expect(usage).toBe(0);
  });

  it("refuses a payment whose amount does not match the package price", async () => {
    const { tenant, subscription } = await addonCheckout({ price: 50 });
    await post(
      chargeBody({ id: 5004, reference: subscription.providerReference, amount: 100 })
    );
    expect(
      await prisma.aiInvestigationEntitlement.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
    const access = await resolveAiInvestigationAccess(tenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(access.allowed).toBe(false);
  });

  it("refuses a payment in the wrong currency", async () => {
    const { tenant, subscription } = await addonCheckout();
    await post(
      chargeBody({
        id: 5005,
        reference: subscription.providerReference,
        currency: "NGN",
      })
    );
    expect(
      await prisma.aiInvestigationEntitlement.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
  });

  it("refuses a zero-price package as a paid purchase", async () => {
    const { tenant, plan, subscription } = await addonCheckout({ price: 0, amount: 0 });
    await post(chargeBody({ id: 5006, reference: subscription.providerReference, amount: 0 }));
    expect(
      await prisma.aiInvestigationEntitlement.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
    const exception = await prisma.zeliPaymentEvent.findFirst({
      where: { reference: subscription.providerReference },
    });
    expect(exception).not.toBeNull();
    const after = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.paidAt).toBeNull();
    expect(plan.price.toNumber()).toBe(0);
  });

  it("does not activate from an unsigned request", async () => {
    const { tenant, subscription } = await addonCheckout();
    const raw = chargeBody({ id: 5007, reference: subscription.providerReference });
    const response = await handlePaystackWebhook(raw, "deadbeef");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await prisma.aiInvestigationEntitlement.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
  });

  it("reactivates after a new verified payment following a revocation", async () => {
    const { tenant, subscription } = await addonCheckout();
    await post(chargeBody({ id: 5008, reference: subscription.providerReference }));
    await prisma.aiInvestigationEntitlement.update({
      where: { tenantId: tenant.id },
      data: {
        status: "revoked",
        revokedAt: new Date(),
        revokedById: "platform-admin-1",
        revokedByEmail: "ops@bloomcore.test",
        revokeReason: "Abuse report under review.",
      },
    });

    const before = await resolveAiInvestigationAccess(tenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(before.allowed).toBe(false);
    expect(before.reason).toBe("activation_revoked");

    // A renewal payment is a new, verified entitlement.
    const renewal = await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: subscription.planId,
        status: "pending",
        provider: "paystack",
        providerReference: `ADDON-RENEW-${Date.now()}`,
        amount: 50,
        currency: "GHS",
        periodStart: null,
        periodEnd: null,
        paidAt: null,
      },
    });
    await post(
      chargeBody({ id: 5009, reference: renewal.providerReference })
    );

    const after = await resolveAiInvestigationAccess(tenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(after.allowed, after.reason ?? "").toBe(true);
    const row = await prisma.aiInvestigationEntitlement.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(row.status).toBe("active");
    expect(row.revokedAt).toBeNull();
  });

  it("stops access when the paid period ends, without a job that extends it", async () => {
    const { tenant, subscription } = await addonCheckout();
    await post(chargeBody({ id: 5010, reference: subscription.providerReference }));
    await prisma.zeliSubscription.update({
      where: { id: subscription.id },
      data: { status: "expired", periodEnd: new Date(Date.now() - DAY) },
    });
    const access = await resolveAiInvestigationAccess(tenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe("payment_not_current");
  });
});
