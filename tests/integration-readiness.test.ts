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
  it("reports no delivering adapter and no configured provider", () => {
    const rows = getIntegrationReadiness();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => row.delivers === false)).toBe(true);
    expect(rows.every((row) => row.status === "sandbox" || row.status === "unavailable")).toBe(true);
    expect(rows.map((row) => row.id)).toEqual([
      "whatsapp",
      "sms",
      "mtn",
      "telecel",
      "at_money",
      "banking",
      "accounting",
      "identity_verification",
      "provider_payment_status",
    ]);
  });

  it("marks unbuilt integrations as coming soon and never marks WhatsApp", () => {
    const rows = getIntegrationReadiness();
    const marked = rows.filter((row) => row.comingSoon).map((row) => row.id);
    expect(marked).toEqual([
      "sms",
      "mtn",
      "telecel",
      "at_money",
      "banking",
      "accounting",
      "identity_verification",
      "provider_payment_status",
    ]);
    // The owner is building WhatsApp, so it must not be labelled unavailable.
    expect(marked).not.toContain("whatsapp");
    expect(rows.find((row) => row.id === "whatsapp")?.comingSoon).toBe(false);
    // A delivering adapter never carries the marker either.
    expect(rows.every((row) => !(row.delivers && row.comingSoon))).toBe(true);
  });

  it("keeps messaging in sandbox and never reports a sent message", async () => {
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
