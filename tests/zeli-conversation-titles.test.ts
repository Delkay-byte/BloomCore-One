import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanDatabase,
  createTestAdmin,
  createTestTenant,
  prisma,
} from "./setup";
import { runZeliTurn } from "@/lib/zeli/service";
import { generateConversationTitle } from "@/lib/zeli/title";
import type { ZeliIdentity } from "@/lib/zeli/types";

const fetchMock = vi.fn();

beforeEach(async () => {
  await cleanDatabase();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

async function conversation(overrides: Record<string, unknown> = {}) {
  const tenant = await createTestTenant({ name: "Title Tenant" });
  const admin = await createTestAdmin({ tenantId: tenant.id });
  const row = await prisma.zeliConversation.create({
    data: { tenantId: tenant.id, userId: admin.id, ...overrides },
  });
  const identity: ZeliIdentity = {
    userId: admin.id,
    fullName: "Admin",
    role: "admin",
    tenantId: tenant.id,
    module: "admin",
  };
  return { row, identity };
}

describe("deterministic Zeli titles", () => {
  it("maps topics and months without external calls", () => {
    expect(generateConversationTitle("Show me the November business summary")).toBe(
      "November Business Summary"
    );
    expect(generateConversationTitle("Review collector remittances")).toBe(
      "Collector Remittance Review"
    );
    expect(generateConversationTitle("Why is there a cash shortage?")).toBe(
      "Daily Shortage Investigation"
    );
    expect(generateConversationTitle("Hello")).toBe("Business Question");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never puts a customer name, phone or amount in a title", () => {
    const title = generateConversationTitle(
      "Did Ama Mensah +233200000111 pay GHS 350.00 contribution yesterday?"
    );
    expect(title).toBe("Business Summary");
    expect(title).not.toMatch(/Ama|233|350/);
  });

  it("generates once from the first meaningful message and does not repeat", async () => {
    const { row, identity } = await conversation();
    await runZeliTurn({
      identity,
      conversationId: row.id,
      question: "Show me November contributions",
    });
    const first = await prisma.zeliConversation.findUniqueOrThrow({ where: { id: row.id } });
    expect(first.title).toBe("November Business Summary");
    expect(first.titleSource).toBe("auto");

    await runZeliTurn({
      identity,
      conversationId: row.id,
      question: "Review expenses too",
    });
    const second = await prisma.zeliConversation.findUniqueOrThrow({ where: { id: row.id } });
    expect(second.title).toBe("November Business Summary");
  });

  it("preserves a manual title", async () => {
    const { row, identity } = await conversation({
      title: "My own title",
      titleSource: "manual",
    });
    await runZeliTurn({
      identity,
      conversationId: row.id,
      question: "Show me branch performance",
    });
    const stored = await prisma.zeliConversation.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.title).toBe("My own title");
    expect(stored.titleSource).toBe("manual");
  });

  it("uses a safe fallback for a greeting and keeps existing conversations working", async () => {
    const { row, identity } = await conversation();
    await runZeliTurn({
      identity,
      conversationId: row.id,
      question: "Hello",
    });
    const stored = await prisma.zeliConversation.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.title).toBe("Business Question");
  });
});
