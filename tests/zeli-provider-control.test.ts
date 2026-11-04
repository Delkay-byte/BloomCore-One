import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  getEffectiveProviderPolicy,
  PRODUCTION_PROVIDER_APPROVED,
} from "@/lib/zeli/provider-control";
import { buildSyntheticInsightPackage } from "@/lib/zeli/insight-package";
import { evaluateInsightPackage } from "@/lib/zeli/gateway";
import {
  requestDeepSeekExplanation,
  validateProviderExplanation,
} from "@/lib/zeli/deepseek-client";
import { prisma } from "./setup";
import { runZeliTurn } from "@/lib/zeli/service";

async function setControl(overrides: Record<string, unknown>) {
  await prisma.zeliProviderControl.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      mode: "disabled",
      enabled: false,
      emergencyDisabled: true,
      ...overrides,
    },
    update: overrides,
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("global external AI policy", () => {
  it("stays disabled by default, even with provider flags and a key", () => {
    vi.stubEnv("ZELI_PROVIDER", "deepseek");
    vi.stubEnv("ZELI_DEEPSEEK_APPROVED", "true");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    return getEffectiveProviderPolicy().then((policy) => {
      expect(policy.state).toBe("disabled");
      expect(policy.allowed).toBe(false);
      expect(policy.emergencyDisabled).toBe(true);
    });
  });

  it("cannot enable synthetic mode without the environment permission", async () => {
    await setControl({
      mode: "synthetic",
      enabled: true,
      emergencyDisabled: false,
      approvedProvider: "deepseek",
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    const policy = await getEffectiveProviderPolicy();
    expect(policy.state).toBe("disabled");
    expect(policy.reason).toContain("not enabled in this environment");
  });

  it("allows synthetic mode when both the control and environment permit it", async () => {
    await setControl({
      mode: "synthetic",
      enabled: true,
      emergencyDisabled: false,
      approvedProvider: "deepseek",
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    const policy = await getEffectiveProviderPolicy();
    expect(policy.state).toBe("synthetic");
    expect(policy.allowed).toBe(true);
    expect(policy.syntheticOnly).toBe(true);
  });

  it("keeps approved production mode locked without every approval", async () => {
    const tenant = await createTestTenant();
    await setControl({
      mode: "approved",
      enabled: true,
      emergencyDisabled: false,
      approvedProvider: "deepseek",
      policyVersion: "2026-11.2",
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("ZELI_PRIVACY_POLICY_VERSION", "2026-11.2");
    vi.stubEnv("ZELI_APPROVAL_REFERENCE", "DPC-REFERENCE");
    const policy = await getEffectiveProviderPolicy(tenant.id);
    expect(PRODUCTION_PROVIDER_APPROVED).toBe(false);
    expect(policy.state).toBe("disabled");
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toContain("reviewed code approval");
  });

  it("lets the emergency stop override synthetic mode", async () => {
    await setControl({
      mode: "synthetic",
      enabled: true,
      emergencyDisabled: true,
      approvedProvider: "deepseek",
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    const policy = await getEffectiveProviderPolicy();
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toContain("emergency");
  });
});

describe("insight gateway", () => {
  it("accepts only a typed aggregate package", () => {
    const pkg = buildSyntheticInsightPackage();
    const result = evaluateInsightPackage(pkg, { cohortSize: 42, synthetic: true });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown fields, identifiers and small groups", () => {
    const pkg = buildSyntheticInsightPackage();
    expect(
      evaluateInsightPackage({ ...pkg, customerName: "Ama" }, { cohortSize: 42, synthetic: true }).ok
    ).toBe(false);
    expect(
      evaluateInsightPackage(
        { ...pkg, categories: ["tenant"] },
        { cohortSize: 42, synthetic: true }
      ).ok
    ).toBe(false);
    expect(
      evaluateInsightPackage(pkg, { cohortSize: 4, synthetic: true }).reason
    ).toContain("Small group suppressed");
    expect(
      evaluateInsightPackage(pkg, { cohortSize: 5, synthetic: true }).ok
    ).toBe(true);
  });

  it("rejects a real package in synthetic mode and synthetic packages in production", () => {
    const synthetic = buildSyntheticInsightPackage();
    const real = { ...synthetic };
    delete real.synthetic;
    delete real.syntheticScenario;
    expect(
      evaluateInsightPackage(real, { cohortSize: 42, synthetic: true }).ok
    ).toBe(false);
    expect(
      evaluateInsightPackage(synthetic, { cohortSize: 42, synthetic: false }).ok
    ).toBe(false);
  });

  it("builds no exact money or dates into the approved package", () => {
    const pkg = buildSyntheticInsightPackage();
    const serialized = JSON.stringify(pkg);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized).not.toMatch(/GH₵|GHS/);
    expect(serialized).not.toMatch(/customer|name|account|phone|email/i);
  });
});

describe("DeepSeek output validation", () => {
  it("accepts a qualitative explanation", () => {
    const result = validateProviderExplanation({
      explanation: "Activity increased across the period, but the reason is not established.",
      observed_pattern: "Contribution direction moved upward.",
      interpretation: "Operational context is required before drawing a conclusion.",
      suggested_investigation: "Review collection coverage and recorded handovers.",
      limitations: "Aggregate comparison only.",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects fabricated financial numbers, dates and identifiers", () => {
    const base = {
      explanation: "Contributions increased by 15% to GH₵500.00.",
      observed_pattern: "Contribution direction moved upward.",
      interpretation: "Operational context is required before drawing a conclusion.",
      suggested_investigation: "Review collection coverage and recorded handovers.",
      limitations: "Aggregate comparison only.",
    };
    expect(validateProviderExplanation(base).ok).toBe(false);
    expect(
      validateProviderExplanation({
        ...base,
        explanation: "On 2026-11-04 the customer BIK-C-001 paid more.",
      }).ok
    ).toBe(false);
    expect(
      validateProviderExplanation({
        ...base,
        explanation: "A pattern was observed for account CUS_123.",
      }).ok
    ).toBe(false);
  });

  it("rejects malformed JSON shape and extra properties", () => {
    expect(validateProviderExplanation({ explanation: "short" }).ok).toBe(false);
    expect(
      validateProviderExplanation({
        explanation: "A sufficiently long qualitative explanation without numbers.",
        observed_pattern: "Pattern.",
        interpretation: "Interpretation.",
        suggested_investigation: "Investigate.",
        limitations: "Limits.",
        amount: 500,
      }).ok
    ).toBe(false);
  });
});

describe("DeepSeek transport", () => {
  async function syntheticPolicy() {
    await setControl({
      mode: "synthetic",
      enabled: true,
      emergencyDisabled: false,
      approvedProvider: "deepseek",
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    return getEffectiveProviderPolicy();
  }

  it("calls only the fixed endpoint with a synthetic package", async () => {
    const policy = await syntheticPolicy();
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("deepseek-flash");
      expect(body.stream).toBe(false);
      expect(JSON.stringify(body)).toContain("synthetic");
      expect(JSON.stringify(body)).not.toContain("tenant");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  explanation: "A qualitative upward movement is described without financial figures.",
                  observed_pattern: "Upward direction.",
                  interpretation: "Context is still required.",
                  suggested_investigation: "Review operational records.",
                  limitations: "Aggregate only.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestDeepSeekExplanation({
      package: buildSyntheticInsightPackage(),
      policy,
      apiKey: "sk-test",
    });
    expect(result.explanation.explanation).toContain("qualitative");
    expect(result.inputTokens).toBe(120);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call the network when policy is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const policy = await getEffectiveProviderPolicy();
    await expect(
      requestDeepSeekExplanation({
        package: buildSyntheticInsightPackage(),
        policy,
        apiKey: "sk-test",
      })
    ).rejects.toThrow("denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a provider response containing an unapproved amount", async () => {
    const policy = await syntheticPolicy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "The total was GH₵99,999.00 which is a fabricated amount.",
                    observed_pattern: "Upward direction.",
                    interpretation: "Context is still required.",
                    suggested_investigation: "Review operational records.",
                    limitations: "Aggregate only.",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    await expect(
      requestDeepSeekExplanation({
        package: buildSyntheticInsightPackage(),
        policy,
        apiKey: "sk-test",
      })
    ).rejects.toThrow("validation");
  });
});

describe("normal Zeli turns under synthetic mode", () => {
  it("uses tool orchestration for a synthetic staging business turn without tenant identifiers", async () => {
    await setControl({
      mode: "synthetic",
      enabled: true,
      emergencyDisabled: false,
      approvedProvider: "deepseek",
    });
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenant.id, userId: admin.id },
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "deepseek-flash",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "contributions_withdrawals",
                        arguments: JSON.stringify({ period: "this_month" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "deepseek-flash",
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "This month's contributions are shown in the authoritative calculation below.",
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runZeliTurn({
      identity: {
        userId: admin.id,
        fullName: "Admin",
        role: "admin",
        tenantId: tenant.id,
        module: "admin",
      },
      conversationId: conversation.id,
      question: "Summarise this month's contributions.",
    });
    expect(result.provider).toBe("deepseek-enhanced");
    expect(result.conversationMode).toBe("external");
    expect(result.tools[0].tool).toBe("contributions_withdrawals");
    expect(result.text).toContain("[AUTHORITATIVE LOCAL CALCULATION]");

    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).not.toContain(tenant.id);
    expect(body).not.toContain(admin.id);
    expect(body).toContain("Summarise this month's contributions.");
  });
});
