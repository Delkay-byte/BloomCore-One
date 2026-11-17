import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma, cleanDatabase } from "./setup";
import { handlePaystackWebhook } from "@/lib/payments/zeli-subscriptions";
import { verifyWebhookRequest } from "@/lib/payments/paystack";

const SECRET = "whsec_test_only_not_a_live_secret_value";

function signed(rawBody: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha512", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=key_1:${signature}`;
}

function pingBody(id = 991001) {
  return JSON.stringify({
    event: "ping",
    data: { id, domain: "test", status: "success" },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  vi.stubEnv("PAYSTACK_WEBHOOK_SIGNING_SECRET", SECRET);
  vi.stubEnv("PAYSTACK_WEBHOOK_SIGNING_SECRET_PREVIOUS", "");
  vi.stubEnv("PAYSTACK_SECRET_KEY", "");
});

describe("Paystack webhook ping", () => {
  it("verifies the signed ping, returns 200 and never creates a subscription", async () => {
    const raw = pingBody();
    const before = await prisma.zeliSubscription.count();
    const result = await handlePaystackWebhook(raw, null, signed(raw));
    expect(result).toEqual({ ok: true, status: 200, decision: "ping" });

    expect(await prisma.zeliSubscription.count()).toBe(before);
    const event = await prisma.zeliPaymentEvent.findFirst({ where: { eventType: "ping" } });
    expect(event?.decision).toBe("processed");
    expect(event?.reason).toBe("signed_ping");
  });

  it("rejects an invalid signature with 401 and records nothing", async () => {
    const raw = pingBody(991002);
    const result = await handlePaystackWebhook(raw, null, signed(raw, "whsec_wrong_secret_value"));
    expect(result).toEqual({ ok: false, status: 401, decision: "invalid_signature" });
    expect(await prisma.zeliPaymentEvent.count({ where: { eventType: "ping" } })).toBe(0);
  });

  it("rejects a missing signature", async () => {
    const raw = pingBody(991003);
    const result = await handlePaystackWebhook(raw, null, null);
    expect(result.status).toBe(401);
  });

  it("rejects a replayed timestamp outside the tolerance window", async () => {
    const raw = pingBody(991004);
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const result = await handlePaystackWebhook(raw, null, signed(raw, SECRET, oldTimestamp));
    expect(result.status).toBe(401);
    expect(verifyWebhookRequest(raw, { paystackSignature: signed(raw, SECRET, oldTimestamp) }).ok).toBe(false);
  });

  it("accepts the legacy signature when Paystack sends both headers and no signing secret is configured", async () => {
    const raw = pingBody(991006);
    const legacy = createHmac("sha512", SECRET).update(raw).digest("hex");
    vi.stubEnv("PAYSTACK_WEBHOOK_SIGNING_SECRET", "");
    vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
    const result = await handlePaystackWebhook(raw, legacy, signed(raw, "whsec_unrelated_key"));
    expect(result).toEqual({ ok: true, status: 200, decision: "ping" });
  });

  it("refuses a downgrade once a signing secret is configured", async () => {
    const raw = pingBody(991007);
    const key = "whsec_configured_signing_key_value";
    const legacy = createHmac("sha512", SECRET).update(raw).digest("hex");
    vi.stubEnv("PAYSTACK_WEBHOOK_SIGNING_SECRET", key);
    vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
    const result = await handlePaystackWebhook(raw, legacy, signed(raw, "whsec_wrong_key_value"));
    expect(result.status).toBe(401);
    expect(result.decision).toBe("invalid_signature");
  });

  it("acknowledges a duplicate ping idempotently", async () => {
    const raw = pingBody(991005);
    const first = await handlePaystackWebhook(raw, null, signed(raw));
    const second = await handlePaystackWebhook(raw, null, signed(raw));
    expect(first.decision).toBe("ping");
    expect(second.decision).toBe("ping");
    expect(second.status).toBe(200);
    expect(await prisma.zeliPaymentEvent.count({ where: { eventType: "ping" } })).toBe(1);
  });
});
