import { describe, expect, it } from "vitest";
import type {
  EffectiveProviderPolicy,
  ProviderControlRecord,
} from "@/lib/zeli/provider-control";
import { providerPolicyHeaders } from "@/lib/zeli/provider-status";

const CONTROL: ProviderControlRecord = {
  mode: "disabled",
  enabled: false,
  emergencyDisabled: false,
  approvedProvider: "deepseek",
  approvedPurposes: null,
  policyVersion: "2026-11.2",
  approvalReference: null,
  reason: null,
  updatedById: null,
  updatedAt: new Date(0),
};

function policy(overrides: Partial<EffectiveProviderPolicy>): EffectiveProviderPolicy {
  return {
    state: "disabled",
    allowed: false,
    provider: "deepseek",
    model: "deepseek-flash",
    reason: "External AI is disabled.",
    syntheticOnly: false,
    productionApproved: false,
    emergencyDisabled: false,
    control: CONTROL,
    credentialConfigured: true,
    codeApprovalPresent: false,
    privacyVersionPresent: false,
    approvalReferencePresent: false,
    tenantAuthorized: false,
    ...overrides,
  };
}

describe("external AI status header", () => {
  it("reports disabled when the emergency stop is active", () => {
    const headers = providerPolicyHeaders(
      policy({
        state: "disabled",
        allowed: false,
        emergencyDisabled: true,
        reason: "External AI is stopped by the global emergency disable control.",
      })
    );
    expect(headers["x-zeli-external-ai"]).toBe("disabled");
    expect(headers["x-zeli-external-ai-allowed"]).toBe("false");
  });

  it("reports disabled for a deliberately disabled provider", () => {
    const headers = providerPolicyHeaders(
      policy({ state: "disabled", allowed: false, control: { ...CONTROL, enabled: false } })
    );
    expect(headers["x-zeli-external-ai"]).toBe("disabled");
  });

  it("reports disabled when no credential is configured", () => {
    const headers = providerPolicyHeaders(
      policy({ state: "disabled", allowed: false, credentialConfigured: false })
    );
    expect(headers["x-zeli-external-ai"]).toBe("disabled");
  });

  it("reports synthetic when synthetic testing is allowed", () => {
    const headers = providerPolicyHeaders(
      policy({ state: "synthetic", allowed: true, syntheticOnly: true })
    );
    expect(headers["x-zeli-external-ai"]).toBe("synthetic");
    expect(headers["x-zeli-external-ai-allowed"]).toBe("true");
  });

  it("reports disabled when synthetic mode is blocked by the environment", () => {
    const headers = providerPolicyHeaders(
      policy({
        state: "disabled",
        allowed: false,
        syntheticOnly: true,
        reason: "Synthetic provider testing is not enabled in this environment.",
      })
    );
    expect(headers["x-zeli-external-ai"]).toBe("disabled");
  });

  it("reports disabled when approved production processing is locked", () => {
    const headers = providerPolicyHeaders(
      policy({
        state: "disabled",
        allowed: false,
        productionApproved: false,
        reason: "Aggregate production processing is locked: missing reviewed code approval.",
      })
    );
    expect(headers["x-zeli-external-ai"]).toBe("disabled");
  });

  it("reports approved only when every approval is present", () => {
    const headers = providerPolicyHeaders(
      policy({
        state: "approved",
        allowed: true,
        productionApproved: true,
        codeApprovalPresent: true,
        privacyVersionPresent: true,
        approvalReferencePresent: true,
        tenantAuthorized: true,
      })
    );
    expect(headers["x-zeli-external-ai"]).toBe("approved");
    expect(headers["x-zeli-external-ai-allowed"]).toBe("true");
  });

  it("never exposes credentials, approval references or private configuration", () => {
    const headers = providerPolicyHeaders(
      policy({
        state: "disabled",
        allowed: false,
        reason: "Missing approval reference DPC-SECRET-REFERENCE and key sk-live-secret.",
        credentialConfigured: true,
        control: {
          ...CONTROL,
          approvalReference: "DPC-SECRET-REFERENCE",
          reason: "Internal owner note that must stay private.",
        },
      })
    );
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("DPC-SECRET-REFERENCE");
    expect(serialized).not.toContain("Internal owner note");
    expect(Object.keys(headers).sort()).toEqual([
      "x-zeli-external-ai",
      "x-zeli-external-ai-allowed",
    ]);
  });
});
