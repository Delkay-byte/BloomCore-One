import { describe, expect, it } from "vitest";
import {
  getIntegrationReadiness,
  type IntegrationReadinessStatus,
} from "@/lib/integrations/readiness";

const ALLOWED: IntegrationReadinessStatus[] = [
  "available",
  "sandbox",
  "not_configured",
  "unavailable",
  "coming_soon",
  "manual_process",
  "requires_owner_setup",
];

describe("provider capability disclosures", () => {
  const integrations = getIntegrationReadiness();

  it("gives every capability exactly one approved status", () => {
    expect(integrations.length).toBeGreaterThan(0);
    for (const integration of integrations) {
      expect(ALLOWED).toContain(integration.status);
      expect(integration).not.toHaveProperty("comingSoon");
      expect(integration.requiredApprovals.length).toBeGreaterThan(0);
    }
  });

  it("never claims a telco, bank, accounting or identity provider is connected", () => {
    for (const id of ["mtn", "telecel", "at_money", "banking", "identity_verification"]) {
      const integration = integrations.find((row) => row.id === id);
      expect(integration?.status).toBe("unavailable");
      expect(integration?.delivers).toBe(false);
    }
    const accounting = integrations.find((row) => row.id === "accounting");
    expect(accounting?.status).toBe("manual_process");
    expect(accounting?.delivers).toBe(false);
  });

  it("keeps WhatsApp setup and delivery states separate", () => {
    const whatsapp = integrations.find((row) => row.id === "whatsapp");
    expect(["sandbox", "not_configured", "requires_owner_setup"]).toContain(
      whatsapp?.status
    );
    if (whatsapp?.status !== "sandbox") {
      expect(whatsapp?.delivers).toBe(false);
      expect(whatsapp?.detail).toMatch(/nothing (?:is )?(?:transmitted|leaves)/i);
    }
  });

  it("does not describe an unavailable capability as planned and usable", () => {
    for (const integration of integrations) {
      if (integration.status === "unavailable") {
        expect(integration.delivers).toBe(false);
        expect(integration.detail).not.toMatch(/is now available|connected and confirmed/i);
      }
    }
  });
});
