import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.current,
}));

import { getBillingOverview } from "@/lib/actions/billing.actions";
import {
  handlePaystackWebhook,
  payProvisionedSubscription,
  reconcileZeliPayment,
} from "@/lib/payments/zeli-subscriptions";
import { confirmHostedCheckoutReturn } from "@/lib/payments/checkout-return";
import { isTrustedCheckoutUrl } from "@/lib/payments/checkout-url";
import {
  navigateCheckoutTab,
  openBlankCheckoutTab,
  type CheckoutTab,
} from "@/lib/payments/checkout-window";

/**
 * Hosted Paystack checkout: server-derived details, one initialize per open
 * payment, trusted URL handling and exactly-once fulfilment.
 *
 * Every provider call is mocked. No live Paystack request is made and no real
 * card, wallet or phone number is involved.
 */

const SECRET = "sk_test_hosted_checkout";
const CHECKOUT_URL = "https://checkout.paystack.com/hosted-abc123";

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

type InitializeResult =
  | { kind: "ok"; authorizationUrl?: string }
  | { kind: "rejected"; status?: number; message?: string }
  | { kind: "throw"; error?: Error };

function mockProvider(
  options: {
    initialize?: InitializeResult;
    verify?:
      | {
          status: string;
          amountMinor?: number;
          currency?: string;
          paidAt?: string | null;
          id?: number;
        }
      | { error: true };
  } = {}
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });

    if (url.includes("/transaction/initialize")) {
      const response = options.initialize ?? { kind: "ok" };
      if (response.kind === "throw") throw response.error ?? new Error("socket hang up");
      if (response.kind === "rejected") {
        return new Response(
          JSON.stringify({
            status: false,
            message: response.message ?? "Duplicate transaction reference",
          }),
          { status: response.status ?? 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            authorization_url: response.authorizationUrl ?? CHECKOUT_URL,
            reference: body?.reference,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (url.includes("/transaction/verify/")) {
      if (options.verify && "error" in options.verify) {
        throw new Error("verify unavailable");
      }
      const verify = options.verify ?? { status: "abandoned" };
      const reference = decodeURIComponent(url.split("/transaction/verify/")[1] ?? "");
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: verify.status === "success" ? (("id" in verify && verify.id) || 99001) : null,
            status: verify.status,
            reference,
            amount: "amountMinor" in verify ? (verify.amountMinor ?? 9900) : 9900,
            currency: ("currency" in verify && verify.currency) || "GHS",
            paid_at:
              "paidAt" in verify
                ? verify.paidAt
                : verify.status === "success"
                  ? new Date().toISOString()
                  : null,
            customer: { customer_code: "CUS_hosted" },
            metadata: {},
            channel: "card",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected provider call: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function seed(options: { amount?: number; currency?: string } = {}) {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Hosted Checkout Business",
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `owner-${tenant.id}@example.test`,
      fullName: "Owner",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  const plan = await prisma.zeliPlan.create({
    data: {
      code: `starter-${Math.random().toString(36).slice(2, 8)}`,
      name: "Starter",
      billingInterval: "month",
      price: 99,
      currency: "GHS",
      usageAllowance: 250,
      locationLimit: 1,
      staffLimit: 3,
      supportLevel: "Standard support",
      status: "active",
      isPublic: true,
    },
  });
  const reference = `ZELI-${tenant.id.slice(0, 8)}-${Math.random().toString(16).slice(2, 14)}`;
  const subscription = await prisma.zeliSubscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: "pending_payment",
      providerReference: reference,
      amount: options.amount ?? 99,
      currency: options.currency ?? "GHS",
      billingTerm: "monthly",
    },
  });
  const ctx = {
    tenantId: tenant.id,
    tenantName: tenant.name,
    userId: admin.id,
    role: "admin",
    modules: ["momo", "susu"],
    momoEnabled: true,
    susuEnabled: true,
  };
  ctxHolder.current = ctx;
  return { tenant, admin, plan, subscription, reference, ctx };
}

function signature(raw: string): string {
  return createHmac("sha512", SECRET).update(raw).digest("hex");
}

beforeEach(async () => {
  await cleanDatabase();
  vi.unstubAllGlobals();
  vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  vi.stubEnv("PAYSTACK_WEBHOOK_SIGNING_SECRET", "");
  vi.stubEnv("NEXTAUTH_URL", "https://maacash.bloomcoretech.com");
  vi.stubEnv("NODE_ENV", "test");
  ctxHolder.current = null;
});

describe("hosted checkout initialization", () => {
  it("initializes one server-derived transaction for GH₵99 with Mobile Money by default", async () => {
    const { ctx, subscription, admin, reference } = await seed();
    const calls = mockProvider();

    const result = await payProvisionedSubscription(ctx as never, subscription.id, {
      method: "hosted",
    });

    const initializations = calls.filter((call) => call.url.includes("/transaction/initialize"));
    expect(initializations).toHaveLength(1);
    const body = initializations[0].body!;
    expect(body.amount).toBe("9900");
    expect(body.currency).toBe("GHS");
    expect(body.email).toBe(admin.email);
    expect(body.reference).toBe(reference);
    expect(body.channels).toEqual(["mobile_money"]);
    expect(String(body.callback_url)).toContain(
      `/checkout/return?reference=${encodeURIComponent(reference)}`
    );

    expect(result.authorizationUrl).toBe(CHECKOUT_URL);
    expect(result.requiredAction).toBe("checkout");

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("pending");
    expect(attempt.method).toBe("hosted");
    expect(attempt.requiredAction).toBe("checkout");
    expect(attempt.checkoutUrl).toBe(CHECKOUT_URL);
    expect(attempt.checkoutChannel).toBe("mobile_money");
    expect(attempt.attempts).toBe(1);
    expect(result.channel).toBe("mobile_money");
  });

  it("sends only the selected Card channel", async () => {
    const { ctx, subscription } = await seed();
    const calls = mockProvider();
    const result = await payProvisionedSubscription(ctx as never, subscription.id, {
      method: "hosted",
      channel: "card",
    });
    const body = calls.find((call) => call.url.includes("/transaction/initialize"))!.body!;
    expect(body.channels).toEqual(["card"]);
    expect(result.channel).toBe("card");
    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.checkoutChannel).toBe("card");
  });

  it("refuses Bank Transfer until the account is explicitly enabled for it", async () => {
    const { ctx, subscription } = await seed();
    const calls = mockProvider();
    await expect(
      payProvisionedSubscription(ctx as never, subscription.id, {
        method: "hosted",
        channel: "bank_transfer",
      })
    ).rejects.toThrow(/Bank Transfer is not available/);
    expect(calls.filter((call) => call.url.includes("/transaction/initialize"))).toHaveLength(0);
  });

  it("offers Bank Transfer only after the explicit opt-in", async () => {
    vi.stubEnv("PAYSTACK_CHECKOUT_BANK_TRANSFER", "true");
    try {
      const { ctx, subscription } = await seed();
      const calls = mockProvider();
      await payProvisionedSubscription(ctx as never, subscription.id, {
        method: "hosted",
        channel: "bank_transfer",
      });
      const body = calls.find((call) => call.url.includes("/transaction/initialize"))!.body!;
      expect(body.channels).toEqual(["bank_transfer"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("locks the method once a checkout is open and never creates a second payment", async () => {
    const { ctx, subscription } = await seed();
    const calls = mockProvider();
    await payProvisionedSubscription(ctx as never, subscription.id, {
      method: "hosted",
      channel: "mobile_money",
    });
    await expect(
      payProvisionedSubscription(ctx as never, subscription.id, {
        method: "hosted",
        channel: "card",
      })
    ).rejects.toThrow(/already open with mobile money/);
    expect(calls.filter((call) => call.url.includes("/transaction/initialize"))).toHaveLength(1);
    expect(await prisma.zeliChargeAttempt.count()).toBe(1);
  });

  it("ignores browser-supplied prices and derives the amount from the subscription", async () => {
    const { ctx, subscription } = await seed({ amount: 169 });
    const calls = mockProvider();

    await payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" });

    expect(calls.find((call) => call.url.includes("/transaction/initialize"))?.body?.amount).toBe(
      "16900"
    );
  });

  it("reuses the stored checkout URL instead of initializing again", async () => {
    const { ctx, subscription, reference } = await seed();
    const calls = mockProvider();

    const first = await payProvisionedSubscription(ctx as never, subscription.id, {
      method: "hosted",
    });
    const second = await payProvisionedSubscription(ctx as never, subscription.id, {
      method: "hosted",
    });

    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    expect(second.reference).toBe(reference);
    expect(calls.filter((call) => call.url.includes("/transaction/initialize"))).toHaveLength(1);
    expect(await prisma.zeliChargeAttempt.count()).toBe(1);
  });

  it("sends exactly one initialize for ten concurrent clicks", async () => {
    const { ctx, subscription } = await seed();
    const calls = mockProvider();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" })
      )
    );

    expect(calls.filter((call) => call.url.includes("/transaction/initialize"))).toHaveLength(1);
    expect(await prisma.zeliChargeAttempt.count()).toBe(1);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });

  it("records an unresolved attempt when the provider response is lost", async () => {
    const { ctx, subscription } = await seed();
    const calls = mockProvider({
      initialize: {
        kind: "throw",
        error: Object.assign(new Error("aborted"), { name: "AbortError" }),
      },
    });

    await expect(
      payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("unresolved");
    expect(attempt.checkoutUrl).toBeNull();

    await expect(
      payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" })
    ).rejects.toMatchObject({ code: "charge_unresolved" });
    expect(calls.filter((call) => call.url.includes("/transaction/initialize"))).toHaveLength(1);
  });

  it("treats a duplicate-reference rejection as unresolved rather than creating another", async () => {
    const { ctx, subscription } = await seed();
    const calls = mockProvider({
      initialize: { kind: "rejected", status: 400, message: "Duplicate transaction reference" },
    });

    await expect(
      payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("unresolved");
    expect(calls.filter((call) => call.url.includes("/transaction/initialize"))).toHaveLength(1);
  });

  it("refuses a provider checkout URL outside the trusted Paystack hosts", async () => {
    const { ctx, subscription } = await seed();
    mockProvider({
      initialize: { kind: "ok", authorizationUrl: "https://paystack.com.evil.test/pay" },
    });

    await expect(
      payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" })
    ).rejects.toBeTruthy();

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("unresolved");
    expect(attempt.checkoutUrl).toBeNull();
    const row = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.paidAt).toBeNull();
  });

  it("never initializes over an open legacy OTP attempt", async () => {
    const { ctx, subscription, reference } = await seed();
    await prisma.zeliChargeAttempt.create({
      data: {
        reference,
        tenantId: ctx.tenantId,
        subscriptionId: subscription.id,
        method: "mobile_money",
        amount: 99,
        currency: "GHS",
        state: "pending",
        requiredAction: "otp",
        correlationId: "corr-legacy-otp",
      },
    });
    const calls = mockProvider();

    await expect(
      payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    expect(calls).toHaveLength(0);
    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.requiredAction).toBe("otp");
    expect(attempt.state).toBe("pending");
  });

  it("reports the hosted action and URL to the billing screen", async () => {
    const { ctx, subscription } = await seed();
    mockProvider();
    await payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" });

    const overview = await getBillingOverview();
    expect(overview.payableAction?.requiredAction).toBe("checkout");
    expect(overview.payableAction?.checkoutUrl).toBe(CHECKOUT_URL);
    expect(overview.payableAction?.channel).toBe("mobile_money");
    expect(overview.payableAction?.displayText).toMatch(/checkout/i);
    expect(overview.checkoutChannels).toEqual(["mobile_money", "card"]);
  });
});

describe("hosted checkout reconciliation", () => {
  it("keeps a freshly abandoned checkout open and reusable", async () => {
    const { ctx, subscription, reference } = await seed();
    mockProvider();
    await payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" });

    const result = await reconcileZeliPayment(ctx as never, reference);
    expect(result.status).toBe("pending");
    expect(result.message).toMatch(/not completed|checkout/i);

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("pending");
    const row = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.paidAt).toBeNull();
  });

  it("closes an abandoned checkout after the protection window", async () => {
    const { ctx, subscription, reference } = await seed();
    mockProvider();
    await payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" });
    await prisma.zeliChargeAttempt.updateMany({
      data: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const result = await reconcileZeliPayment(ctx as never, reference);
    expect(result.status).toBe("failed");

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("failed");
    expect(attempt.requiredAction).toBeNull();
    expect(attempt.checkoutUrl).toBeNull();
    const row = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.paidAt).toBeNull();
  });

  it("activates on a verified successful return and records one platform notification/email", async () => {
    const { ctx, subscription, reference } = await seed();
    mockProvider({ verify: { status: "success", amountMinor: 9900 } });
    await payProvisionedSubscription(ctx as never, subscription.id, { method: "hosted" });

    const result = await confirmHostedCheckoutReturn(reference);
    expect(result.status).toBe("success");

    const row = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.status).toBe("active");
    expect(row.paidAt).not.toBeNull();
    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("succeeded");

    expect(await prisma.tenantNotification.count({ where: { audience: "platform" } })).toBe(1);
    expect(await prisma.platformEmailOutbox.count()).toBe(1);
    const outbox = await prisma.platformEmailOutbox.findFirstOrThrow();
    expect(outbox.recipient).toBe("bloomcoretechnologies@gmail.com");
    expect(outbox.status).toBe("pending");

    const replay = await confirmHostedCheckoutReturn(reference);
    expect(replay.status).toBe("success");
    expect(await prisma.platformEmailOutbox.count()).toBe(1);
    expect(await prisma.tenantNotification.count({ where: { audience: "platform" } })).toBe(1);
  });

  it("does not activate on a failed or amount-mismatched payment", async () => {
    const { subscription, reference } = await seed();
    mockProvider({ verify: { status: "success", amountMinor: 100 } });
    await prisma.zeliChargeAttempt.create({
      data: {
        reference,
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        method: "hosted",
        amount: 99,
        currency: "GHS",
        state: "pending",
        requiredAction: "checkout",
        checkoutUrl: CHECKOUT_URL,
        correlationId: "corr-hosted-mismatch",
      },
    });

    const result = await confirmHostedCheckoutReturn(reference);
    expect(result.status).not.toBe("success");

    const row = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.status).toBe("pending_payment");
    expect(row.paidAt).toBeNull();
  });

  it("deduplicates a webhook and a callback for the same payment", async () => {
    const { subscription, reference } = await seed();
    mockProvider({ verify: { status: "success", amountMinor: 9900 } });
    await prisma.zeliChargeAttempt.create({
      data: {
        reference,
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        method: "hosted",
        amount: 99,
        currency: "GHS",
        state: "pending",
        requiredAction: "checkout",
        checkoutUrl: CHECKOUT_URL,
        correlationId: "corr-hosted-webhook",
      },
    });
    const raw = JSON.stringify({
      event: "charge.success",
      data: { id: 771122, reference, amount: 9900, currency: "GHS", status: "success" },
    });

    const webhook = await handlePaystackWebhook(raw, signature(raw));
    expect(webhook.status).toBe(200);
    const returned = await confirmHostedCheckoutReturn(reference);
    expect(returned.status).toBe("success");

    const rows = await prisma.zeliSubscription.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(await prisma.platformEmailOutbox.count()).toBe(1);
    expect(await prisma.tenantNotification.count({ where: { audience: "platform" } })).toBe(1);
    expect(await prisma.zeliChargeAttempt.count()).toBe(1);
  });
});

describe("checkout tab safety", () => {
  function fakeTab(): CheckoutTab & { replaced: string[]; closeCalls: number } {
    const tab = {
      closed: false,
      opener: {} as unknown,
      replaced: [] as string[],
      closeCalls: 0,
      location: {
        replace(url: string) {
          tab.replaced.push(url);
        },
      },
      close() {
        tab.closeCalls += 1;
      },
    };
    return tab;
  }

  it("opens a blank tab and detaches the opener synchronously", () => {
    const tab = fakeTab();
    let opened: string | undefined;
    const result = openBlankCheckoutTab((url) => {
      opened = url;
      return tab;
    });
    expect(opened).toBe("");
    expect(result).toBe(tab);
    expect(tab.opener).toBeNull();
  });

  it("returns null when a popup blocker rejects the tab", () => {
    expect(openBlankCheckoutTab(() => null)).toBeNull();
  });

  it("navigates only to trusted Paystack URLs", () => {
    const tab = fakeTab();
    expect(navigateCheckoutTab(tab, "https://paystack.com.evil.test/pay")).toBe("untrusted");
    expect(tab.replaced).toHaveLength(0);
    expect(navigateCheckoutTab(tab, CHECKOUT_URL)).toBe("opened");
    expect(tab.replaced).toEqual([CHECKOUT_URL]);
  });

  it("reports a tab closed before navigation without creating anything", () => {
    const tab = fakeTab();
    tab.closed = true;
    expect(navigateCheckoutTab(tab, CHECKOUT_URL)).toBe("closed");
    expect(tab.replaced).toHaveLength(0);
  });

  it("only trusts HTTPS URLs on the approved checkout hosts", () => {
    expect(isTrustedCheckoutUrl(CHECKOUT_URL)).toBe(true);
    expect(isTrustedCheckoutUrl("http://checkout.paystack.com/pay")).toBe(false);
    expect(isTrustedCheckoutUrl("https://checkout.paystack.com@evil.test/pay")).toBe(false);
    expect(isTrustedCheckoutUrl(null)).toBe(false);
  });
});
