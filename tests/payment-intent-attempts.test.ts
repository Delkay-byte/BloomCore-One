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

import {
  getBillingOverview,
  reconcileBillingPaymentAction,
  selectPackageAction,
  startBillingPaymentAction,
  type PlanChangeResult,
} from "@/lib/actions/billing.actions";
import {
  checkZeliMobileMoneyStatus,
  handlePaystackWebhook,
  payProvisionedSubscription,
  reconcileZeliPayment,
  startZeliMobileMoneyCharge,
  SubscriptionError,
} from "@/lib/payments/zeli-subscriptions";
import { sanitizeProviderMessage } from "@/lib/payments/paystack";
import { POST as payRoute } from "@/app/api/billing/pay/route";
import { NextRequest } from "next/server";

/**
 * Payment intent preservation, charge-attempt concurrency, provider error
 * classification and verification-only activation.
 *
 * Every provider call is mocked; no live Paystack request is made and no real
 * wallet is ever involved.
 */

const SECRET = "sk_test_attempt_guard";
const PHONE = "0551234987";

function legacySignature(raw: string): string {
  return createHmac("sha512", SECRET).update(raw).digest("hex");
}

interface FetchCall {
  url: string;
  body: Record<string, unknown> | null;
}

function mockProvider(options: {
  charge?:
    | { kind: "accepted"; status?: string; displayText?: string }
    | { kind: "rejected"; status?: number; message?: string }
    | { kind: "failed"; message?: string }
    | { kind: "throw"; error?: Error };
  verify?:
    | { status: string; amountMinor?: number; id?: number }
    | { error: true }
    | { notFound: true };
}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });

    if (url.includes("/charge") && !url.includes("/charge/")) {
      const charge = options.charge ?? { kind: "accepted" };
      if (charge.kind === "throw") throw charge.error ?? new Error("socket hang up");
      if (charge.kind === "rejected") {
        return new Response(
          JSON.stringify({
            status: false,
            message:
              charge.message ??
              "Invalid mobile money number 0551234987 for customer ada@example.com",
          }),
          { status: charge.status ?? 400, headers: { "content-type": "application/json" } }
        );
      }
      if (charge.kind === "failed") {
        return new Response(
          JSON.stringify({
            status: true,
            data: {
              reference: body?.reference,
              status: "failed",
              message: charge.message ?? "insufficient funds",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: true,
          message: "Charge attempted",
          data: {
            reference: body?.reference,
            status: charge.status ?? "pay_offline",
            display_text:
              charge.displayText ?? "Please complete authorization on your mobile phone",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (url.includes("/transaction/verify/")) {
      if (options.verify && "notFound" in options.verify) {
        return new Response(
          JSON.stringify({ status: false, message: "Transaction reference not found." }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      if (options.verify && "error" in options.verify) {
        return new Response(JSON.stringify({ status: false, message: "no" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const reference = decodeURIComponent(url.split("/transaction/verify/")[1]);
      const decision = options.verify ?? { status: "success", amountMinor: 9900 };
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: decision.id ?? 77123,
            status: decision.status,
            reference,
            amount: decision.amountMinor ?? 9900,
            currency: "GHS",
            paid_at: new Date().toISOString(),
            metadata: "",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function seedPlans() {
  await prisma.zeliPlan.create({
    data: {
      code: "starter",
      name: "Starter",
      billingInterval: "month",
      price: 99,
      currency: "GHS",
      features: JSON.stringify([]),
      status: "active",
      isPublic: true,
      usageAllowance: 250,
      locationLimit: 1,
      staffLimit: 3,
    },
  });
  await prisma.zeliPlan.create({
    data: {
      code: "business",
      name: "Business",
      billingInterval: "month",
      price: 169,
      currency: "GHS",
      features: JSON.stringify([]),
      status: "active",
      isPublic: true,
      usageAllowance: 600,
      locationLimit: 3,
      staffLimit: 10,
    },
  });
  await prisma.zeliPlan.create({
    data: {
      code: "starter-annual",
      name: "Starter Annual",
      billingInterval: "year",
      price: 1070,
      currency: "GHS",
      features: JSON.stringify([]),
      status: "active",
      isPublic: true,
      usageAllowance: 250,
      locationLimit: 1,
      staffLimit: 3,
    },
  });
}

async function seedTenant() {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Attempt Guard Ltd",
      contactEmail: "billing@attempt-guard.test",
      momoEnabled: true,
      susuEnabled: false,
      status: "PENDING_PAYMENT",
      onboardingStatus: "COMPLETED",
    },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `owner-${Date.now()}-${Math.random().toString(16).slice(2)}@attempt-guard.test`,
      fullName: "Attempt Guard Owner",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  const ctx = {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    tenantName: tenant.name,
    momoEnabled: true,
    susuEnabled: false,
    userId: admin.id,
    role: "admin",
    modules: ["momo"] as ("momo" | "susu")[],
  };
  ctxHolder.current = ctx;
  return { tenant, admin, ctx };
}

beforeEach(async () => {
  await cleanDatabase();
  vi.unstubAllGlobals();
  vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  vi.stubEnv("PAYSTACK_WEBHOOK_SIGNING_SECRET", "");
  vi.stubEnv("NEXTAUTH_URL", "https://maacash.bloomcoretech.com");
  vi.stubEnv("NODE_ENV", "test");
  await seedPlans();
});

describe("payment-intent preservation", () => {
  it("returns the same reference when the pending package is selected again", async () => {
    await seedTenant();
    const first = await selectPackageAction({ planCode: "starter" });
    expect(first.ok).toBe(true);
    const reference = first.reference!;

    const second = await selectPackageAction({ planCode: "starter" });
    expect(second.ok).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.reference).toBe(reference);
    expect(second.subscriptionId).toBe(first.subscriptionId);

    const pending = await prisma.zeliSubscription.findMany({
      where: { status: { in: ["pending", "pending_payment"] } },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].providerReference).toBe(reference);
  });

  it("never expires or recreates the intent when the billing page is reloaded", async () => {
    await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const before = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });

    await getBillingOverview();
    await getBillingOverview();

    const after = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(after.providerReference).toBe(before.providerReference);
    expect(after.status).toBe(before.status);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(await prisma.zeliSubscription.count()).toBe(1);
  });

  it("creates exactly one intent under concurrent selection of the same package", async () => {
    await seedTenant();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => selectPackageAction({ planCode: "starter" }))
    );
    const pending = await prisma.zeliSubscription.findMany({
      where: { status: { in: ["pending", "pending_payment"] } },
    });
    expect(pending).toHaveLength(1);
    const references = new Set(
      results.filter((r): r is PlanChangeResult & { ok: true } => r.ok).map((r) => r.reference)
    );
    expect(references.size).toBeLessThanOrEqual(1);
    for (const reference of references) expect(reference).toBe(pending[0].providerReference);
  });

  it("asks for confirmation before replacing a pending package and keeps it intact", async () => {
    await seedTenant();
    const starter = await selectPackageAction({ planCode: "starter" });

    const business = await selectPackageAction({ planCode: "business" });
    expect(business.ok).toBe(false);
    expect(business.needsConfirmation).toBe(true);
    expect(business.existing?.reference).toBe(starter.reference);

    const stillPending = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: starter.subscriptionId! },
    });
    expect(stillPending.status).toBe("pending_payment");
    expect(await prisma.zeliSubscription.count()).toBe(1);
  });

  it("replaces an unpaid intent only after explicit confirmation", async () => {
    await seedTenant();
    const starter = await selectPackageAction({ planCode: "starter" });

    const replaced = await selectPackageAction({ planCode: "business", confirmReplace: true });
    expect(replaced.ok).toBe(true);
    expect(replaced.reference).not.toBe(starter.reference);

    const old = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: starter.subscriptionId! },
    });
    expect(old.status).toBe("expired");
    expect(old.failureReason).toBe("Replaced by the owner before payment");
  });

  it("refuses to replace an intent whose charge is pending or unresolved", async () => {
    await seedTenant();
    const starter = await selectPackageAction({ planCode: "starter" });
    await prisma.zeliChargeAttempt.create({
      data: {
        reference: starter.reference!,
        tenantId: ctxHolder.current!.tenantId as string,
        subscriptionId: starter.subscriptionId!,
        method: "mobile_money",
        network: "mtn",
        amount: 99,
        currency: "GHS",
        state: "pending",
        correlationId: "corr-pending",
      },
    });

    const blocked = await selectPackageAction({ planCode: "business", confirmReplace: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/confirm|status/i);

    const old = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: starter.subscriptionId! },
    });
    expect(old.status).toBe("pending_payment");
  });
});

describe("charge initiation concurrency", () => {
  it("sends exactly one provider charge for ten concurrent requests", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const calls = mockProvider({ charge: { kind: "accepted" } });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
          method: "mobile_money",
          phone: PHONE,
          provider: "mtn",
        })
      )
    );

    const chargeCalls = calls.filter((call) => call.url.includes("/charge"));
    expect(chargeCalls).toHaveLength(1);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);

    const attempts = await prisma.zeliChargeAttempt.findMany();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe("pending");
    expect(attempts[0].attempts).toBe(1);
  });

  it("returns the existing attempt instead of charging again", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const calls = mockProvider({ charge: { kind: "accepted" } });

    await payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });
    const again = await payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });

    expect(again.status).toBe("pay_offline");
    expect(calls.filter((call) => call.url.includes("/charge"))).toHaveLength(1);
    expect(await prisma.zeliSubscription.count()).toBe(1);
  });

  it("keeps the intent payable after a definite provider rejection", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "rejected", status: 400 } });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_rejected" });

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("rejected");
    expect(attempt.providerHttpStatus).toBe(400);

    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(row.status).toBe("pending_payment");
    expect(row.paidAt).toBeNull();
    expect(row.providerReference).toBe(selected.reference);
  });

  it("treats a timeout as unresolved and refuses to charge again", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const calls = mockProvider({
      charge: { kind: "throw", error: Object.assign(new Error("aborted"), { name: "AbortError" }) },
    });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("unresolved");

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    expect(calls.filter((call) => call.url.includes("/charge"))).toHaveLength(1);
    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(row.paidAt).toBeNull();
    expect(row.status).toBe("pending_payment");
  });

  it("marks a provider-declined charge as failed without activating", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "failed" } });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_failed" });

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("failed");
    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(row.paidAt).toBeNull();
    expect(await prisma.zeliEntitlement.count()).toBe(0);
  });
});

describe("verification-only activation and reconciliation", () => {
  it("does not activate from an accepted charge prompt alone", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "accepted" } });

    await payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });

    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(row.paidAt).toBeNull();
    expect(row.status).toBe("pending_payment");
    expect(await prisma.zeliEntitlement.count()).toBe(0);
  });

  it("reconciles an unresolved attempt from verification without a new charge", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({
      charge: { kind: "rejected", status: 503, message: "Service Unavailable" },
    });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    const verifyCalls = mockProvider({ verify: { status: "success", amountMinor: 9900 } });
    const reconciled = await reconcileZeliPayment(ctx as never, selected.reference!);
    expect(reconciled.status).toBe("success");
    expect(verifyCalls.every((call) => !call.url.includes("/charge"))).toBe(true);

    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(row.status).toBe("active");
    expect(row.paidAt).not.toBeNull();
    expect(await prisma.zeliEntitlement.count()).toBe(1);

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("succeeded");

    // Re-running reconciliation is idempotent and does not extend the period.
    const paidAt = row.paidAt!.getTime();
    const again = await reconcileZeliPayment(ctx as never, selected.reference!);
    expect(again.status).toBe("success");
    const after = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(after.paidAt!.getTime()).toBe(paidAt);
    expect(await prisma.zeliEntitlement.count()).toBe(1);
  });

  it("reports pending when Paystack has no transaction yet", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "accepted" } });
    await payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });

    mockProvider({ verify: { error: true } });
    const result = await checkZeliMobileMoneyStatus(ctx as never, selected.reference!);
    expect(result.status).toBe("pending");
    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(row.paidAt).toBeNull();
  });

  it("activates exactly once when the same success webhook is delivered twice", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 88001,
        reference: selected.reference,
        amount: 9900,
        currency: "GHS",
        status: "success",
      },
    });

    const first = await handlePaystackWebhook(raw, legacySignature(raw));
    const second = await handlePaystackWebhook(raw, legacySignature(raw));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.decision).toBe("ignored");

    const rows = await prisma.zeliSubscription.findMany({ where: { tenantId: ctx.tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].paidAt).not.toBeNull();
  });
});

describe("server-derived payment details", () => {
  it("converts GH₵99.00 to 9900 pesewas and maps every network", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });

    for (const provider of ["mtn", "atl", "vod"] as const) {
      await prisma.zeliChargeAttempt.deleteMany();
      const calls = mockProvider({ charge: { kind: "accepted" } });
      await payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider,
      });
      const charge = calls.find((call) => call.url.includes("/charge"));
      expect(charge?.body?.amount).toBe("9900");
      expect(charge?.body?.currency).toBe("GHS");
      expect((charge?.body?.mobile_money as { provider?: string })?.provider).toBe(provider);
    }
  });

  it("refuses a subscription that belongs to another tenant", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const other = await seedTenant();
    const calls = mockProvider({ charge: { kind: "accepted" } });

    await expect(
      payProvisionedSubscription(other.ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "not_payable" });

    expect(calls).toHaveLength(0);
    ctxHolder.current = ctx;
  });
});

describe("provider error sanitisation", () => {
  it("strips phone numbers, emails and key-shaped values", () => {
    const sanitized = sanitizeProviderMessage(
      "Invalid 0551234987 for ada@example.com using sk_live_abcdef123 and +233551234987"
    );
    expect(sanitized).not.toMatch(/0551234987/);
    expect(sanitized).not.toMatch(/233551234987/);
    expect(sanitized).not.toMatch(/ada@example\.com/);
    expect(sanitized).not.toMatch(/sk_live_/);
    expect(sanitized).toContain("[phone]");
    expect(sanitized).toContain("[email]");
  });

  it("never persists the wallet number or email in an attempt reason", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({
      charge: {
        kind: "rejected",
        status: 400,
        message: `Invalid wallet ${PHONE} for owner@attempt-guard.test`,
      },
    });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toBeInstanceOf(SubscriptionError);

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    const stored = JSON.stringify(attempt);
    expect(stored).not.toContain(PHONE);
    expect(stored).not.toContain("owner@attempt-guard.test");
  });
});

describe("payment route hardening", () => {
  it("rejects a cross-origin payment request before any provider call", async () => {
    await seedTenant();
    const calls = mockProvider({ charge: { kind: "accepted" } });
    const request = new NextRequest("https://maacash.bloomcoretech.com/api/billing/pay", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ subscriptionId: "x", method: "mobile_money", phone: PHONE, provider: "mtn" }),
    });

    const response = await payRoute(request);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unauthenticated payment request", async () => {
    ctxHolder.current = null;
    const calls = mockProvider({ charge: { kind: "accepted" } });
    const request = new NextRequest("https://maacash.bloomcoretech.com/api/billing/pay", {
      method: "POST",
      headers: { origin: "https://maacash.bloomcoretech.com", "content-type": "application/json" },
      body: JSON.stringify({ subscriptionId: "x", method: "mobile_money", phone: PHONE, provider: "mtn" }),
    });

    const response = await payRoute(request);
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("action-level result states", () => {
  it("marks an unresolved attempt so the UI does not invite a retry", async () => {
    await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "throw" } });

    const result = await startBillingPaymentAction({
      subscriptionId: selected.subscriptionId!,
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("unresolved");
  });

  it("exposes reconciliation through the action without charging", async () => {
    await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "throw" } });
    await startBillingPaymentAction({
      subscriptionId: selected.subscriptionId!,
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });

    const calls = mockProvider({ verify: { status: "success", amountMinor: 9900 } });
    const result = await reconcileBillingPaymentAction(selected.reference!);
    expect(result.status).toBe("success");
    expect(calls.some((call) => call.url.includes("/charge"))).toBe(false);
  });

  it("creates a new intent only when the online flow needs one", async () => {
    const { ctx } = await seedTenant();
    mockProvider({ charge: { kind: "accepted" } });
    const first = await startZeliMobileMoneyCharge(ctx as never, "starter", {
      phone: PHONE,
      provider: "mtn",
    });
    const second = await startZeliMobileMoneyCharge(ctx as never, "starter", {
      phone: PHONE,
      provider: "mtn",
    });
    expect(second.reference).toBe(first.reference);
    expect(await prisma.zeliSubscription.count()).toBe(1);
  });
});

describe("duplicate-reference and failed-charge lifecycle", () => {
  it("treats a 409 duplicate-reference answer as reconciliation-required, never a retry", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const calls = mockProvider({
      charge: { kind: "rejected", status: 409, message: "Duplicate transaction reference" },
    });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    const attempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(attempt.state).toBe("unresolved");
    expect(attempt.providerHttpStatus).toBe(409);

    // A second request must not reach Paystack again.
    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    expect(calls.filter((call) => call.url.includes("/charge"))).toHaveLength(1);
    const row = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { id: selected.subscriptionId! },
    });
    expect(row.paidAt).toBeNull();
  });

  it("treats duplicate wording on a 400 as reconciliation-required", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    const calls = mockProvider({
      charge: { kind: "rejected", status: 400, message: "Transaction reference has already been used" },
    });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_unresolved" });

    expect((await prisma.zeliChargeAttempt.findFirstOrThrow()).state).toBe("unresolved");
    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_unresolved" });
    expect(calls.filter((call) => call.url.includes("/charge"))).toHaveLength(1);
  });

  it("retries a definite rejection on the same reference only after proving no transaction exists", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "rejected", status: 400, message: "Invalid mobile money number" } });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_rejected" });

    const calls = mockProvider({
      verify: { notFound: true },
      charge: { kind: "accepted" },
    });
    const retried = await payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });

    expect(retried.reference).toBe(selected.reference);
    expect(calls.some((call) => call.url.includes("/transaction/verify/"))).toBe(true);
    expect(calls.filter((call) => call.url.includes("/charge"))).toHaveLength(1);

    const attempts = await prisma.zeliChargeAttempt.findMany({ orderBy: { createdAt: "asc" } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe("pending");
    expect(attempts[0].attempts).toBe(2);
  });

  it("starts a fresh charge after a confirmed decline without duplicating the subscription", async () => {
    const { ctx } = await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    mockProvider({ charge: { kind: "failed" } });

    await expect(
      payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
        method: "mobile_money",
        phone: PHONE,
        provider: "mtn",
      })
    ).rejects.toMatchObject({ code: "charge_failed" });

    const failedAttempt = await prisma.zeliChargeAttempt.findFirstOrThrow();
    expect(failedAttempt.state).toBe("failed");
    expect(failedAttempt.reference).toBe(selected.reference);

    const calls = mockProvider({ charge: { kind: "accepted" } });
    const retried = await payProvisionedSubscription(ctx as never, selected.subscriptionId!, {
      method: "mobile_money",
      phone: PHONE,
      provider: "mtn",
    });

    expect(retried.reference).not.toBe(selected.reference);
    expect(calls.filter((call) => call.url.includes("/charge"))).toHaveLength(1);

    // Same unpaid subscription, new reference, both attempts kept as history.
    const subscriptions = await prisma.zeliSubscription.findMany({
      where: { tenantId: ctx.tenantId },
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].id).toBe(selected.subscriptionId);
    expect(subscriptions[0].providerReference).toBe(retried.reference);
    expect(Number(subscriptions[0].amount)).toBe(99);
    expect(subscriptions[0].paidAt).toBeNull();
    expect(subscriptions[0].status).toBe("pending_payment");

    const attempts = await prisma.zeliChargeAttempt.findMany({ orderBy: { createdAt: "asc" } });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].reference).toBe(selected.reference);
    expect(attempts[0].state).toBe("failed");
    expect(attempts[1].reference).toBe(retried.reference);
    expect(attempts[1].state).toBe("pending");
  });

  it("allows replacing a package after a failed attempt instead of blocking it", async () => {
    await seedTenant();
    const selected = await selectPackageAction({ planCode: "starter" });
    await prisma.zeliChargeAttempt.create({
      data: {
        reference: selected.reference!,
        tenantId: ctxHolder.current!.tenantId as string,
        subscriptionId: selected.subscriptionId!,
        method: "mobile_money",
        network: "mtn",
        amount: 99,
        currency: "GHS",
        state: "failed",
        correlationId: "corr-failed",
      },
    });

    const confirmation = await selectPackageAction({ planCode: "business" });
    expect(confirmation.needsConfirmation).toBe(true);
    const replaced = await selectPackageAction({ planCode: "business", confirmReplace: true });
    expect(replaced.ok).toBe(true);
  });
});
