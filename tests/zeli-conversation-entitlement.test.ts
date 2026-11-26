/**
 * Zeli conversation entitlement.
 *
 * The owner approved external conversation for paid businesses. These tests prove
 * that the approval is a code gate and not the entitlement: a free, unpaid, lapsed,
 * suspended, add-on-only or over-quota business is refused, every refusal names
 * something an owner can act on, and the investigation add-on can never be mistaken
 * for a conversation package (or the reverse).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, createTestAdmin, createTestTenant, prisma } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({ mockCookieStore: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined),
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));

import {
  CONVERSATION_ENTITLEMENT_VERSION,
  evaluateConversationEntitlement,
  resolveConversationEntitlement,
  type ConversationEntitlementInputs,
} from "@/lib/zeli/conversation-entitlement";
import {
  getConversationPolicy,
  PRODUCTION_CONVERSATION_APPROVED,
} from "@/lib/zeli/providers/conversation-policy";
import { usagePeriodKey } from "@/lib/zeli/usage";

const NOW = new Date("2026-12-15T09:00:00.000Z");

function inputs(overrides: Partial<ConversationEntitlementInputs> = {}): ConversationEntitlementInputs {
  return {
    subscription: {
      status: "active",
      paidAt: new Date("2026-12-01T08:00:00.000Z"),
      periodEnd: new Date("2027-01-01T00:00:00.000Z"),
      plan: {
        code: "business",
        name: "Business",
        zeliIncluded: true,
        usageAllowance: 600,
        addonKey: null,
      },
    },
    usage: { requests: 100 },
    now: NOW,
    ...overrides,
  };
}

describe("conversation entitlement decision", () => {
  it("allows a paid, current package with allowance left", () => {
    const decision = evaluateConversationEntitlement(inputs());
    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("active");
    expect(decision.planCode).toBe("business");
    expect(decision.allowance).toBe(600);
    expect(decision.remaining).toBe(500);
    expect(decision.period).toBe("2026-12");
    expect(decision.guidance).toMatch(/500 of 600 requests left/);
  });

  it("denies a free business and says what to do", () => {
    const decision = evaluateConversationEntitlement(inputs({ subscription: null }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no_subscription");
    expect(decision.state).toBe("denied");
    expect(decision.guidance).toMatch(/included with a paid MaaCash package/i);
  });

  it("never treats an add-on-only plan as a conversation package", () => {
    const decision = evaluateConversationEntitlement(
      inputs({
        subscription: {
          status: "active",
          paidAt: NOW,
          periodEnd: new Date("2027-01-15T00:00:00.000Z"),
          plan: {
            code: "ai-investigation",
            name: "AI Investigation",
            zeliIncluded: true,
            usageAllowance: 50,
            addonKey: "ai_investigation",
          },
        },
      })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("addon_only");
  });

  it("denies an unpaid package", () => {
    const decision = evaluateConversationEntitlement(
      inputs({
        subscription: {
          status: "pending",
          paidAt: null,
          periodEnd: null,
          plan: { code: "starter", name: "Starter", zeliIncluded: true, usageAllowance: 250, addonKey: null },
        },
      })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("payment_pending");
    expect(decision.state).toBe("payment_pending");
  });

  it("denies a subscription the provider has not confirmed", () => {
    const decision = evaluateConversationEntitlement(
      inputs({
        subscription: {
          status: "active",
          paidAt: null,
          periodEnd: new Date("2027-01-01T00:00:00.000Z"),
          plan: { code: "starter", name: "Starter", zeliIncluded: true, usageAllowance: 250, addonKey: null },
        },
      })
    );
    expect(decision.reason).toBe("payment_unconfirmed");
  });

  it("denies a suspended package", () => {
    expect(
      evaluateConversationEntitlement(
        inputs({
          subscription: {
            status: "suspended",
            paidAt: new Date("2026-11-01T00:00:00.000Z"),
            periodEnd: new Date("2026-12-01T00:00:00.000Z"),
            plan: { code: "starter", name: "Starter", zeliIncluded: true, usageAllowance: 250, addonKey: null },
          },
        })
      ).reason
    ).toBe("subscription_suspended");
  });

  it("denies a cancelled or lapsed subscription", () => {
    expect(
      evaluateConversationEntitlement(
        inputs({
          subscription: {
            status: "cancelled",
            paidAt: new Date("2026-11-01T00:00:00.000Z"),
            periodEnd: new Date("2026-12-01T00:00:00.000Z"),
            plan: { code: "starter", name: "Starter", zeliIncluded: true, usageAllowance: 250, addonKey: null },
          },
        })
      ).reason
    ).toBe("subscription_inactive");
  });

  it("denies a paid period that has ended", () => {
    const decision = evaluateConversationEntitlement(
      inputs({
        subscription: {
          status: "active",
          paidAt: new Date("2026-10-01T00:00:00.000Z"),
          periodEnd: new Date("2026-11-01T00:00:00.000Z"),
          plan: { code: "starter", name: "Starter", zeliIncluded: true, usageAllowance: 250, addonKey: null },
        },
      })
    );
    expect(decision.reason).toBe("period_ended");
    expect(decision.state).toBe("lapsed");
  });

  it("denies a package that does not include Zeli", () => {
    const decision = evaluateConversationEntitlement(
      inputs({
        subscription: {
          status: "active",
          paidAt: NOW,
          periodEnd: new Date("2027-01-01T00:00:00.000Z"),
          plan: { code: "legacy", name: "Legacy", zeliIncluded: false, usageAllowance: 100, addonKey: null },
        },
      })
    );
    expect(decision.reason).toBe("not_included");
  });

  it("denies a used-up monthly allowance", () => {
    const decision = evaluateConversationEntitlement(inputs({ usage: { requests: 600 } }));
    expect(decision.reason).toBe("quota_exhausted");
    expect(decision.remaining).toBe(0);
  });

  it("falls back to the standard allowance when a plan has none", () => {
    const decision = evaluateConversationEntitlement(
      inputs({
        subscription: {
          status: "active",
          paidAt: NOW,
          periodEnd: new Date("2027-01-01T00:00:00.000Z"),
          plan: { code: "starter", name: "Starter", zeliIncluded: true, usageAllowance: null, addonKey: null },
        },
        usage: null,
      })
    );
    expect(decision.allowed).toBe(true);
    expect(decision.allowance).toBe(250);
  });

  it("records its own version so a later reviewer can date the rules", () => {
    expect(CONVERSATION_ENTITLEMENT_VERSION).toMatch(/^2026-12-conv-ent\./);
  });
});

describe("conversation policy with the live entitlement", () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;

  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
    process.env.DEEPSEEK_API_KEY = "unit-test-placeholder-not-a-real-key";
    process.env.ZELI_PRIVACY_POLICY_VERSION = "2026-11-conv.1";
    process.env.ZELI_APPROVAL_REFERENCE = "OWNER-APPROVED-CONVERSATION";
    await prisma.zeliProviderControl.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        mode: "approved",
        enabled: true,
        emergencyDisabled: false,
        approvedProvider: "deepseek",
        policyVersion: "2026-11-conv.1",
        approvalReference: "OWNER-APPROVED-CONVERSATION",
      },
      update: {
        mode: "approved",
        enabled: true,
        emergencyDisabled: false,
        approvedProvider: "deepseek",
        policyVersion: "2026-11-conv.1",
        approvalReference: "OWNER-APPROVED-CONVERSATION",
      },
    });
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    delete process.env.ZELI_PRIVACY_POLICY_VERSION;
    delete process.env.ZELI_APPROVAL_REFERENCE;
  });

  async function tenantWith(options: {
    planCode?: string;
    price?: number;
    allowance?: number;
    addonKey?: string | null;
    interval?: string;
    paid?: boolean;
    status?: string;
    periodEnd?: Date | null;
    zeliIncluded?: boolean;
  } = {}) {
    const tenant = await createTestTenant({ momo: true, susu: false });
    const plan = await prisma.zeliPlan.upsert({
      where: { code: options.planCode ?? "business" },
      create: {
        code: options.planCode ?? "business",
        name: "Business",
        billingInterval: options.interval ?? "month",
        price: options.price ?? 169,
        currency: "GHS",
        status: "active",
        isPublic: true,
        usageAllowance: options.allowance ?? 600,
        zeliIncluded: options.zeliIncluded ?? true,
        addonKey: options.addonKey ?? null,
      },
      update: {
        usageAllowance: options.allowance ?? 600,
        zeliIncluded: options.zeliIncluded ?? true,
        addonKey: options.addonKey ?? null,
        billingInterval: options.interval ?? "month",
      },
    });
    await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: options.status ?? "active",
        amount: options.price ?? 169,
        currency: "GHS",
        paidAt: options.paid === false ? null : new Date(),
        periodStart: new Date(Date.now() - 5 * 86_400_000),
        periodEnd: options.periodEnd === undefined ? new Date(Date.now() + 25 * 86_400_000) : options.periodEnd,
        providerReference: `REF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    await prisma.zeliAiTenantAuthorization.create({
      data: { tenantId: tenant.id, enabled: true, reason: "Owner approved external conversation for paid business.", approvedAt: new Date() },
    });
    return tenant;
  }

  it("is approved in code but still refuses a business with no package", async () => {
    expect(PRODUCTION_CONVERSATION_APPROVED).toBe(true);
    const tenant = await createTestTenant({ momo: true, susu: false });
    await prisma.zeliAiTenantAuthorization.create({
      data: { tenantId: tenant.id, enabled: true, reason: "Authorised, but not paying.", approvedAt: new Date() },
    });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed).toBe(false);
    expect(policy.state).toBe("disabled");
    expect(policy.reason).toMatch(/included with a paid MaaCash package/i);
    expect(policy.entitlement?.reason).toBe("no_subscription");
  });

  it("allows a paid monthly package and reports the remaining allowance", async () => {
    const tenant = await tenantWith({ interval: "month" });
    await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed, policy.reason).toBe(true);
    expect(policy.state).toBe("approved");
    expect(policy.entitlement?.planCode).toBe("business");
    expect(policy.entitlement?.remaining).toBe(600);
  });

  it("allows a paid annual package", async () => {
    const tenant = await tenantWith({ planCode: "business-annual", interval: "year", price: 1825 });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed, policy.reason).toBe(true);
    expect(policy.state).toBe("approved");
  });

  it("refuses a lapsed annual package", async () => {
    const tenant = await tenantWith({
      planCode: "business-annual",
      interval: "year",
      periodEnd: new Date(Date.now() - 86_400_000),
    });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed).toBe(false);
    expect(policy.entitlement?.reason).toBe("period_ended");
  });

  it("refuses when the monthly allowance is used up", async () => {
    const tenant = await tenantWith({ allowance: 10 });
    await prisma.zeliUsagePeriod.create({
      data: { tenantId: tenant.id, period: usagePeriodKey(), requests: 10, limit: 10 },
    });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed).toBe(false);
    expect(policy.entitlement?.reason).toBe("quota_exhausted");
  });

  it("refuses an investigation add-on as if it were a package", async () => {
    const tenant = await tenantWith({
      planCode: "ai-investigation",
      addonKey: "ai_investigation",
      allowance: 50,
    });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed).toBe(false);
    expect(policy.entitlement?.reason).toBe("addon_only");
  });

  it("stops conversation the moment the package is suspended", async () => {
    const tenant = await tenantWith();
    expect((await getConversationPolicy(tenant.id)).allowed).toBe(true);
    await prisma.zeliSubscription.updateMany({
      where: { tenantId: tenant.id },
      data: { status: "suspended" },
    });
    const after = await getConversationPolicy(tenant.id);
    expect(after.allowed).toBe(false);
    expect(after.entitlement?.reason).toBe("subscription_suspended");
  });

  it("keeps the emergency stop above the entitlement", async () => {
    const tenant = await tenantWith();
    await prisma.zeliProviderControl.update({
      where: { id: "global" },
      data: { emergencyDisabled: true },
    });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toMatch(/emergency/i);
  });

  it("still requires tenant authorisation before the package is considered", async () => {
    const tenant = await tenantWith();
    await prisma.zeliAiTenantAuthorization.deleteMany({ where: { tenantId: tenant.id } });
    const policy = await getConversationPolicy(tenant.id);
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toMatch(/tenant authorization/i);
  });

  it("resolves the entitlement fresh on each call, not from a cache", async () => {
    const tenant = await tenantWith();
    const first = await resolveConversationEntitlement(tenant.id);
    expect(first.allowed).toBe(true);
    await prisma.zeliSubscription.updateMany({
      where: { tenantId: tenant.id },
      data: { status: "cancelled" },
    });
    const second = await resolveConversationEntitlement(tenant.id);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("subscription_inactive");
  });
});

describe("conversation tool safety", () => {
  it("exposes only read-only tools to an approved conversation", async () => {
    const { ZELI_TOOLS } = await import("@/lib/zeli/tools");
    const definitions = ZELI_TOOLS;
    expect(definitions.length).toBeGreaterThan(0);
    // No conversational tool may write business data, so an approved turn can never
    // become a financial instruction by way of a tool call.
    expect(definitions.every((tool) => tool.readOnly === true)).toBe(true);
  });
});
