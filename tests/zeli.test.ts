import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import { runZeliTurn, ZeliUsageError } from "@/lib/zeli/service";
import { buildZeliContext } from "@/lib/zeli/tools";
import type { ZeliIdentity } from "@/lib/zeli/types";

const identity = (overrides: Partial<ZeliIdentity>): ZeliIdentity => ({
  userId: "u",
  fullName: "User",
  role: "admin",
  tenantId: null,
  module: "admin",
  ...overrides,
});

async function seed() {
  const tenantA = await createTestTenant();
  const tenantB = await createTestTenant();
  const adminA = await createTestAdmin({ tenantId: tenantA.id });
  const adminB = await createTestAdmin({ tenantId: tenantB.id });

  const customerA = await prisma.customer.create({
    data: {
      tenantId: tenantA.id,
      customerId: "ZELI-A-001",
      fullName: "Ama Zeli Customer",
      phone: "+233200000111",
      status: "active",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      tenantId: tenantB.id,
      customerId: "ZELI-B-001",
      fullName: "B Absent Customer",
      phone: "+233200000222",
      status: "active",
    },
  });
  await prisma.susuAccount.create({
    data: {
      tenantId: tenantA.id,
      accountId: "ZELI-S-001",
      customerId: customerA.id,
      dailyContribution: 50,
      status: "active",
    },
  });

  return { tenantA, tenantB, adminA, adminB, customerB };
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("Zeli grounding and isolation", () => {
  it("answers from the authenticated tenant and persists the conversation", async () => {
    const { tenantA, adminA } = await seed();
    const who = identity({ userId: adminA.id, tenantId: tenantA.id });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenantA.id, userId: adminA.id },
    });

    const result = await runZeliTurn({
      identity: who,
      conversationId: conversation.id,
      question: "Summarise today's contributions and customers",
    });

    expect(result.providerAvailable).toBe(true);
    expect(result.text).toContain("Active customers: 1");
    expect(result.sources.length).toBeGreaterThan(0);

    const messages = await prisma.zeliMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    const updated = await prisma.zeliConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect(updated.title).not.toBe("New conversation");
  });

  it("never exposes Tenant B records in Tenant A context or answers", async () => {
    const { tenantA, adminA } = await seed();
    const context = await buildZeliContext(
      identity({ userId: adminA.id, tenantId: tenantA.id }),
      "Find customer B Absent Customer"
    );
    const serialized = JSON.stringify(context.blocks);
    expect(serialized).toContain("Ama Zeli Customer");
    expect(serialized).not.toContain("B Absent Customer");
  });

  it("rejects a conversation owned by another user", async () => {
    const { tenantA, adminA, adminB } = await seed();
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenantA.id, userId: adminA.id },
    });
    await expect(
      runZeliTurn({
        identity: identity({
          userId: adminB.id,
          tenantId: tenantA.id,
        }),
        conversationId: conversation.id,
        question: "Show everything",
      })
    ).rejects.toThrow("Conversation not found");
  });

  it("gives collectors collector context, not tenant-wide admin context", async () => {
    const { tenantA, adminA } = await seed();
    const collectorUser = await prisma.user.create({
      data: {
        tenantId: tenantA.id,
        email: `zeli-collector-${Date.now()}@test.local`,
        fullName: "Zeli Collector",
        role: "collector",
        status: "active",
        passwordHash: "not-used",
      },
    });
    await prisma.collector.create({
      data: { tenantId: tenantA.id, userId: collectorUser.id, status: "active" },
    });
    // Ensure adminA exists in the tenant for the business summary check.
    expect(adminA.tenantId).toBe(tenantA.id);

    const collectorContext = await buildZeliContext(
      identity({
        userId: collectorUser.id,
        tenantId: tenantA.id,
        role: "collector",
        module: "susu",
      }),
      "How many customers are assigned to me?"
    );
    const tools = collectorContext.tools.map((tool) => tool.tool);
    expect(tools).toContain("collector_summary");
    expect(tools).not.toContain("business_summary");
  });

  it("does not call DeepSeek while approval is absent", async () => {
    const { tenantA, adminA } = await seed();
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenantA.id, userId: adminA.id },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ZELI_PROVIDER", "deepseek");
    vi.stubEnv("ZELI_DEEPSEEK_APPROVED", "false");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key-not-used");

    const result = await runZeliTurn({
      identity: identity({ userId: adminA.id, tenantId: tenantA.id }),
      conversationId: conversation.id,
      question: "Summarise the business",
    });
    expect(result.providerAvailable).toBe(false);
    expect(result.text).toContain("disabled pending written DPA/privacy approval");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the DeepSeek adapter with a mocked provider when approval is present", async () => {
    const { tenantA, adminA } = await seed();
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenantA.id, userId: adminA.id },
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Mocked provider answer" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ZELI_PROVIDER", "deepseek");
    vi.stubEnv("ZELI_DEEPSEEK_APPROVED", "true");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const result = await runZeliTurn({
      identity: identity({ userId: adminA.id, tenantId: tenantA.id }),
      conversationId: conversation.id,
      question: "Summarise the business",
    });
    expect(result.providerAvailable).toBe(true);
    expect(result.text).toBe("Mocked provider answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("enforces the server-side daily request limit", async () => {
    const { tenantA, adminA } = await seed();
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenantA.id, userId: adminA.id },
    });
    await prisma.zeliUsage.create({
      data: {
        tenantId: tenantA.id,
        userId: adminA.id,
        day: new Date().toISOString().slice(0, 10),
        requests: 40,
      },
    });

    await expect(
      runZeliTurn({
        identity: identity({ userId: adminA.id, tenantId: tenantA.id }),
        conversationId: conversation.id,
        question: "One more question",
      })
    ).rejects.toBeInstanceOf(ZeliUsageError);
  });
});
