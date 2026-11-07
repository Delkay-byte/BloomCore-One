import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestTenant, prisma } from "./setup";
import {
  TEAM_TESTING_DISCLOSURE_VERSION,
  getEffectiveProviderPolicy,
} from "@/lib/zeli/provider-control";
import {
  getConversationPolicy,
} from "@/lib/zeli/providers/conversation-policy";
import {
  generateTeamConversation,
  redactKnownTenantIdentifiers,
} from "@/lib/zeli/providers/conversation-provider";
import { requestDeepSeekTeamConversation } from "@/lib/zeli/providers/deepseek-conversation";
import { runZeliTurn } from "@/lib/zeli/service";
import type { ZeliIdentity } from "@/lib/zeli/types";

const fetchMock = vi.fn();
const KEY = "unit-test-placeholder-not-a-real-key";

async function setControl(overrides: Record<string, unknown> = {}) {
  const data = {
    mode: "team_testing",
    enabled: true,
    emergencyDisabled: false,
    approvedProvider: "deepseek",
    policyVersion: TEAM_TESTING_DISCLOSURE_VERSION,
    reason: "Team testing fixture",
    ...overrides,
  };
  await prisma.zeliProviderControl.upsert({
    where: { id: "global" },
    create: { id: "global", ...data },
    update: data,
  });
}

async function teamFixture() {
  const tenant = await createTestTenant();
  const updated = await prisma.businessTenant.update({
    where: { id: tenant.id },
    data: { code: "BIK-HQ-001" },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: updated.id,
      email: "team-tester@test.local",
      fullName: "Team Tester",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  await prisma.zeliAiTenantAuthorization.create({
    data: {
      tenantId: updated.id,
      enabled: true,
      reason: "Restricted team testing acceptance",
    },
  });
  await prisma.zeliTeamTester.create({
    data: {
      tenantId: updated.id,
      userId: user.id,
      status: "active",
      disclosureVersion: TEAM_TESTING_DISCLOSURE_VERSION,
      disclosureAcceptedAt: new Date(),
      reason: "Team testing acceptance fixture",
    },
  });
  await setControl();
  const identity: ZeliIdentity = {
    userId: user.id,
    fullName: user.fullName,
    role: "admin",
    tenantId: updated.id,
    module: "admin",
  };
  return { tenant: updated, user, identity };
}

function okResponse(content = "A genuine DeepSeek reply about the fictional scenario.") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 30, completion_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

beforeEach(async () => {
  await cleanDatabase();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("DEEPSEEK_API_KEY", KEY);
  vi.stubEnv("ZELI_TEAM_TESTING_ALLOWED", "true");
  vi.stubEnv("ZELI_TEAM_TESTING_TENANT_CODE", "BIK-HQ-001");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Team Testing policy", () => {
  it("allows only the restricted tenant with an authorised tester and disclosure", async () => {
    const { tenant, user } = await teamFixture();
    const policy = await getConversationPolicy(tenant.id, user.id);
    expect(policy.state).toBe("team_testing");
    expect(policy.allowed).toBe(true);
    expect(policy.syntheticOnly).toBe(true);
    expect(policy.teamDisclosureAccepted).toBe(true);
  });

  it("denies an unauthorised tenant", async () => {
    const { user, identity } = await teamFixture();
    const other = await createTestTenant();
    const policy = await getConversationPolicy(other.id, user.id);
    expect(policy.allowed).toBe(false);
    expect(policy.state).toBe("disabled");
    expect(policy.reason).toContain("Team Testing is locked");
    expect(identity.tenantId).not.toBe(other.id);
  });

  it("denies a tester who has not accepted the disclosure", async () => {
    const { tenant, user } = await teamFixture();
    await prisma.zeliTeamTester.updateMany({
      where: { tenantId: tenant.id, userId: user.id },
      data: { disclosureVersion: null, disclosureAcceptedAt: null },
    });
    const policy = await getConversationPolicy(tenant.id, user.id);
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toContain("tester disclosure acceptance");
  });

  it("keeps the emergency stop above team testing", async () => {
    const { tenant, user } = await teamFixture();
    await setControl({ emergencyDisabled: true });
    const policy = await getEffectiveProviderPolicy(tenant.id, user.id);
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toContain("emergency");
  });

  it("keeps approved production locked while team testing is allowed", async () => {
    const { tenant } = await teamFixture();
    const policy = await getEffectiveProviderPolicy(tenant.id);
    expect(policy.state).not.toBe("approved");
    expect(policy.productionApproved).toBe(false);
  });
});

describe("Team Testing provider", () => {
  it("calls the real adapter and carries multi-turn history", async () => {
    const { identity } = await teamFixture();
    fetchMock.mockResolvedValueOnce(okResponse("First genuine reply."));
    fetchMock.mockResolvedValueOnce(okResponse("Second genuine reply with context."));

    const first = await generateTeamConversation({
      identity,
      message: "Explain the fictional Demo Enterprise scenario.",
      history: [],
    });
    expect(first).not.toBeNull();
    expect(first?.text).toContain("First genuine reply.");
    expect(first?.text).toContain("TEAM TESTING");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await generateTeamConversation({
      identity,
      message: "What did you just say?",
      history: [
        { role: "user", content: "Explain the fictional Demo Enterprise scenario." },
        { role: "assistant", content: "First genuine reply." },
      ],
    });
    expect(second).not.toBeNull();
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body.messages.length).toBeGreaterThan(2);
    expect(JSON.stringify(body)).toContain("First genuine reply.");
    expect(second?.text).toContain("Second genuine reply with context.");
  });

  it("redacts real customer identifiers before sending", async () => {
    const { tenant, identity } = await teamFixture();
    await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerId: "REAL-C-001",
        fullName: "Abena Real Customer",
        phone: "+233240000999",
        email: "abena.real@example.test",
        status: "active",
      },
    });
    const cleaned = await redactKnownTenantIdentifiers(
      tenant.id,
      "Please discuss Abena Real Customer, +233240000999 and REAL-C-001."
    );
    expect(cleaned).not.toContain("Abena Real Customer");
    expect(cleaned).not.toContain("+233240000999");
    expect(cleaned).not.toContain("REAL-C-001");
    expect(cleaned).toContain("[redacted identifier]");

    fetchMock.mockResolvedValueOnce(okResponse());
    await generateTeamConversation({
      identity,
      message: "Please discuss Abena Real Customer, +233240000999 and REAL-C-001.",
      history: [],
    });
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).not.toContain("Abena Real Customer");
    expect(body).not.toContain("+233240000999");
    expect(body).not.toContain("REAL-C-001");
  });

  it("returns no deterministic substitute on provider failure", async () => {
    const { identity } = await teamFixture();
    fetchMock.mockResolvedValueOnce(new Response("upstream", { status: 500 }));
    const result = await generateTeamConversation({
      identity,
      message: "Hello",
      history: [],
    });
    expect(result).toBeNull();
  });

  it("routes a full Zeli turn to DeepSeek and never silently substitutes local output", async () => {
    const { tenant, user, identity } = await teamFixture();
    const conversation = await prisma.zeliConversation.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        userType: "user",
        title: "Team testing conversation",
      },
    });
    fetchMock.mockResolvedValueOnce(okResponse("Genuine team-testing answer."));
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Tell me about the fictional Demo Enterprise.",
    });
    expect(result.provider).toBe("deepseek-team-testing");
    expect(result.deterministic).toBe(false);
    expect(result.externalAi).toBe(true);
    expect(result.text).toContain("Genuine team-testing answer.");
    expect(result.text).toContain("TEAM TESTING");

    fetchMock.mockResolvedValueOnce(new Response("upstream", { status: 500 }));
    const failed = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "One more question.",
    });
    expect(failed.text).toContain("No deterministic answer was substituted");
    expect(failed.provider).toBe("team-testing-unavailable");
  });

  it("rejects a missing credential at the transport", async () => {
    const { identity } = await teamFixture();
    await expect(
      requestDeepSeekTeamConversation({
        message: "Hello",
        history: [],
        policy: await getConversationPolicy(identity.tenantId, identity.userId),
        apiKey: "",
      })
    ).rejects.toMatchObject({ code: "missing_credential" });
  });
});
