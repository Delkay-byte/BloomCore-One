import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { verifyTurnstileMock, rateLimitMock } = vi.hoisted(() => ({
  verifyTurnstileMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: verifyTurnstileMock }));
vi.mock("@/lib/security/rate-limit", () => ({ consumeRateLimit: rateLimitMock }));
vi.mock("@/lib/security/log", () => ({ logSecurityEvent: () => {} }));
vi.mock("@/lib/email/resend", () => ({
  sendTransactionalEmail: async () => ({ ok: true }),
  appBaseUrl: () => "http://localhost:3000",
}));

import { submitAccountEnquiry } from "@/lib/actions/account-enquiry.actions";

const VALID = {
  businessName: "Synthetic Traders",
  contactName: "Ama Mensah",
  phone: "0244000000",
  email: "synthetic@example.com",
  locationCount: "2",
  interestedPlan: "Business",
  message: "Automated test enquiry.",
};

beforeEach(async () => {
  await cleanDatabase();
  verifyTurnstileMock.mockReset();
  rateLimitMock.mockReset();
  rateLimitMock.mockResolvedValue({ allowed: true });
  verifyTurnstileMock.mockResolvedValue({ ok: true });
});

describe("public account enquiry with Turnstile", () => {
  it("stores exactly one enquiry for a valid challenge and returns its reference", async () => {
    const result = await submitAccountEnquiry({ ...VALID, turnstileToken: "valid-token" });

    expect(result.success).toBe(true);
    expect(result.reference).toMatch(/^[A-Z0-9]{8}$/);
    const rows = await prisma.accountEnquiry.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].businessName).toBe(VALID.businessName);
    expect(rows[0].status).toBe("new");
    expect(result.reference).toBe(rows[0].id.slice(-8).toUpperCase());

    // The token is verified for the account-enquiry action, never another one.
    expect(verifyTurnstileMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: "valid-token", action: "account_enquiry" })
    );
  });

  it("creates nothing when the challenge is missing", async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: "missing" });
    const result = await submitAccountEnquiry({ ...VALID, turnstileToken: null });

    expect(result.success).toBe(false);
    expect(result.error).toContain("could not verify");
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("creates nothing when Cloudflare rejects the token", async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: "rejected", errorCodes: ["invalid-input-response"] });
    const result = await submitAccountEnquiry({ ...VALID, turnstileToken: "forged" });

    expect(result.success).toBe(false);
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("asks for a fresh challenge when a spent token is replayed", async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: "replay", errorCodes: ["timeout-or-duplicate"] });
    const result = await submitAccountEnquiry({ ...VALID, turnstileToken: "used" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("again");
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("asks for a fresh challenge when the challenge expired", async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: "expired" });
    const result = await submitAccountEnquiry({ ...VALID, turnstileToken: "old" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("again");
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("does not duplicate an enquiry when the same details are submitted twice", async () => {
    const first = await submitAccountEnquiry({ ...VALID, turnstileToken: "token-1" });
    const second = await submitAccountEnquiry({ ...VALID, turnstileToken: "token-2" });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.reference).toBe(first.reference);
    expect(await prisma.accountEnquiry.count()).toBe(1);
    expect(verifyTurnstileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the per-IP rate limit ahead of verification", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false });
    const result = await submitAccountEnquiry({ ...VALID, turnstileToken: "valid-token" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Too many enquiries");
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("rejects invalid input before spending a challenge", async () => {
    const result = await submitAccountEnquiry({
      ...VALID,
      phone: "123",
      turnstileToken: "valid-token",
    });

    expect(result.success).toBe(false);
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("requires the email address the owner will sign in with", async () => {
    const missing = await submitAccountEnquiry({
      ...VALID,
      email: "",
      turnstileToken: "valid-token",
    });
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/sign in with/i);
    expect(verifyTurnstileMock).not.toHaveBeenCalled();

    const malformed = await submitAccountEnquiry({
      ...VALID,
      email: "not-an-email",
      turnstileToken: "valid-token",
    });
    expect(malformed.success).toBe(false);
    expect(malformed.error).toMatch(/valid email/i);
    expect(await prisma.accountEnquiry.count()).toBe(0);
  });

  it("never creates a tenant, user or subscription", async () => {
    await submitAccountEnquiry({ ...VALID, turnstileToken: "valid-token" });
    const [tenants, users, subscriptions] = await Promise.all([
      prisma.businessTenant.count(),
      prisma.user.count(),
      prisma.zeliSubscription.count(),
    ]);
    expect(tenants).toBe(0);
    expect(users).toBe(0);
    expect(subscriptions).toBe(0);
  });
});
