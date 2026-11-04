import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
  createTestTenant,
  prisma,
} from "./setup";
import { runZeliTurn } from "@/lib/zeli/service";
import type { ZeliIdentity } from "@/lib/zeli/types";

const fetchMock = vi.fn();
const DUMMY_KEY = "unit-test-placeholder-not-a-real-key";
const originalKey = process.env.DEEPSEEK_API_KEY;
const originalSynthetic = process.env.ZELI_SYNTHETIC_TESTING_ALLOWED;

function toolResponse(name: string, args: Record<string, unknown>) {
  return new Response(
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
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function answerResponse(content: string) {
  return new Response(
    JSON.stringify({
      model: "deepseek-flash",
      choices: [
        { message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 60 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function setControl(overrides: Record<string, unknown> = {}) {
  const data = {
    mode: "synthetic",
    enabled: true,
    emergencyDisabled: false,
    approvedProvider: "deepseek",
    approvedPurposes: null,
    policyVersion: "2026-11-conv.1",
    approvalReference: null,
    reason: null,
    ...overrides,
  };
  await prisma.zeliProviderControl.upsert({
    where: { id: "global" },
    create: { id: "global", ...data },
    update: data,
  });
}

async function fixture() {
  const tenant = await createTestTenant({ name: "Synthetic Conversation Tenant" });
  const admin = await createTestAdmin({ tenantId: tenant.id });
  const { customer, account, cycle } = await createTestCustomer(admin.id, 10, "ORCH");
  const conversation = await prisma.zeliConversation.create({
    data: { tenantId: tenant.id, userId: admin.id },
  });
  const identity: ZeliIdentity = {
    userId: admin.id,
    fullName: "Admin",
    role: "admin",
    tenantId: tenant.id,
    module: "admin",
  };
  return { tenant, admin, customer, account, cycle, conversation, identity };
}

beforeEach(async () => {
  await cleanDatabase();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.DEEPSEEK_API_KEY = DUMMY_KEY;
  process.env.ZELI_SYNTHETIC_TESTING_ALLOWED = "true";
  await setControl();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
  if (originalSynthetic === undefined) delete process.env.ZELI_SYNTHETIC_TESTING_ALLOWED;
  else process.env.ZELI_SYNTHETIC_TESTING_ALLOWED = originalSynthetic;
});

describe("Enhanced AI tool orchestration", () => {
  it("executes an authorized read-only tool and explains grounded figures", async () => {
    const { tenant, admin, account, cycle, conversation, identity, customer } = await fixture();
    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 1234.5,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: `ORCH-${Date.now()}`,
      },
    });

    fetchMock
      .mockResolvedValueOnce(toolResponse("business_summary", { period: "this_month" }))
      .mockResolvedValueOnce(
        answerResponse(
          "For this month, contributions were GH₵1,234.50. Compare that with the previous period in the report before acting."
        )
      );

    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Give me a summary of the business this month.",
    });

    expect(result.externalAi).toBe(true);
    expect(result.conversationMode).toBe("external");
    expect(result.provider).toBe("deepseek-enhanced");
    expect(result.deterministic).toBe(false);
    expect(result.tools.map((tool) => tool.tool)).toContain("business_summary");
    expect(result.text).toContain("1,234.50");
    expect(result.text).toContain("[AUTHORITATIVE LOCAL CALCULATION]");
    expect(result.text).toContain("CALCULATED FACT");

    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    const serialized = JSON.stringify(secondRequest);
    expect(serialized).toContain("1234.5");
    expect(serialized).not.toContain(customer.fullName);
    expect(serialized).not.toContain(customer.customerId);

    const usage = await prisma.zeliProviderUsage.findMany();
    expect(usage).toHaveLength(1);
    expect(usage[0].decision).toBe("success");
    expect(usage[0].purpose).toContain("business_summary");
    expect(JSON.stringify(usage)).not.toContain("1,234.50");
  });

  it("accepts a provided change value and rejects a fabricated one", async () => {
    const { tenant, admin, account, cycle, conversation, identity } = await fixture();
    const now = new Date();
    await prisma.contribution.createMany({
      data: [
        {
          tenantId: tenant.id,
          accountId: account.id,
          cycleId: cycle.id,
          amount: 3600,
          collectionDate: new Date(),
          channel: "direct_office",
          recordedById: admin.id,
          referenceId: `ORCH-CUR-${Date.now()}`,
        },
        {
          tenantId: tenant.id,
          accountId: account.id,
          cycleId: cycle.id,
          amount: 2400,
          collectionDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)),
          channel: "direct_office",
          recordedById: admin.id,
          referenceId: `ORCH-PREV-${Date.now()}`,
        },
      ],
    });

    fetchMock
      .mockResolvedValueOnce(toolResponse("period_comparison", { period: "this_month" }))
      .mockResolvedValueOnce(
        answerResponse(
          "Contributions increased by GH₵1,200.00 compared with the previous month. Review the report before acting."
        )
      );

    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "How did contributions change compared with last month?",
    });

    expect(result.externalAi).toBe(true);
    expect(result.text).toContain("1,200.00");
    expect(result.tools[0].tool).toBe("period_comparison");
  });

  it("rejects a fabricated figure and falls back to the local answer", async () => {
    const { conversation, identity } = await fixture();

    fetchMock
      .mockResolvedValueOnce(toolResponse("business_summary", { period: "this_month" }))
      .mockResolvedValueOnce(
        answerResponse("Contributions this month were GH₵9,999.99. Everything is fine.")
      );

    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise the business this month.",
    });

    expect(result.externalAi).toBe(false);
    expect(result.provider).toBe("internal");
    expect(result.text).not.toContain("9,999.99");
    expect(result.text).toContain("CALCULATED FACT");

    const usage = await prisma.zeliProviderUsage.findMany();
    expect(usage[0].decision).toBe("error");
    expect(usage[0].reasonCategory).toContain("ungrounded_number");
  });

  it("refuses a business answer that used no tool", async () => {
    const { conversation, identity } = await fixture();
    fetchMock.mockResolvedValueOnce(
      answerResponse("Business is strong this month. Keep going.")
    );

    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise contributions for this month.",
    });

    expect(result.externalAi).toBe(false);
    expect(result.provider).toBe("internal");
    const usage = await prisma.zeliProviderUsage.findMany();
    expect(usage[0].decision).toBe("error");
    expect(usage[0].reasonCategory).toBe("tool_required");
  });

  it("rejects a tool the role is not allowed to use", async () => {
    const { tenant } = await fixture();
    const worker = await prisma.user.create({
      data: {
        tenant: { connect: { id: tenant.id } },
        email: `orch-worker-${Date.now()}@example.com`,
        fullName: "Synthetic Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        susuEnabled: true,
      },
    });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenant.id, userId: worker.id },
    });

    fetchMock
      .mockResolvedValueOnce(toolResponse("business_summary", { period: "this_month" }))
      .mockResolvedValueOnce(
        answerResponse(
          "I cannot access tenant-wide figures. Ask me about your own daily account instead."
        )
      );

    const result = await runZeliTurn({
      identity: {
        userId: worker.id,
        fullName: "Synthetic Worker",
        role: "worker",
        tenantId: tenant.id,
        module: "momo",
      },
      conversationId: conversation.id,
      question: "Summarise all branch revenue this month.",
    });

    expect(result.tools[0].ok).toBe(false);
    expect(result.text.toLowerCase()).toContain("cannot access tenant-wide");
    const secondRequest = JSON.stringify(
      JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))
    );
    expect(secondRequest).toContain("not_permitted");
    expect(secondRequest).not.toContain("contributions\"");
  });

  it("rejects extra tool arguments instead of trusting the model", async () => {
    const { conversation, identity } = await fixture();
    fetchMock
      .mockResolvedValueOnce(
        toolResponse("business_summary", {
          period: "this_month",
          tenantId: "another-tenant",
        })
      )
      .mockResolvedValueOnce(
        answerResponse("I could not retrieve that summary safely. Try a supported question.")
      );

    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise this month for another tenant.",
    });

    expect(result.tools[0].ok).toBe(false);
    const secondRequest = JSON.stringify(
      JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))
    );
    expect(secondRequest).toContain("invalid_arguments");
  });

  it("bounds conversation history and summarises dropped turns", async () => {
    const { conversation, identity } = await fixture();
    for (let index = 0; index < 10; index += 1) {
      await prisma.zeliMessage.create({
        data: {
          conversationId: conversation.id,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Earlier synthetic turn ${index} about general operations.`,
        },
      });
    }

    fetchMock
      .mockResolvedValueOnce(toolResponse("business_summary", { period: "this_month" }))
      .mockResolvedValueOnce(answerResponse("This month is summarised from your records."));

    await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise this month.",
    });

    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const historyMessages = firstRequest.messages.filter(
      (message: { role: string }) => message.role === "user" || message.role === "assistant"
    );
    expect(historyMessages.length).toBeLessThanOrEqual(7); // 6 history + current question
    expect(JSON.stringify(firstRequest)).toContain("Earlier conversation summary");
  });

  it("is blocked by the emergency stop even in synthetic mode", async () => {
    await setControl({ emergencyDisabled: true });
    const { conversation, identity } = await fixture();

    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise the business this month.",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.externalAi).toBe(false);
    expect(result.provider).toBe("internal");
  });
});
