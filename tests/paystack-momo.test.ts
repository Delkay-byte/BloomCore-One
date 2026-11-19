import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import type { TenantContext } from "@/lib/tenant";
import {
  chargeMobileMoney,
  paystackReadyForCheckout,
  verifyPaystackSignatureHeader,
  verifyWebhookRequest,
} from "@/lib/payments/paystack";
import {
  checkZeliMobileMoneyStatus,
  handlePaystackWebhook,
  startZeliMobileMoneyCharge,
} from "@/lib/payments/zeli-subscriptions";

/**
 * Ghana mobile money billing: signature contract, charge initiation, pending
 * handling, server-side verification and idempotent activation.
 *
 * Every provider call is mocked. No real charge is ever made from this suite.
 */

const SECRET = "sk_test_momo_secret";
const SIGNING_SECRET = "whsec_test_signing_secret";
const DAY = 86_400_000;

function legacySignature(raw: string, secret = SECRET): string {
  return createHmac("sha512", secret).update(raw).digest("hex");
}

function signatureHeader(
  raw: string,
  options: { secret?: string; timestamp?: number; kid?: string } = {}
): string {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const hex = createHmac("sha512", options.secret ?? SIGNING_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  return `t=${timestamp},v1=${options.kid ?? "whk_test"}:${hex}`;
}

interface VerifyDecision {
  status: string;
  amountMinor: number;
  currency?: string;
  id?: number;
}

/** Install a fetch mock that answers Paystack verify and charge calls. */
function mockPaystack(options: {
  charge?: { status: string; displayText?: string; message?: string };
  verify?: VerifyDecision | (() => never);
}) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.includes("/charge")) {
      return new Response(
        JSON.stringify({
          status: true,
          message: "Charge attempted",
          data: {
            reference: body?.reference,
            status: options.charge?.status ?? "pay_offline",
            display_text:
              options.charge?.displayText ??
              "Please complete authorization process on your mobile phone",
            message: options.charge?.message,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/transaction/verify/")) {
      if (typeof options.verify === "function") options.verify();
      const decision = options.verify as VerifyDecision;
      const reference = decodeURIComponent(url.split("/transaction/verify/")[1]);
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: decision?.id ?? 90210,
            status: decision?.status ?? "success",
            reference,
            amount: decision?.amountMinor ?? 19_900,
            currency: decision?.currency ?? "GHS",
            paid_at: new Date().toISOString(),
            metadata: "",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function seedPlan(price = 199, currency = "GHS") {
  return prisma.zeliPlan.create({
    data: {
      code: "zeli-monthly",
      name: "Zeli Monthly",
      billingInterval: "month",
      price,
      currency,
      features: JSON.stringify(["Analytics"]),
      status: "active",
      isPublic: true,
    },
  });
}

async function contextFor(): Promise<TenantContext> {
  const tenant = await createTestTenant({ momo: true, susu: true, name: "Momo Billing Ltd" });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: true });
  return {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    tenantName: tenant.name,
    momoEnabled: true,
    susuEnabled: true,
    userId: admin.id,
    role: "admin",
    modules: ["momo", "susu"],
  };
}

beforeEach(async () => {
  await cleanDatabase();
  vi.unstubAllGlobals();
  vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  vi.stubEnv("PAYSTACK_WEBHOOK_SIGNING_SECRET", SIGNING_SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://maacash.bloomcoretech.com");
  vi.stubEnv("NODE_ENV", "test");
});

describe("checkout availability", () => {
  it("requires a configured key and a live key in production", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    expect(paystackReadyForCheckout()).toBe(false);

    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_test_example");
    expect(paystackReadyForCheckout()).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    expect(paystackReadyForCheckout()).toBe(false);

    // An explicit test preview is allowed, and cannot take real money.
    vi.stubEnv("PAYSTACK_MODE", "test");
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_test_example");
    expect(paystackReadyForCheckout()).toBe(true);

    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    expect(paystackReadyForCheckout()).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("Paystack signature contract", () => {
  const raw = JSON.stringify({ event: "charge.success", data: { reference: "ref-1" } });

  it("accepts a valid Paystack-Signature header", () => {
    expect(verifyPaystackSignatureHeader(raw, signatureHeader(raw))).toBe(true);
  });

  it("accepts any matching v1 during secret rotation", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = signatureHeader(raw, { timestamp, kid: "whk_new" });
    const validLatest = valid.split(",")[1];
    const stale = `t=${timestamp},v1=whk_old:${"0".repeat(128)},${validLatest}`;
    expect(verifyPaystackSignatureHeader(raw, stale)).toBe(true);
  });

  it("rejects a signature older than five minutes", () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    expect(verifyPaystackSignatureHeader(raw, signatureHeader(raw, { timestamp: old }))).toBe(false);
  });

  it("rejects a tampered body or unknown secret", () => {
    const header = signatureHeader(raw);
    expect(verifyPaystackSignatureHeader(`${raw} `, header)).toBe(false);
    expect(
      verifyPaystackSignatureHeader(raw, signatureHeader(raw, { secret: "whsec_other" }))
    ).toBe(false);
  });

  it("prefers the new header and never rescues it with the legacy signature", () => {
    const decision = verifyWebhookRequest(raw, {
      paystackSignature: signatureHeader(raw, { secret: "whsec_wrong" }),
      legacySignature: legacySignature(raw),
    });
    expect(decision.ok).toBe(false);
    expect(decision.scheme).toBe("signature-header");
  });

  it("falls back to the legacy header only when the new one is absent", () => {
    expect(
      verifyWebhookRequest(raw, { paystackSignature: null, legacySignature: legacySignature(raw) })
    ).toEqual({ ok: true, scheme: "legacy" });
    expect(
      verifyWebhookRequest(raw, { paystackSignature: "", legacySignature: "deadbeef" }).ok
    ).toBe(false);
  });
});

describe("mobile money charge initiation", () => {
  it("sends GHS in minor units with the documented provider code", async () => {
    const calls = mockPaystack({});
    const charge = await chargeMobileMoney({
      email: "owner@example.com",
      amountSubunit: 19_900,
      currency: "GHS",
      phone: "0551234987",
      provider: "vod",
      reference: "ZELI-abc-123456",
      metadata: { plan_code: "zeli-monthly" },
    });
    expect(charge.status).toBe("pay_offline");
    expect(charge.displayText).toContain("authorization");
    const body = calls.find((call) => call.url.includes("/charge"))?.body as Record<string, unknown>;
    expect(body.amount).toBe("19900");
    expect(body.currency).toBe("GHS");
    expect(body.mobile_money).toEqual({ phone: "0551234987", provider: "vod" });
  });

  it("refuses a non-GHS currency, bad provider and malformed phone", async () => {
    mockPaystack({});
    await expect(
      chargeMobileMoney({
        email: "owner@example.com",
        amountSubunit: 100,
        currency: "NGN",
        phone: "0551234987",
        provider: "mtn",
        reference: "ZELI-abc-123456",
        metadata: {},
      })
    ).rejects.toThrow(/GHS/);
    await expect(
      chargeMobileMoney({
        email: "owner@example.com",
        amountSubunit: 100,
        currency: "GHS",
        phone: "0551234987",
        provider: "mpesa" as never,
        reference: "ZELI-abc-123456",
        metadata: {},
      })
    ).rejects.toThrow(/network/);
    await expect(
      chargeMobileMoney({
        email: "owner@example.com",
        amountSubunit: 100,
        currency: "GHS",
        phone: "12345",
        provider: "mtn",
        reference: "ZELI-abc-123456",
        metadata: {},
      })
    ).rejects.toThrow(/number/);
  });

  it("starts a pending subscription and returns only the prompt status", async () => {
    await seedPlan();
    const ctx = await contextFor();
    mockPaystack({ charge: { status: "pay_offline" } });

    const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
      phone: "+233551234987",
      provider: "mtn",
    });

    expect(charge.status).toBe("pay_offline");
    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: charge.reference },
    });
    expect(row.status).toBe("pending");
    expect(row.paidAt).toBeNull();
    expect(row.providerReference.startsWith("ZELIM-")).toBe(true);
  });

  it("marks the checkout failed when the provider declines the charge", async () => {
    await seedPlan();
    const ctx = await contextFor();
    mockPaystack({ charge: { status: "failed", message: "insufficient funds" } });

    await expect(
      startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
        phone: "0551234987",
        provider: "mtn",
      })
    ).rejects.toThrow(/declined/i);

    // The intent stays payable so the same reference can be retried after the
    // provider-declined charge; activation never happened.
    const rows = await prisma.zeliSubscription.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].paidAt).toBeNull();
    expect(rows[0].failureReason).toMatch(/declined/i);
    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("failed");
  });
});

describe("local live-payment guard", () => {
  it("refuses a live key outside an explicitly designated local test setup", async () => {
    await seedPlan();
    const ctx = await contextFor();
    const calls = mockPaystack({ charge: { status: "pay_offline" } });
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_local_guard_example");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("DATABASE_URL", "file:./tests-local.db");
    vi.stubEnv("PAYSTACK_LOCAL_LIVE_TEST", "true");
    vi.stubEnv("PAYSTACK_ENABLED", "true");
    vi.stubEnv("PAYSTACK_CURRENCY", "GHS");
    // A development process is required for the local live mode to be usable
    // at all, so the deeper guard is what refuses this attempt: the tenant is
    // not the designated one.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYSTACK_LOCAL_TEST_TENANT", "SOMEONE-ELSE");

    await expect(
      startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
        phone: "0551234987",
        provider: "mtn",
      })
    ).rejects.toThrow(/not enabled for this workspace/i);

    // The guard runs before the provider is contacted and before a payable
    // intent is stored, so nothing can be charged by a later retry.
    expect(calls).toHaveLength(0);
    expect(await prisma.zeliSubscription.count()).toBe(0);
  });
});

describe("mobile money settlement", () => {
  it("keeps a charge pending until the provider confirms success", async () => {
    await seedPlan();
    const ctx = await contextFor();
    mockPaystack({ charge: { status: "pay_offline" } });
    const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
      phone: "0551234987",
      provider: "atl",
    });

    mockPaystack({ verify: { status: "pending", amountMinor: 19_900 } });
    const pending = await checkZeliMobileMoneyStatus(ctx, charge.reference);
    expect(pending.status).toBe("pending");
    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: charge.reference },
    });
    expect(row.paidAt).toBeNull();
  });

  it("activates exactly once when the provider confirms success", async () => {
    await seedPlan();
    const ctx = await contextFor();
    mockPaystack({ charge: { status: "pay_offline" } });
    const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
      phone: "0551234987",
      provider: "mtn",
    });

    const calls = mockPaystack({ verify: { status: "success", amountMinor: 19_900 } });
    const first = await checkZeliMobileMoneyStatus(ctx, charge.reference);
    expect(first.status).toBe("success");

    const active = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: charge.reference },
    });
    expect(active.status).toBe("active");
    expect(active.periodEnd).not.toBeNull();

    const second = await checkZeliMobileMoneyStatus(ctx, charge.reference);
    expect(second.status).toBe("success");
    const afterSecond = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: charge.reference },
    });
    expect(afterSecond.periodEnd?.getTime()).toBe(active.periodEnd?.getTime());
    expect(calls.filter((call) => call.url.includes("/transaction/verify/")).length).toBe(1);
  });

  it("reports a failed authorisation without granting access", async () => {
    await seedPlan();
    const ctx = await contextFor();
    mockPaystack({ charge: { status: "pay_offline" } });
    const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
      phone: "0551234987",
      provider: "vod",
    });

    mockPaystack({ verify: { status: "failed", amountMinor: 19_900 } });
    const failed = await checkZeliMobileMoneyStatus(ctx, charge.reference);
    expect(failed.status).toBe("failed");
    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: charge.reference },
    });
    expect(row.status).toBe("pending");
    expect(row.paidAt).toBeNull();
  });

  it("refuses to check another tenant's reference", async () => {
    await seedPlan();
    const owner = await contextFor();
    mockPaystack({ charge: { status: "pay_offline" } });
    const charge = await startZeliMobileMoneyCharge(owner, "zeli-monthly", {
      phone: "0551234987",
      provider: "mtn",
    });

    const intruder = await contextFor();
    await expect(checkZeliMobileMoneyStatus(intruder, charge.reference)).rejects.toThrow(
      /not found/i
    );
  });
});

describe("webhook handling for mobile money", () => {
  async function startPending() {
    await seedPlan();
    const ctx = await contextFor();
    mockPaystack({ charge: { status: "pay_offline" } });
    const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
      phone: "0551234987",
      provider: "mtn",
    });
    return { ctx, charge };
  }

  it("verifies with Paystack before activating and is idempotent on redelivery", async () => {
    const { charge } = await startPending();
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 55501,
        reference: charge.reference,
        amount: 19_900,
        currency: "GHS",
        status: "success",
      },
    });
    mockPaystack({ verify: { status: "success", amountMinor: 19_900, id: 55501 } });

    const first = await handlePaystackWebhook(raw, legacySignature(raw));
    expect(first.status).toBe(200);
    expect(first.decision).toBe("processed");

    const second = await handlePaystackWebhook(raw, legacySignature(raw));
    expect(second.status).toBe(200);

    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: charge.reference },
    });
    expect(row.status).toBe("active");
    const events = await prisma.zeliPaymentEvent.count({
      where: { eventId: "paystack:charge.success:55501" },
    });
    expect(events).toBe(1);
  });

  it("accepts the new signed header", async () => {
    const { charge } = await startPending();
    const raw = JSON.stringify({
      event: "charge.success",
      data: { id: 55502, reference: charge.reference, amount: 19_900, currency: "GHS" },
    });
    mockPaystack({ verify: { status: "success", amountMinor: 19_900, id: 55502 } });
    const result = await handlePaystackWebhook(raw, null, signatureHeader(raw));
    expect(result.status).toBe(200);
  });

  it("rejects an unverified delivery with 401", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "nothing" } });
    const result = await handlePaystackWebhook(raw, "not-a-signature");
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
  });

  it("acknowledges a valid event for an unknown reference without granting anything", async () => {
    const raw = JSON.stringify({
      event: "charge.success",
      data: { id: 55503, reference: "ZELI-unknown-000000", amount: 100, currency: "GHS" },
    });
    const result = await handlePaystackWebhook(raw, legacySignature(raw));
    expect(result.status).toBe(200);
    expect(result.decision).toBe("ignored");
  });

  /**
   * A live charge started from a developer machine delivers its webhook to the
   * registered production endpoint, which has no subscription for that
   * reference. That event must be acknowledged and discarded: no tenant, no
   * entitlement, no financial record, no retry loop.
   */
  it("safely discards a local live-test reference delivered to production", async () => {
    await seedPlan();
    await contextFor();
    const before = {
      tenants: await prisma.businessTenant.count(),
      subscriptions: await prisma.zeliSubscription.count(),
      entitlements: await prisma.zeliEntitlement.count(),
      events: await prisma.zeliPaymentEvent.count(),
    };
    const reference = "ZELIM-locallive-7f3a91c2";
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 55601,
        reference,
        amount: 9900,
        currency: "GHS",
        status: "success",
        metadata: JSON.stringify({ plan_code: "starter", channel: "mobile_money" }),
      },
    });

    const result = await handlePaystackWebhook(raw, null, signatureHeader(raw));
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.decision).toBe("ignored");

    expect(await prisma.businessTenant.count()).toBe(before.tenants);
    expect(await prisma.zeliSubscription.count()).toBe(before.subscriptions);
    expect(await prisma.zeliEntitlement.count()).toBe(before.entitlements);
    const event = await prisma.zeliPaymentEvent.findFirst({ where: { reference } });
    expect(event?.decision).toBe("ignored");
    expect(event?.reason).toBe("unknown_reference");
    expect(event?.tenantId).toBeNull();
    expect(event?.subscriptionId).toBeNull();
  });
});
