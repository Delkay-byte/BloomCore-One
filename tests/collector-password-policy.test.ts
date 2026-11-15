import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const state = vi.hoisted(() => ({ tenantId: "" }));

vi.mock("@/lib/tenant", () => ({
  requireTenantAdminSusu: async () => ({
    tenantId: state.tenantId,
    userId: "policy-admin",
  }),
  requireTenantCollector: async () => ({
    tenantId: state.tenantId,
    userId: "policy-admin",
  }),
  getTenantContext: async () => null,
  assertTenantEntity: async () => false,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { createCollector } from "@/lib/actions/susu-collector.actions";
import { clearEmailOutbox } from "@/lib/email/resend";

const STRONG = "Strong!Pass1234";

describe("collector creation password policy", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearEmailOutbox();
    const tenant = await prisma.businessTenant.create({
      data: { code: `POL-${Date.now()}`, name: "Policy Tenant" },
    });
    state.tenantId = tenant.id;
  });

  it("rejects every weak-password class without creating a user or collector", async () => {
    const weakPasswords = [
      "short",
      "alllowercase123!",
      "ALLUPPERCASE123!",
      "NoNumbers!!!Abc",
      "NoSymbols123Abc",
      `Aa1!${"x".repeat(260)}`,
    ];

    for (const password of weakPasswords) {
      const form = new FormData();
      form.set("fullName", "Weak Collector");
      form.set("email", `weak-${Date.now()}-${Math.random()}@example.com`);
      form.set("password", password);
      const result = await createCollector(form);
      expect(result.success).toBe(false);
    }

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.collector.count()).toBe(0);
  });

  it("creates the collector with a compliant password", async () => {
    const form = new FormData();
    form.set("fullName", "Valid Collector");
    form.set("email", "valid-collector@example.com");
    form.set("password", STRONG);
    const result = await createCollector(form);
    expect(result.success).toBe(true);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.collector.count()).toBe(1);
  });
});
