/**
 * External integration readiness — every adapter must be non-delivering and
 * must never claim provider confirmation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UnavailableTelcoProvider,
  getIntegrationReadiness,
  getTelcoProvider,
} from "@/lib/integrations/readiness";
import {
  MockMessageProvider,
  getMessageProvider,
} from "@/lib/messaging/provider";

describe("telco provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns unavailable and never claims provider confirmation", async () => {
    const result = await new UnavailableTelcoProvider().lookupTransaction(
      "  MP-REF-1001  "
    );
    expect(result.status).toBe("unavailable");
    expect(result.providerConfirmed).toBe(false);
    expect(result.providerId).toBe("unconfigured");
    expect(result.reference).toBe("MP-REF-1001");
  });

  it("does not open a network connection", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("external network is not allowed");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = getTelcoProvider();
    const result = await provider.lookupTransaction("MP-REF-1002");
    expect(result.status).toBe("unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("integration readiness", () => {
  const ALL_IDS = [
    "whatsapp",
    "sms",
    "mtn",
    "telecel",
    "at_money",
    "banking",
    "accounting",
    "identity_verification",
    "provider_payment_status",
  ];

  const VALID_STATUSES = new Set([
    "available",
    "sandbox",
    "not_configured",
    "unavailable",
    "coming_soon",
    "manual_process",
    "requires_owner_setup",
  ]);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function withUnconfiguredProviders() {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "");
    vi.stubEnv("WHATSAPP_DELIVERY_ENABLED", "");
    vi.stubEnv("SMS_PROVIDER", "");
  }

  it("reports no delivering adapter in an unconfigured deployment", () => {
    withUnconfiguredProviders();
    const rows = getIntegrationReadiness();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.map((row) => row.id)).toEqual(ALL_IDS);
    expect(rows.every((row) => row.delivers === false)).toBe(true);
  });

  it("uses exactly one defined status per capability", () => {
    withUnconfiguredProviders();
    const rows = getIntegrationReadiness();
    expect(rows.every((row) => VALID_STATUSES.has(row.status))).toBe(true);
  });

  it("reflects the actual deployment configuration", () => {
    withUnconfiguredProviders();
    const rows = Object.fromEntries(
      getIntegrationReadiness().map((row) => [row.id, row])
    );
    // No WhatsApp credentials in this deployment: the capability exists in
    // code and the owner must supply them, so it is owner setup, not
    // "unavailable" (which would deny the capability exists).
    expect(rows.whatsapp.status).toBe("requires_owner_setup");
    // No SMS provider has been selected: queued and validated only.
    expect(rows.sms.status).toBe("not_configured");
    // Telco, banking and identity providers have no approved contract.
    expect(rows.mtn.status).toBe("unavailable");
    expect(rows.telecel.status).toBe("unavailable");
    expect(rows.at_money.status).toBe("unavailable");
    expect(rows.banking.status).toBe("unavailable");
    expect(rows.identity_verification.status).toBe("unavailable");
    // Paystack bills MaaCash subscriptions only; it never confirms customers.
    expect(rows.provider_payment_status.status).toBe("unavailable");
    // CSV export/import is a real, supported manual workflow.
    expect(rows.accounting.status).toBe("manual_process");
  });

  it("never labels credentials-with-delivery-disabled as not configured", () => {
    withUnconfiguredProviders();
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "token-present");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "phone-present");
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "waba-present");
    vi.stubEnv("WHATSAPP_DELIVERY_ENABLED", "false");
    const whatsapp = getIntegrationReadiness().find((row) => row.id === "whatsapp");
    expect(whatsapp?.status).toBe("unavailable");
    expect(whatsapp?.delivers).toBe(false);
    expect(whatsapp?.detail).toContain("delivery is disabled");
  });

  it("marks an allowlisted delivery path as sandbox, never as production", () => {
    withUnconfiguredProviders();
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "token-present");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "phone-present");
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "waba-present");
    vi.stubEnv("WHATSAPP_DELIVERY_ENABLED", "true");
    const whatsapp = getIntegrationReadiness().find((row) => row.id === "whatsapp");
    expect(whatsapp?.status).toBe("sandbox");
    expect(whatsapp?.delivers).toBe(true);
    // Sandbox must state its own limits; it must not read as generally live.
    expect(whatsapp?.detail).toContain("allowlisted");
  });

  it("never claims provider confirmation for an operator-recorded capability", () => {
    withUnconfiguredProviders();
    const rows = getIntegrationReadiness();
    for (const row of rows) {
      if (row.status === "unavailable" || row.status === "manual_process") {
        expect(row.delivers).toBe(false);
        expect(row.detail).not.toMatch(/confirmed (?:by|with) (?:the )?provider/i);
      }
    }
    const paystack = rows.find((row) => row.id === "provider_payment_status");
    expect(paystack?.detail).toContain("subscription billing only");
  });

  it("keeps the messaging provider non-delivering and never reports a sent message", async () => {
    const provider = getMessageProvider();
    expect(provider.id).toBe("mock");
    expect(provider.delivers).toBe(false);
    const result = await provider.send({
      channel: "sms",
      to: "+233200000901",
      body: "Receipt E2E-S-001: GH₵350.00 received.",
      purpose: "receipt",
      reference: "E2E-S-001",
    });
    expect(result.status).toBe("simulated");
    expect(result.providerMessageId).toBeNull();
    expect(provider).toBeInstanceOf(MockMessageProvider);
  });

  it("does not expose provider credentials or environment secrets", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_live_should_never_render";
    process.env.PLATFORM_OIDC_CLIENT_SECRET = "oidc-secret-never-render";
    try {
      const serialized = JSON.stringify(getIntegrationReadiness());
      expect(serialized).not.toContain("sk_live_should_never_render");
      expect(serialized).not.toContain("oidc-secret-never-render");
    } finally {
      delete process.env.PAYSTACK_SECRET_KEY;
      delete process.env.PLATFORM_OIDC_CLIENT_SECRET;
    }
  });
});
