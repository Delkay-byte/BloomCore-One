import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanDatabase,
  createTestAdmin,
  createTestTenant,
  prisma,
} from "./setup";
import {
  evaluateOutboundPayload,
  minimumCohortSize,
  submitOutboundPayload,
} from "@/lib/zeli/gateway";
import { DeepSeekZeliProvider } from "@/lib/zeli/deepseek-provider";
import {
  PROVIDER_DISABLED_MESSAGE,
  externalAiStatus,
} from "@/lib/zeli/provider-policy";
import { zeliProviderStatus } from "@/lib/zeli/provider";

function validPayload() {
  return {
    purpose: "trend_explanation",
    reportingPeriod: {
      start: "2026-11-01",
      end: "2026-11-30",
      granularity: "month",
    },
    aggregates: [
      { metric: "contributions", value: 12345.67, unit: "GHS", direction: "up" },
      { metric: "transaction_count", value: 84, unit: "count", direction: "up" },
    ],
    cohortSize: 42,
    categories: ["period_trend"],
  };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("outbound privacy gateway", () => {
  it("accepts a typed aggregate payload with no identifiers", () => {
    const result = evaluateOutboundPayload(validPayload());
    expect(result.ok).toBe(true);
    expect(result.normalized?.aggregates).toHaveLength(2);
    expect(result.categories).toContain("contributions");
  });

  it("rejects unknown top-level and nested fields", () => {
    expect(
      evaluateOutboundPayload({ ...validPayload(), customerName: "Ama" }).ok
    ).toBe(false);
    expect(
      evaluateOutboundPayload({
        ...validPayload(),
        reportingPeriod: {
          ...validPayload().reportingPeriod,
          timezone: "Africa/Accra",
        },
      }).ok
    ).toBe(false);
    expect(
      evaluateOutboundPayload({
        ...validPayload(),
        aggregates: [
          { metric: "contributions", value: 1, unit: "GHS", accountId: "BIK-S-1" },
        ],
      }).ok
    ).toBe(false);
  });

  it("rejects sensitive fields and identifier-like values", () => {
    for (const field of [
      "phone",
      "email",
      "accountNumber",
      "customerId",
      "paymentReference",
      "transactionId",
      "location",
      "notes",
      "document",
      "mfaCode",
      "conversationHistory",
      "tenantId",
      "userId",
    ]) {
      const result = evaluateOutboundPayload({ ...validPayload(), [field]: "value" });
      expect(result.ok, field).toBe(false);
    }
    expect(
      evaluateOutboundPayload({
        ...validPayload(),
        aggregates: [
          { metric: "contributions", value: 1, unit: "GHS", direction: "up" },
        ],
        purpose: "ama@example.com",
      }).ok
    ).toBe(false);
    expect(
      evaluateOutboundPayload({
        ...validPayload(),
        reportingPeriod: {
          start: "2026-11-01T10:30:00Z",
          end: "2026-11-30",
          granularity: "month",
        },
      }).ok
    ).toBe(false);
    expect(
      evaluateOutboundPayload({
        ...validPayload(),
        aggregates: [
          {
            metric: "contributions",
            value: 1,
            unit: "GHS",
            direction: "up",
          },
        ],
        note: "Customer paid at the Accra branch",
      }).ok
    ).toBe(false);
  });

  it("rejects raw input and unexpected shapes fail-closed", () => {
    expect(evaluateOutboundPayload("send everything").ok).toBe(false);
    expect(evaluateOutboundPayload(null).ok).toBe(false);
    expect(evaluateOutboundPayload({ ...validPayload(), cohortSize: "42" }).ok).toBe(false);
  });

  it("suppresses small groups and clamps the threshold to at least five", () => {
    expect(
      evaluateOutboundPayload({ ...validPayload(), cohortSize: 4 }).reason
    ).toContain("Small group suppressed");

    vi.stubEnv("ZELI_GATEWAY_MIN_COHORT", "10");
    expect(minimumCohortSize()).toBe(10);
    expect(evaluateOutboundPayload({ ...validPayload(), cohortSize: 9 }).ok).toBe(false);
    expect(evaluateOutboundPayload({ ...validPayload(), cohortSize: 10 }).ok).toBe(true);

    // Configuration cannot weaken the floor.
    vi.stubEnv("ZELI_GATEWAY_MIN_COHORT", "1");
    expect(minimumCohortSize()).toBe(5);
    vi.unstubAllEnvs();
  });

  it("never sends a payload while external processing is disabled", async () => {
    const tenant = await createTestTenant();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitOutboundPayload({
      tenantId: tenant.id,
      provider: "deepseek",
      payload: validPayload(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("External AI processing is disabled");
    expect(fetchMock).not.toHaveBeenCalled();

    const event = await prisma.zeliProviderGatewayEvent.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(event.decision).toBe("denied");
    expect(event.policyVersion).toBeTruthy();
    expect(event.payloadCategories).toContain("contributions");
    // No payload values, customer names or free text are stored.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("Analytics Customer");
    expect(serialized).not.toContain("12345.67");
    expect(serialized).not.toContain("2026-11-01");
  });

  it("audits a rejected payload without making a request", async () => {
    const tenant = await createTestTenant();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await submitOutboundPayload({
      tenantId: tenant.id,
      provider: "deepseek",
      payload: { ...validPayload(), customerName: "Analytics Customer" },
    });
    expect(result.allowed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const event = await prisma.zeliProviderGatewayEvent.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(event.decision).toBe("denied");
    expect(event.reason).toContain("Forbidden field");
  });
});

describe("DeepSeek hard-off", () => {
  it("reports external processing disabled with the owner-facing message", () => {
    const status = externalAiStatus();
    expect(status.externalProcessing).toBe(false);
    expect(status.deepSeekDisabled).toBe(true);
    expect(status.provider).toBe("none");
    expect(status.message).toBe(PROVIDER_DISABLED_MESSAGE);

    const zeli = zeliProviderStatus();
    expect(zeli.provider).toBe("internal");
    expect(zeli.available).toBe(true);
    expect(zeli.external.deepSeekDisabled).toBe(true);
  });

  it("does not call the network even with provider, approval flag and key set", async () => {
    vi.stubEnv("ZELI_PROVIDER", "deepseek");
    vi.stubEnv("ZELI_DEEPSEEK_APPROVED", "true");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test-must-never-be-used");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new DeepSeekZeliProvider();
    expect(provider.available().ok).toBe(false);
    await expect(
      provider.generate({
        system: "server-controlled",
        question: "Summarise the business",
        history: [],
        context: [],
        identity: { userId: "u", fullName: "", role: "admin", tenantId: "t", module: "admin" },
      })
    ).rejects.toThrow(PROVIDER_DISABLED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(zeliProviderStatus().provider).toBe("internal");
    expect(zeliProviderStatus().external.credentialConfigured).toBe(true);
    expect(zeliProviderStatus().external.externalProcessing).toBe(false);
  });

  it("does not expose the credential value", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-super-secret-value");
    const serialized = JSON.stringify(externalAiStatus());
    expect(serialized).not.toContain("sk-super-secret-value");
    expect(JSON.stringify(zeliProviderStatus())).not.toContain("sk-super-secret-value");
  });

  it("keeps the chat turn providerless with environment flags set", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenant.id, userId: admin.id },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ZELI_PROVIDER", "deepseek");
    vi.stubEnv("ZELI_DEEPSEEK_APPROVED", "true");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");

    const { runZeliTurn } = await import("@/lib/zeli/service");
    const result = await runZeliTurn({
      identity: {
        userId: admin.id,
        fullName: "Admin",
        role: "admin",
        tenantId: tenant.id,
        module: "admin",
      },
      conversationId: conversation.id,
      question: "Summarise this month's contributions",
    });
    expect(result.provider).toBe("internal");
    expect(result.deterministic).toBe(true);
    expect(result.providerAvailable).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
