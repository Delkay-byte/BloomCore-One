import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestAdmin, createTestTenant, prisma } from "./setup";
import { classifyIntent, isSupportedForRole } from "@/lib/zeli/intelligence/intents";
import { runZeliTurn } from "@/lib/zeli/service";

beforeEach(async () => {
  await cleanDatabase();
});

describe("Zeli intent recognition", () => {
  it("maps supported business questions to explicit intents and periods", () => {
    expect(classifyIntent("Summarise today's activity").intent).toBe("business_summary");
    expect(classifyIntent("Summarise today's activity").period).toBe("today");
    expect(classifyIntent("Compare this month with last month").intent).toBe("compare_periods");
    expect(classifyIntent("Summarise contributions and withdrawals").intent).toBe(
      "contributions_withdrawals"
    );
    expect(classifyIntent("Summarise remittance activity").intent).toBe("remittances");
    expect(classifyIntent("Show outstanding operational exceptions").intent).toBe("exceptions");
    expect(classifyIntent("Compare branch performance this month").intent).toBe("branches");
    expect(classifyIntent("Why did contributions change?").intent).toBe("why_changed");
    expect(classifyIntent("Find customer BIK-C-001").intent).toBe("customer_lookup");
    expect(
      classifyIntent("Explain how the net cash flow metric is calculated").intent
    ).toBe("metric_definition");
    expect(classifyIntent("Explain this chart for contributions and withdrawals").intent).toBe(
      "chart_explanation"
    );
    expect(classifyIntent("Explain this chart for contributions and withdrawals").chartId).toBe(
      "contributions_vs_withdrawals"
    );
  });

  it("treats a non-business request as unsupported", () => {
    expect(classifyIntent("Write me a poem about the sea").intent).toBe("unsupported");
    expect(classifyIntent("What is the weather tomorrow?").intent).toBe("unsupported");
  });

  it("limits non-admin roles to their supported questions", () => {
    expect(isSupportedForRole("worker", "What is the status of today's daily account?")).toBe(true);
    expect(isSupportedForRole("worker", "Compare all tenant branch revenue")).toBe(false);
    expect(isSupportedForRole("collector", "How many customers are assigned to me?")).toBe(true);
    expect(isSupportedForRole("customer", "Summarise my savings account")).toBe(true);
    expect(isSupportedForRole("customer", "Show every customer in the business")).toBe(false);
  });
});

describe("Zeli providerless answers", () => {
  it("answers a supported comparison from server-computed metrics", async () => {
    const tenant = await createTestTenant({ name: "Intent Tenant" });
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenant.id, userId: admin.id },
    });
    const fetchMock = vi.fn();
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
      question: "Compare this month with last month.",
    });

    expect(result.intent).toBe("compare_periods");
    expect(result.text).toContain("CALCULATED FACT");
    expect(result.text).toContain("Compared with");
    expect(result.text).toContain("PERIOD");
    expect(result.text).toContain("SOURCE");
    expect(result.text).toContain("FRESHNESS");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns an honest limitation for an unsupported question", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenant.id, userId: admin.id },
    });
    const result = await runZeliTurn({
      identity: {
        userId: admin.id,
        fullName: "Admin",
        role: "admin",
        tenantId: tenant.id,
        module: "admin",
      },
      conversationId: conversation.id,
      question: "Draft a marketing plan for a new product",
    });
    expect(result.intent).toBe("unsupported");
    expect(result.text).toContain("outside the set");
    expect(result.text).toContain("will not invent an answer");
  });

  it("explains a metric definition without reading financial totals", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenant.id, userId: admin.id },
    });
    const result = await runZeliTurn({
      identity: {
        userId: admin.id,
        fullName: "Admin",
        role: "admin",
        tenantId: tenant.id,
        module: "admin",
      },
      conversationId: conversation.id,
      question: "Explain how the net cash flow metric is calculated",
    });
    expect(result.intent).toBe("metric_definition");
    expect(result.text).toContain("Net cash flow = contributions");
    expect(result.text).toContain("does not ask a language model to total money");
  });

  it("gives a customer role a limitation instead of tenant analytics", async () => {
    const tenant = await createTestTenant();
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerId: "BIK-C-ROLE-1",
        fullName: "Role Customer",
        status: "active",
      },
    });
    await prisma.susuAccount.create({
      data: {
        tenantId: tenant.id,
        accountId: "BIK-S-ROLE-1",
        customerId: customer.id,
        dailyContribution: 10,
        status: "active",
      },
    });
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: tenant.id, userId: customer.id, userType: "customer" },
    });
    const result = await runZeliTurn({
      identity: {
        userId: customer.id,
        fullName: "Role Customer",
        role: "customer",
        tenantId: tenant.id,
        module: "customer",
      },
      conversationId: conversation.id,
      question: "Compare every branch's revenue for the quarter",
    });
    expect(result.intent).toBe("unsupported");
    expect(result.text).toContain("outside the set");
  });
});
