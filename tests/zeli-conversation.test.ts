import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestAdmin, createTestCustomer, createTestTenant, prisma } from "./setup";
import { runZeliTurn } from "@/lib/zeli/service";
import type { ZeliIdentity } from "@/lib/zeli/types";
import {
  classifyConversationAct,
  isFinancialInstruction,
} from "@/lib/zeli/conversation/acts";
import { resolveConversationContext } from "@/lib/zeli/conversation/context";

const fetchMock = vi.fn();

beforeEach(async () => {
  await cleanDatabase();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function adminConversation() {
  const tenant = await createTestTenant({ name: "Conversation Tenant" });
  const admin = await createTestAdmin({ tenantId: tenant.id });
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
  return { tenant, admin, conversation, identity };
}

describe("local conversational acts", () => {
  it("greets the user without calling any provider", async () => {
    const { conversation, identity } = await adminConversation();
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Hello",
    });

    expect(result.intent).toBe("greeting");
    expect(result.conversationMode).toBe("local");
    expect(result.externalAi).toBe(false);
    expect(result.deterministic).toBe(true);
    expect(result.provider).toBe("internal");
    expect(result.text).toContain("Zeli");
    expect(result.text).toContain("internal rule-based engine");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains its capabilities on request", async () => {
    const { conversation, identity } = await adminConversation();
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "What can you do?",
    });

    expect(result.intent).toBe("help");
    expect(result.text).toContain("contributions");
    expect(result.text).toContain("read-only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers identity questions honestly", async () => {
    const { conversation, identity } = await adminConversation();
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Are you ChatGPT?",
    });
    expect(result.intent).toBe("identity");
    expect(result.text).toContain("built into BloomCore One");
    expect(result.text.toLowerCase()).not.toContain("i am chatgpt");
  });

  it("gives a useful local explanation for general knowledge questions", async () => {
    const { conversation, identity } = await adminConversation();
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Write me a poem about the sea",
    });

    expect(result.intent).toBe("general_knowledge");
    expect(result.text).toContain("local mode");
    expect(result.text).toContain("Nothing from this conversation was sent anywhere");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains an unsupported question instead of inventing an answer", async () => {
    const { conversation, identity } = await adminConversation();
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "How do I fix the office printer?",
    });

    expect(result.intent).toBe("unsupported");
    expect(result.text).toContain("outside the set of business questions");
    expect(result.text).toContain("will not invent an answer");
  });

  it("refuses financial instructions and confirms nothing changed", async () => {
    const { conversation, identity } = await adminConversation();
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Approve the pending withdrawal now",
    });

    expect(result.intent).toBe("instruction");
    expect(result.text).toContain("can't do that");
    expect(result.text).toContain("No data was changed");
    expect(result.text).toContain("read-only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat a genuine how-to question as an instruction", () => {
    expect(isFinancialInstruction("Approve the pending withdrawal now")).toBe(true);
    expect(isFinancialInstruction("Please reverse the transaction")).toBe(true);
    expect(isFinancialInstruction("How do I request a withdrawal?")).toBe(false);
    expect(isFinancialInstruction("Can I approve a withdrawal?")).toBe(false);
  });

  it("classifies social and instruction acts deterministically", () => {
    expect(classifyConversationAct("hello there", "admin")).toBe("greeting");
    expect(classifyConversationAct("thanks", "admin")).toBe("thanks");
    expect(classifyConversationAct("bye", "admin")).toBe("farewell");
    expect(classifyConversationAct("what can you help me with", "admin")).toBe("help");
    expect(classifyConversationAct("who are you", "admin")).toBe("identity");
  });
});

describe("conversation context and follow-ups", () => {
  it("resolves a period-only follow-up against the previous turn", async () => {
    const { conversation, identity } = await adminConversation();
    const first = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise contributions and withdrawals for this month",
    });
    expect(first.intent).toBe("contributions_withdrawals");
    expect(first.period).toBe("this_month");
    expect(first.contextUsed).toBe(false);

    const followUp = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "And last month?",
    });

    expect(followUp.contextUsed).toBe(true);
    expect(followUp.intent).toBe("contributions_withdrawals");
    expect(followUp.period).toBe("previous_month");
    expect(followUp.text).toContain("Previous month");
    expect(followUp.text).toContain("CALCULATED FACT");
  });

  it("resolves a why follow-up against the previous subject", async () => {
    const { conversation, identity } = await adminConversation();
    await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise remittance activity for this month",
    });
    const followUp = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Why?",
    });

    expect(followUp.contextUsed).toBe(true);
    expect(followUp.intent).toBe("why_changed");
    expect(followUp.text).toContain("CALCULATED FACT");
  });

  it("asks one clarifying question and completes it on the next turn", async () => {
    const { conversation, identity } = await adminConversation();
    const ambiguous = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Show me the report",
    });

    expect(ambiguous.intent).toBe("clarification");
    expect(ambiguous.askedFor).toBe("business_topic");
    expect(ambiguous.text).toContain("I need one more detail");
    expect(ambiguous.text).toContain("remittances and handover variance");

    const completed = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "remittances",
    });

    expect(completed.contextUsed).toBe(true);
    expect(completed.intent).toBe("remittances");
    expect(completed.text).toContain("CALCULATED FACT");
  });

  it("does not inherit context across unrelated social turns", async () => {
    const { conversation, identity } = await adminConversation();
    await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Hello",
    });
    const next = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "And last month?",
    });
    // A greeting is not a business subject, so the follow-up stays unsupported
    // rather than being answered from a guessed subject.
    expect(next.contextUsed).toBe(false);
    expect(next.intent).not.toBe("contributions_withdrawals");
  });

  it("does not turn an unrelated side question into a business summary", async () => {
    const { conversation, identity } = await adminConversation();
    await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise contributions and withdrawals for this month",
    });
    const side = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "What about the weather?",
    });
    expect(side.contextUsed).toBe(false);
    expect(side.intent).toBe("general_knowledge");
    expect(side.intent).not.toBe("business_summary");
  });

  it("expands only when the previous turn is a business intent", () => {
    const resolution = resolveConversationContext({
      question: "last month?",
      previous: { intent: "remittances", period: "this_month", askedFor: null },
    });
    expect(resolution.usedContext).toBe(true);
    expect(resolution.question).toContain("remittance variance");
    expect(resolution.question).toContain("last month");

    const ignored = resolveConversationContext({
      question: "last month?",
      previous: { intent: "greeting", period: null, askedFor: null },
    });
    expect(ignored.usedContext).toBe(false);
  });
});

describe("grounding, roles and history", () => {
  it("answers a financial follow-up from authoritative records", async () => {
    const { conversation, identity, tenant, admin } = await adminConversation();
    const { customer, account, cycle } = await createTestCustomer(admin.id, 10, "CONV");
    expect(customer.id).toBeTruthy();
    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 12.5,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: `CONV-${Date.now()}`,
      },
    });

    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise contributions this month",
    });

    expect(result.text).toContain("12.50");
    expect(result.text).toContain("Contributions:");
    expect(result.deterministic).toBe(true);
  });

  it("answers an income and expenses question from authoritative records", async () => {
    const { conversation, identity } = await adminConversation();
    const result = await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise income and expenses this month",
    });
    expect(result.intent).toBe("income_expenses");
    expect(result.text).toContain("Recorded cash income");
    expect(result.text).toContain("Recorded expenses");
    expect(result.text).toContain("CALCULATED FACT");
  });

  it("persists history with intent, period and mode metadata", async () => {
    const { conversation, identity } = await adminConversation();
    await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "Summarise this month's activity",
    });
    await runZeliTurn({
      identity,
      conversationId: conversation.id,
      question: "And last month?",
    });

    const messages = await prisma.zeliMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(messages).toHaveLength(4);
    const secondAnswer = messages[3];
    const meta = JSON.parse(secondAnswer.toolCalls ?? "{}");
    expect(meta.contextUsed).toBe(true);
    expect(meta.period).toBe("previous_month");
    expect(meta.conversationMode).toBe("local");
    expect(secondAnswer.provider).toBe("internal");
  });

  it("keeps worker and collector questions inside their role", async () => {
    const tenant = await createTestTenant();
    const worker = await prisma.user.create({
      data: {
        tenant: { connect: { id: tenant.id } },
        email: `worker-${Date.now()}@example.com`,
        fullName: "Worker",
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
    const result = await runZeliTurn({
      identity: {
        userId: worker.id,
        fullName: "Worker",
        role: "worker",
        tenantId: tenant.id,
        module: "momo",
      },
      conversationId: conversation.id,
      question: "Compare all tenant branch revenue",
    });

    expect(result.intent).toBe("unsupported");
    expect(result.text).toContain("outside the set of business questions");
  });

  it("does not leak another tenant's records through a follow-up", async () => {
    const tenantA = await createTestTenant({ name: "Tenant A" });
    const tenantB = await createTestTenant({ name: "Tenant B" });
    const adminA = await createTestAdmin({ tenantId: tenantA.id });
    const adminB = await createTestAdmin({ tenantId: tenantB.id });
    await prisma.customer.create({
      data: {
        tenantId: tenantA.id,
        customerId: "A-ONLY-001",
        fullName: "Alpha Only Customer",
        status: "active",
      },
    });
    await prisma.customer.create({
      data: {
        tenantId: tenantB.id,
        customerId: "B-ONLY-001",
        fullName: "Beta Secret Customer",
        status: "active",
      },
    });
    const conversationA = await prisma.zeliConversation.create({
      data: { tenantId: tenantA.id, userId: adminA.id },
    });

    const result = await runZeliTurn({
      identity: {
        userId: adminA.id,
        fullName: "Admin A",
        role: "admin",
        tenantId: tenantA.id,
        module: "admin",
      },
      conversationId: conversationA.id,
      question: "Summarise this month's activity",
    });

    expect(result.text).not.toContain("Beta Secret Customer");
    expect(result.text).not.toContain("B-ONLY-001");

    // Tenant B cannot open Tenant A's conversation at all.
    await expect(
      runZeliTurn({
        identity: {
          userId: adminB.id,
          fullName: "Admin B",
          role: "admin",
          tenantId: tenantB.id,
          module: "admin",
        },
        conversationId: conversationA.id,
        question: "And last month?",
      })
    ).rejects.toThrow("Conversation not found");
  });
});
