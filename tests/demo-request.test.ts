import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const mocks = vi.hoisted(() => ({
  verifyTurnstile: vi.fn(),
  rateLimit: vi.fn(),
  notify: vi.fn(),
  email: vi.fn(),
}));

vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }));
vi.mock("@/lib/security/rate-limit", () => ({ consumeRateLimit: mocks.rateLimit }));
vi.mock("@/lib/notifications/notifications", () => ({ createNotification: mocks.notify }));
vi.mock("@/lib/email/resend", () => ({
  sendTransactionalEmail: mocks.email,
  appBaseUrl: () => "https://maacash.bloomcoretech.com",
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

import { submitAccountEnquiry } from "@/lib/actions/account-enquiry.actions";

const DEMO = {
  businessName: "Synthetic Demo Traders",
  contactName: "Ama Mensah",
  phone: "0244000000",
  locationCount: "2",
  interestedPlan: "Business",
  modules: "both",
  message: "We run MoMo and Susu in two shops.",
  kind: "demo" as const,
};

beforeEach(async () => {
  await cleanDatabase();
  mocks.verifyTurnstile.mockReset();
  mocks.rateLimit.mockReset();
  mocks.notify.mockReset();
  mocks.email.mockReset();
  mocks.rateLimit.mockResolvedValue({ allowed: true });
  mocks.verifyTurnstile.mockResolvedValue({ ok: true });
  mocks.notify.mockResolvedValue(undefined);
  mocks.email.mockResolvedValue({ ok: true });
  vi.unstubAllEnvs();
});

describe("public demonstration request", () => {
  it("stores a DEMO_REQUEST and notifies the platform", async () => {
    const result = await submitAccountEnquiry({ ...DEMO, turnstileToken: "token" });
    expect(result.success).toBe(true);
    expect(result.reference).toMatch(/^[A-Z0-9]{8}$/);

    const rows = await prisma.accountEnquiry.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].enquiryType).toBe("DEMO_REQUEST");
    expect(rows[0].source).toBe("public-contact");
    expect(rows[0].modules).toBe("both");
    expect(rows[0].locationCount).toBe(2);

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: "platform",
        title: expect.stringContaining("demonstration request"),
      })
    );
  });

  it("accepts a request without an email address", async () => {
    const result = await submitAccountEnquiry({
      ...DEMO,
      email: "",
      turnstileToken: "token",
    });
    expect(result.success).toBe(true);
    const row = await prisma.accountEnquiry.findFirstOrThrow();
    expect(row.email).toBeNull();
  });

  it("requires locations and the operations to manage", async () => {
    const noLocations = await submitAccountEnquiry({
      ...DEMO,
      locationCount: "",
      turnstileToken: "token",
    });
    expect(noLocations.success).toBe(false);
    expect(noLocations.error).toMatch(/locations/i);

    const noModules = await submitAccountEnquiry({
      ...DEMO,
      modules: "",
      turnstileToken: "token",
    });
    expect(noModules.success).toBe(false);
    expect(noModules.error).toMatch(/mobile money/i);
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("rejects an invalid phone number and a rejected challenge", async () => {
    const badPhone = await submitAccountEnquiry({
      ...DEMO,
      phone: "123",
      turnstileToken: "token",
    });
    expect(badPhone.success).toBe(false);

    mocks.verifyTurnstile.mockResolvedValue({ ok: false, reason: "rejected" });
    const rejected = await submitAccountEnquiry({ ...DEMO, turnstileToken: "token" });
    expect(rejected.success).toBe(false);
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("emails the owner and keeps the enquiry when email delivery fails", async () => {
    vi.stubEnv("PLATFORM_NOTIFICATION_EMAIL", "owner@example.com");
    mocks.email.mockResolvedValue({ ok: false, status: 500 });

    const result = await submitAccountEnquiry({ ...DEMO, turnstileToken: "token" });
    expect(result.success).toBe(true);
    expect(mocks.email).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@example.com" })
    );
    expect(await prisma.accountEnquiry.count()).toBe(1);
  });

  it("does not create a tenant, user or subscription", async () => {
    await submitAccountEnquiry({ ...DEMO, turnstileToken: "token" });
    expect(await prisma.businessTenant.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.zeliSubscription.count()).toBe(0);
  });

  it("keeps an account enquiry distinct from a demonstration request", async () => {
    await submitAccountEnquiry({
      businessName: "Account Traders",
      contactName: "Kojo Mensah",
      phone: "0244000010",
      email: "owner@account.example",
      kind: "account",
      turnstileToken: "token",
    });
    const row = await prisma.accountEnquiry.findFirstOrThrow();
    expect(row.enquiryType).toBe("ACCOUNT_REQUEST");
    expect(row.source).toBe("public-pricing");
  });
});
