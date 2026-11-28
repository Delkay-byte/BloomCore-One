import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

/**
 * Owner-dashboard access matrix — the conditions that used to be confused.
 *
 * A package restriction, a role denial, a branch denial and a temporary
 * backend failure are four different things. None of them may sign the owner
 * out, and only a genuinely expired session reaches the sign-in flow. These
 * tests exercise the real server guards against the real test database; the
 * session cookie and the framework redirect are the only mocks.
 */

const session = vi.hoisted(() => ({
  payload: null as null | Record<string, unknown>,
  current: true,
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("@/lib/auth", () => ({
  // Mirror the real cookie readers: module-scoped, and a dead session
  // (expired or revoked server-side record) yields null before any tenant
  // chain runs.
  getAdminSession: async () =>
    session.current && session.payload?.module === "admin" ? session.payload : null,
  getMomoSession: async () =>
    session.current && session.payload?.module === "momo" ? session.payload : null,
  getSusuSession: async () =>
    session.current && session.payload?.module === "susu" ? session.payload : null,
  getCustomerSession: async () =>
    session.current && session.payload?.module === "customer" ? session.payload : null,
  isSessionCurrent: async () => session.current,
}));

import {
  getTenantContext,
  requireTenantContext,
  requireTenantAdmin,
  requireTenantAdminMomo,
  TenantContextError,
} from "@/lib/tenant";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { redirectPathFromError } from "@/lib/errors";
import { assertBranchAccess } from "@/lib/branch";
import { db } from "@/lib/db";

async function tenantWithStatus(status: string, modules?: { momo?: boolean; susu?: boolean }) {
  return prisma.businessTenant.create({
    data: {
      code: `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Access Matrix Tenant",
      momoEnabled: modules?.momo ?? true,
      susuEnabled: modules?.susu ?? true,
      status,
      onboardingStatus: "COMPLETED",
    },
  });
}

async function adminFor(tenantId: string, role = "admin", flags?: { momo?: boolean; susu?: boolean }) {
  const user = await prisma.user.create({
    data: {
      tenantId,
      email: `matrix-${Math.random().toString(36).slice(2, 8)}@example.com`,
      fullName: "Access Matrix Admin",
      role,
      status: "active",
      passwordHash: "x",
      momoEnabled: flags?.momo ?? true,
      susuEnabled: flags?.susu ?? true,
    },
  });
  session.payload = {
    userId: user.id,
    role,
    tenantId,
    module: "admin",
    tokenVersion: user.tokenVersion,
  };
  return user;
}

async function makePlan() {
  return prisma.zeliPlan.create({
    data: {
      code: `plan-${Math.random().toString(36).slice(2, 7)}`,
      name: "Growth",
      billingInterval: "month",
      price: 150,
      status: "active",
      isPublic: true,
    },
  });
}

async function subscriptionFor(
  tenantId: string,
  planId: string,
  status: string,
  options?: { periodEnd?: Date; graceEndsAt?: Date }
) {
  return prisma.zeliSubscription.create({
    data: {
      tenantId,
      planId,
      status,
      provider: "paystack",
      providerReference: `MATRIX-${Math.random().toString(36).slice(2, 10)}`,
      amount: 150,
      currency: "GHS",
      billingTerm: "monthly",
      standardAmount: 150,
      periodEnd: options?.periodEnd ?? null,
      graceEndsAt: options?.graceEndsAt ?? null,
    },
  });
}

function redirectTargetOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => {
      throw new Error("expected the guard to redirect, but it returned normally");
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("REDIRECT:")) throw error;
      return message.slice("REDIRECT:".length);
    }
  );
}

describe("dashboard access matrix — package states", () => {
  beforeEach(async () => {
    await cleanDatabase();
    session.payload = null;
    session.current = true;
  });

  it("1. keeps an authenticated owner signed in when the business has no package yet", async () => {
    const tenant = await tenantWithStatus("PENDING_PAYMENT");
    await adminFor(tenant.id);
    const ctx = await requireTenantContext("admin");
    expect(ctx.tenantId).toBe(tenant.id);
    const access = await resolveSubscriptionAccess(tenant.id);
    expect(access.operable).toBe(false);
    expect(access.reason).toBe("pending_payment");
    expect(access.billingRequired).toBe(true);
  });

  it("2. sends a restricted feature to Billing & Plan with the exact package reason", async () => {
    const cases: { status: string; reason: string; periodEnd?: Date }[] = [
      { status: "pending_payment", reason: "pending_payment" },
      { status: "pending", reason: "pending_payment" },
      { status: "failed", reason: "failed" },
      { status: "suspended", reason: "suspended" },
      { status: "cancelled", reason: "cancelled" },
      { status: "refunded", reason: "refunded" },
      {
        status: "active",
        periodEnd: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        reason: "expired",
      },
    ];
    for (const c of cases) {
      await cleanDatabase();
      const plan = await makePlan();
      const tenant = await tenantWithStatus("ACTIVE");
      await adminFor(tenant.id);
      await subscriptionFor(tenant.id, plan.id, c.status, { periodEnd: c.periodEnd });
      const target = await redirectTargetOf(() => requireTenantAdminMomo());
      expect(target).toBe(`/admin/billing?payment=required&state=${c.reason}`);
    }
  });

  it("3. keeps Billing & Plan reachable for every blocked package state", async () => {
    const statuses = ["pending_payment", "failed", "suspended", "cancelled", "refunded"];
    for (const status of statuses) {
      await cleanDatabase();
      const plan = await makePlan();
      const tenant = await tenantWithStatus("PENDING_PAYMENT");
      await adminFor(tenant.id);
      await subscriptionFor(tenant.id, plan.id, status);
      const ctx = await requireTenantAdmin();
      expect(ctx.tenantId).toBe(tenant.id);
    }
  });

  it("4. retains the session across the billing redirect", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE");
    const user = await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "suspended");
    await redirectTargetOf(() => requireTenantAdminMomo());
    // The very same session still resolves the workspace after the redirect.
    const ctx = await requireTenantContext("admin");
    expect(ctx.userId).toBe(user.id);
    expect(await getTenantContext("admin")).not.toBeNull();
  });

  it("5. allows an active package's included features", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "active", {
      periodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    const ctx = await requireTenantAdminMomo();
    expect(ctx.modules).toContain("momo");
    const access = await resolveSubscriptionAccess(tenant.id);
    expect(access.reason).toBe("active");
    expect(access.operable).toBe(true);
  });

  it("6. keeps an active package from opening a module the business does not have", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE", { momo: true, susu: false });
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "active", {
      periodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    const target = await redirectTargetOf(() => requireTenantContext("admin", "susu"));
    expect(target).toBe("/unauthorized?reason=feature_unavailable");
  });

  it("7. gives an expired package renewal guidance, not a logout", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "active", {
      periodEnd: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const access = await resolveSubscriptionAccess(tenant.id);
    expect(access.reason).toBe("expired");
    expect(access.headline).toMatch(/period ended/i);
    expect(access.detail).toMatch(/renew|billing/i);
    expect(access.operable).toBe(false);
    const ctx = await requireTenantContext("admin");
    expect(ctx.tenantId).toBe(tenant.id);
  });

  it("8. a renewed package restores operations", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "active", {
      periodEnd: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    expect((await resolveSubscriptionAccess(tenant.id)).reason).toBe("expired");
    await subscriptionFor(tenant.id, plan.id, "active", {
      periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const access = await resolveSubscriptionAccess(tenant.id);
    expect(access.reason).toBe("active");
    expect(access.operable).toBe(true);
  });

  it("9. a package in its grace period stays operable", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "grace_period", {
      graceEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    const access = await resolveSubscriptionAccess(tenant.id);
    expect(access.reason).toBe("grace_period");
    expect(access.operable).toBe(true);
  });
});

describe("dashboard access matrix — role, branch and failure states", () => {
  beforeEach(async () => {
    await cleanDatabase();
    session.payload = null;
    session.current = true;
  });

  it("10. shows a role denial without logging out or blaming the subscription", async () => {
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id, "worker");
    const target = await redirectTargetOf(() => requireTenantAdmin());
    // A role denial is a permission answer, not a sign-in request and not a
    // billing redirect.
    expect(target).toBe("/unauthorized");
    expect(target).not.toContain("/admin/login");
    expect(target).not.toContain("/admin/billing");
  });

  it("11. denies an out-of-scope branch without touching the session", async () => {
    const tenant = await tenantWithStatus("ACTIVE");
    const branchA = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Branch A", code: `BA-${tenant.code}`, status: "active" },
    });
    const branchB = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Branch B", code: `BB-${tenant.code}`, status: "active" },
    });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `branch-worker-${Math.random().toString(36).slice(2, 6)}@example.com`,
        fullName: "Branch Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        susuEnabled: false,
      },
    });
    session.payload = {
      userId: worker.id,
      role: "worker",
      tenantId: tenant.id,
      module: "momo",
      tokenVersion: worker.tokenVersion,
    };
    await prisma.branchMembership.create({
      data: { tenantId: tenant.id, userId: worker.id, locationId: branchA.id, role: "finance", status: "active" },
    });
    const ctx = await getTenantContext("momo");
    expect(ctx).not.toBeNull();
    expect(await assertBranchAccess(ctx!, branchA.id, "write")).toBe(true);
    expect(await assertBranchAccess(ctx!, branchB.id, "read")).toBe(false);
    // The denial is scope-only: the same session still resolves the tenant.
    expect((await getTenantContext("momo"))?.userId).toBe(worker.id);
  });

  it("12. sends a genuinely expired session to the proper sign-in flow", async () => {
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    session.current = false;
    const target = await redirectTargetOf(() => requireTenantContext("admin"));
    expect(target).toBe("/admin/login?reason=tenant_unavailable");
  });

  it("13. a temporary backend failure is retryable and never a logout", async () => {
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    const spy = vi.spyOn(db.businessTenant, "findUnique").mockRejectedValue(
      new Error("connection reset")
    );
    let caught: unknown = null;
    try {
      await getTenantContext("admin");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TenantContextError);
    expect((caught as Error).message).toMatch(/try again/i);
    // The guard path must propagate the retryable error, not redirect.
    await expect(requireTenantContext("admin")).rejects.toBeInstanceOf(TenantContextError);
    // The same session works again once the backend recovers.
    spy.mockRestore();
    const ctx = await requireTenantContext("admin");
    expect(ctx.tenantId).toBe(tenant.id);
  });
});

describe("dashboard access matrix — admin card and redirect safety", () => {
  beforeEach(async () => {
    await cleanDatabase();
    session.payload = null;
    session.current = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loginPage(searchParams: Record<string, string>) {
    const page = (await import("@/app/admin/login/page")).default;
    return page({ searchParams: Promise.resolve(searchParams) });
  }

  it("14. recognises a valid existing owner session without re-authentication", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "active", {
      periodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    const target = await redirectTargetOf(() => loginPage({}));
    expect(target).toBe("/admin/dashboard");
  });

  it("15. routes a signed-in owner with a blocked package from the card to Billing & Plan", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("PENDING_PAYMENT");
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "pending_payment");
    const target = await redirectTargetOf(() => loginPage({}));
    expect(target).toBe("/admin/billing?payment=required&state=pending_payment");
  });

  it("16. a deliberate sign-in (switch=1) shows the form instead of restoring a dashboard", async () => {
    const plan = await makePlan();
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    await subscriptionFor(tenant.id, plan.id, "active", {
      periodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    const rendered = await loginPage({ switch: "1" });
    // The form renders: no redirect was thrown.
    expect(rendered).toBeTruthy();
  });

  it("17. an unavailable workspace keeps the sign-in form visible", async () => {
    const tenant = await tenantWithStatus("SUSPENDED");
    await adminFor(tenant.id);
    const rendered = await loginPage({});
    expect(rendered).toBeTruthy();
  });

  it("18. action redirects never carry an open redirect destination", () => {
    // Next 16 builds digests as `NEXT_REDIRECT;type;url;status;` — note the
    // trailing semicolon. Fixtures must match the real format exactly.
    const redirectError = (digest: string) => {
      const e = new Error("NEXT_REDIRECT");
      (e as Error & { digest: string }).digest = digest;
      return e;
    };
    const internal = redirectError("NEXT_REDIRECT;replace;/admin/billing?payment=required&state=expired;307;");
    expect(redirectPathFromError(internal)).toBe("/admin/billing?payment=required&state=expired");

    const absolute = redirectError("NEXT_REDIRECT;replace;https://evil.example.com/grab;307;");
    expect(redirectPathFromError(absolute)).toBeNull();

    const protocolRelative = redirectError("NEXT_REDIRECT;replace;//evil.example.com/grab;307;");
    expect(redirectPathFromError(protocolRelative)).toBeNull();

    expect(redirectPathFromError(new Error("not a redirect"))).toBeNull();
  });
});
