import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  assertZeliTenantEnabled,
  getTenantZeliAccess,
  TENANT_DISABLED_MESSAGE,
  ZeliTenantDisabledError,
} from "@/lib/zeli/availability";
import { getConversationStatus } from "@/lib/zeli/providers/conversation-provider";
import { getZeliAvailability } from "@/lib/zeli/availability";
import { TEAM_TESTING_DISCLOSURE_VERSION } from "@/lib/zeli/provider-control";

async function tenant(code = `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`) {
  return prisma.businessTenant.create({
    data: { code, name: `Zeli ${code}`, status: "ACTIVE", onboardingStatus: "COMPLETED" },
  });
}

async function admin(tenantId: string) {
  return prisma.user.create({
    data: {
      tenantId,
      email: `zeli-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`,
      fullName: "Zeli Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  vi.unstubAllEnvs();
  await prisma.zeliAvailability.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: true },
    update: { enabled: true, reason: null },
  });
});

describe("per-business Zeli access", () => {
  it("is enabled by default for a business with no override", async () => {
    const t = await tenant();
    const access = await getTenantZeliAccess(t.id);
    expect(access.enabled).toBe(true);
    expect(access.source).toBe("default");
    await expect(assertZeliTenantEnabled(t.id)).resolves.toBeUndefined();
  });

  it("is refused server-side after a platform disable", async () => {
    const t = await tenant();
    await prisma.zeliTenantAccess.create({
      data: { tenantId: t.id, enabled: false, reason: "Complaint under review" },
    });

    const access = await getTenantZeliAccess(t.id);
    expect(access.enabled).toBe(false);
    expect(access.reason).toBe("Complaint under review");
    await expect(assertZeliTenantEnabled(t.id)).rejects.toBeInstanceOf(ZeliTenantDisabledError);
    await expect(assertZeliTenantEnabled(t.id)).rejects.toMatchObject({
      code: "zeli_tenant_disabled",
      message: TENANT_DISABLED_MESSAGE,
    });
  });

  it("keeps conversations and usage when the business is disabled and re-enabled", async () => {
    const t = await tenant();
    const user = await admin(t.id);
    const conversation = await prisma.zeliConversation.create({
      data: { tenantId: t.id, userId: user.id, title: "Kept history" },
    });
    await prisma.zeliUsagePeriod.create({
      data: { tenantId: t.id, period: new Date().toISOString().slice(0, 7), requests: 4, limit: 250 },
    });

    await prisma.zeliTenantAccess.create({ data: { tenantId: t.id, enabled: false, reason: "Paused" } });
    await prisma.zeliTenantAccess.update({ where: { tenantId: t.id }, data: { enabled: true, reason: "Resumed" } });

    expect(await getTenantZeliAccess(t.id)).toMatchObject({ enabled: true, reason: "Resumed" });
    expect(await prisma.zeliConversation.count({ where: { id: conversation.id } })).toBe(1);
    const usage = await prisma.zeliUsagePeriod.findFirstOrThrow({ where: { tenantId: t.id } });
    expect(usage.requests).toBe(4);
  });

  it("follows the global switch even when the business has no override", async () => {
    const t = await tenant();
    await prisma.zeliAvailability.update({ where: { id: "global" }, data: { enabled: false } });
    expect((await getZeliAvailability()).enabled).toBe(false);
    await expect(assertZeliTenantEnabled(t.id)).rejects.toMatchObject({ code: "zeli_unavailable" });
  });
});

describe("Team Testing no longer leaks into a normal business", () => {
  async function teamTestingControl() {
    await prisma.zeliProviderControl.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        mode: "team_testing",
        enabled: true,
        emergencyDisabled: false,
        approvedProvider: "deepseek",
        policyVersion: TEAM_TESTING_DISCLOSURE_VERSION,
      },
      update: {
        mode: "team_testing",
        enabled: true,
        emergencyDisabled: false,
        approvedProvider: "deepseek",
        policyVersion: TEAM_TESTING_DISCLOSURE_VERSION,
      },
    });
  }

  it("reports local mode, not team testing, for an ordinary business", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key-not-used");
    await teamTestingControl();
    const t = await tenant("BT-ORDINARY-1");
    const user = await admin(t.id);

    const status = await getConversationStatus(t.id, user.id);
    expect(status.teamTesting).toBe(false);
    expect(status.mode).toBe("local");
  });

  it("still reports team testing for the authorised tenant and tester", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key-not-used");
    vi.stubEnv("ZELI_TEAM_TESTING_ALLOWED", "true");
    vi.stubEnv("ZELI_TEAM_TESTING_TENANT_CODE", "BIK-HQ-001");
    await teamTestingControl();
    const t = await tenant("BIK-HQ-001");
    const user = await admin(t.id);
    await prisma.zeliAiTenantAuthorization.create({
      data: { tenantId: t.id, enabled: true, reason: "Team testing tenant" },
    });
    await prisma.zeliTeamTester.create({
      data: {
        tenantId: t.id,
        userId: user.id,
        status: "active",
        disclosureVersion: TEAM_TESTING_DISCLOSURE_VERSION,
        disclosureAcceptedAt: new Date(),
        reason: "Automated team-testing check",
      },
    });

    const status = await getConversationStatus(t.id, user.id);
    expect(status.teamTesting).toBe(true);
    expect(status.mode).toBe("external");
  });
});
