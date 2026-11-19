import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import type { TenantContext } from "@/lib/tenant";
import {
  submitZeliChargeOtp,
  startZeliMobileMoneyCharge,
  SubscriptionError,
} from "@/lib/payments/zeli-subscriptions";
import { deliverPendingPlatformEmails } from "@/lib/notifications/platform-payments";

/**
 * OTP completion and internal platform notifications.
 *
 * Every Paystack and Resend call is mocked. No real charge, code or email is
 * ever produced, and no test value is reused as a credential.
 */

const SECRET = "sk_test_otp_secret";
const DAY = 86_400_000;
const NOTIFY_TO = "platform-ops@example.com";

interface ProviderOptions {
  chargeStatus?: string;
  otpStatus?: string;
  otpHttpStatus?: number;
  otpMessage?: string;
  verifyStatus?: string;
  verifyAmountMinor?: number;
}

function mockProviders(options: ProviderOptions = {}) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });

    if (url.includes("/charge/submit_otp")) {
      if (options.otpHttpStatus && options.otpHttpStatus >= 400) {
        return new Response(
          JSON.stringify({ status: false, message: options.otpMessage ?? "Invalid OTP" }),
          { status: options.otpHttpStatus, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: true,
          message: "Charge attempted",
          data: {
            reference: body?.reference,
            status: options.otpStatus ?? "success",
            display_text: "Charge attempted",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/charge")) {
      return new Response(
        JSON.stringify({
          status: true,
          message: "Charge attempted",
          data: {
            reference: body?.reference,
            status: options.chargeStatus ?? "send_otp",
            display_text: "Enter the verification code Paystack sent to your phone",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/transaction/verify/")) {
      const reference = decodeURIComponent(url.split("/transaction/verify/")[1]);
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: 91234,
            status: options.verifyStatus ?? "success",
            reference,
            amount: options.verifyAmountMinor ?? 19_900,
            currency: "GHS",
            paid_at: new Date().toISOString(),
            metadata: "",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.startsWith("https://api.resend.com/emails")) {
      return new Response(JSON.stringify({ id: "email_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function seedPlan(price = 199) {
  return prisma.zeliPlan.create({
    data: {
      code: "zeli-monthly",
      name: "Zeli Monthly",
      billingInterval: "month",
      price,
      currency: "GHS",
      features: JSON.stringify(["Analytics"]),
      status: "active",
      isPublic: true,
    },
  });
}

async function contextFor(name = "OTP Billing Ltd"): Promise<TenantContext> {
  const tenant = await createTestTenant({ momo: true, susu: true, name });
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

async function openOtpAttempt(ctx: TenantContext): Promise<string> {
  await seedPlan();
  const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
    phone: "0551234987",
    provider: "mtn",
  });
  expect(charge.requiredAction).toBe("otp");
  return charge.reference;
}

beforeEach(async () => {
  await cleanDatabase();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://maacash.bloomcoretech.com");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PLATFORM_PAYMENT_NOTIFICATION_EMAIL", NOTIFY_TO);
});

describe("mobile money send_otp", () => {
  it("records the OTP instruction without storing any code", async () => {
    const ctx = await contextFor();
    mockProviders({ chargeStatus: "send_otp" });
    const reference = await openOtpAttempt(ctx);

    const attempt = await prisma.zeliChargeAttempt.findUniqueOrThrow({ where: { reference } });
    expect(attempt.state).toBe("pending");
    expect(attempt.requiredAction).toBe("otp");
    expect(attempt.reason).toMatch(/verification code/i);
    // The ledger keeps an instruction, never a secret.
    expect(attempt.reason).not.toMatch(/\d{4,10}/);
    const subscription = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: reference },
    });
    expect(subscription.paidAt).toBeNull();
  });

  it("refuses a code for a payment that is only waiting on a phone prompt", async () => {
    const ctx = await contextFor();
    await seedPlan();
    const { calls } = mockProviders({ chargeStatus: "pay_offline" });
    const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
      phone: "0551234987",
      provider: "mtn",
    });

    await expect(submitZeliChargeOtp(ctx, charge.reference, "123456")).rejects.toMatchObject({
      code: "otp_not_expected",
    });
    expect(calls.some((call) => call.url.includes("/charge/submit_otp"))).toBe(false);
  });

  it("rejects a malformed code before contacting the provider", async () => {
    const ctx = await contextFor();
    const { calls } = mockProviders();
    const reference = await openOtpAttempt(ctx);

    await expect(submitZeliChargeOtp(ctx, reference, "12ab")).rejects.toMatchObject({
      code: "invalid_otp",
    });
    expect(calls.some((call) => call.url.includes("/charge/submit_otp"))).toBe(false);
  });
});

describe("OTP submission", () => {
  it("verifies server-side, activates once and notifies the platform once", async () => {
    const ctx = await contextFor();
    const { calls } = mockProviders({ otpStatus: "success", verifyStatus: "success" });
    const reference = await openOtpAttempt(ctx);

    const result = await submitZeliChargeOtp(ctx, reference, "123456");
    expect(result.status).toBe("success");
    // The code is forwarded once and appears in no response.
    expect(JSON.stringify(result)).not.toContain("123456");
    const otpCall = calls.find((call) => call.url.includes("/charge/submit_otp"));
    expect(otpCall?.body).toEqual({ otp: "123456", reference });

    const subscription = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: reference },
    });
    expect(subscription.status).toBe("active");
    expect(subscription.paidAt).not.toBeNull();
    expect(subscription.periodEnd!.getTime()).toBeGreaterThan(Date.now() + 20 * DAY);

    const attempt = await prisma.zeliChargeAttempt.findUniqueOrThrow({ where: { reference } });
    expect(attempt.state).toBe("succeeded");
    expect(attempt.requiredAction).toBeNull();

    const notifications = await prisma.tenantNotification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].audience).toBe("platform");
    expect(notifications[0].tenantId).toBeNull();
    expect(notifications[0].href).toBe(`/platform/tenants/${ctx.tenantId}`);

    const queued = await prisma.platformEmailOutbox.findMany();
    expect(queued).toHaveLength(1);
    expect(queued[0].eventKey).toContain(reference);
    expect(queued[0].recipient).toBe(NOTIFY_TO);
    expect(queued[0].payload).toContain(ctx.tenantName);
    expect(queued[0].payload).not.toContain("123456");

    // A repeated submission or a replayed provider event cannot duplicate the
    // activation or either notification.
    const again = await submitZeliChargeOtp(ctx, reference, "123456");
    expect(again.status).toBe("success");
    expect(await prisma.tenantNotification.count()).toBe(1);
    expect(await prisma.platformEmailOutbox.count()).toBe(1);
  });

  it("keeps the form usable when Paystack rejects the code", async () => {
    const ctx = await contextFor();
    mockProviders({ otpHttpStatus: 400, otpMessage: "Invalid OTP" });
    const reference = await openOtpAttempt(ctx);

    await expect(submitZeliChargeOtp(ctx, reference, "999999")).rejects.toMatchObject({
      code: "otp_invalid",
    });

    const attempt = await prisma.zeliChargeAttempt.findUniqueOrThrow({ where: { reference } });
    expect(attempt.state).toBe("pending");
    expect(attempt.requiredAction).toBe("otp");
    const subscription = await prisma.zeliSubscription.findUniqueOrThrow({
      where: { providerReference: reference },
    });
    expect(subscription.paidAt).toBeNull();
    expect(await prisma.tenantNotification.count()).toBe(0);
  });

  it("asks for another code without creating a new payment", async () => {
    const ctx = await contextFor();
    const { calls } = mockProviders({ otpStatus: "send_otp" });
    const reference = await openOtpAttempt(ctx);

    const result = await submitZeliChargeOtp(ctx, reference, "123456");
    expect(result.status).toBe("requires_action");
    expect(result.requiredAction).toBe("otp");

    const attempt = await prisma.zeliChargeAttempt.findUniqueOrThrow({ where: { reference } });
    expect(attempt.state).toBe("pending");
    expect(attempt.requiredAction).toBe("otp");
    expect(attempt.attempts).toBe(1);
    expect(calls.filter((call) => call.url.endsWith("/charge"))).toHaveLength(1);
    expect(await prisma.zeliSubscription.count()).toBe(1);
  });

  it("marks an uncertain submission unresolved and never invites a retry", async () => {
    const ctx = await contextFor();
    mockProviders({ otpHttpStatus: 500, otpMessage: "Provider unavailable" });
    const reference = await openOtpAttempt(ctx);

    const error = await submitZeliChargeOtp(ctx, reference, "123456").catch((caught) => caught);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error.code).toBe("charge_unresolved");
    expect(error.message).toMatch(/do not pay again/i);

    const attempt = await prisma.zeliChargeAttempt.findUniqueOrThrow({ where: { reference } });
    expect(attempt.state).toBe("unresolved");
  });
});

describe("platform email outbox", () => {
  it("delivers once and is safe to retry", async () => {
    const ctx = await contextFor();
    mockProviders({ otpStatus: "success", verifyStatus: "success" });
    const reference = await openOtpAttempt(ctx);
    await submitZeliChargeOtp(ctx, reference, "123456");

    vi.stubEnv("EMAIL_TEST_FORCE_PROVIDER", "true");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "MaaCash Security <security@notifications.example.com>");

    const resend = vi.fn(async () =>
      new Response(JSON.stringify({ id: "email_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", resend);

    expect(await deliverPendingPlatformEmails()).toBe(1);
    expect(resend).toHaveBeenCalledTimes(1);
    const sent = await prisma.platformEmailOutbox.findFirstOrThrow();
    expect(sent.status).toBe("sent");
    expect(sent.attempts).toBe(1);

    // A second run finds nothing pending and sends nothing again.
    expect(await deliverPendingPlatformEmails()).toBe(0);
    expect(resend).toHaveBeenCalledTimes(1);

    const request = resend.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(String(request[1].body)) as Record<string, unknown>;
    expect(body.to).toEqual([NOTIFY_TO]);
    expect(String(body.html)).toContain(ctx.tenantName);
    expect(String(body.html)).toContain(reference);
  });
});

describe("webhook replay", () => {
  it("creates one notification for a repeated signed event", async () => {
    const ctx = await contextFor();
    await seedPlan();
    mockProviders({ chargeStatus: "pay_offline" });
    const charge = await startZeliMobileMoneyCharge(ctx, "zeli-monthly", {
      phone: "0551234987",
      provider: "mtn",
    });

    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 55001,
        reference: charge.reference,
        status: "success",
        amount: 19_900,
        currency: "GHS",
        paid_at: new Date().toISOString(),
      },
    });
    const signature = createHmac("sha512", SECRET).update(raw).digest("hex");

    const { handlePaystackWebhook } = await import("@/lib/payments/zeli-subscriptions");
    const first = await handlePaystackWebhook(raw, signature);
    expect(first.ok).toBe(true);
    const second = await handlePaystackWebhook(raw, signature);
    expect(second.ok).toBe(true);

    expect(await prisma.tenantNotification.count()).toBe(1);
    expect(await prisma.platformEmailOutbox.count()).toBe(1);
    expect(
      await prisma.zeliSubscription.count({
        where: { providerReference: charge.reference, status: "active" },
      })
    ).toBe(1);
  });
});
