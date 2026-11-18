import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

/**
 * A business provisioned by Platform Super Admin starts in PENDING_PAYMENT,
 * and a suspended business must be able to reach billing to settle its balance.
 * Both must resolve a tenant context for the administrator; money operations
 * stay blocked elsewhere. Unknown/archived statuses stay denied and must send an
 * administrator to the administrator login, never the shared staff login.
 */

const session = vi.hoisted(() => ({ payload: null as null | Record<string, unknown> }));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("@/lib/auth", () => ({
  getAdminSession: async () => session.payload,
  getMomoSession: async () => null,
  getSusuSession: async () => null,
  getCustomerSession: async () => null,
}));

import { getTenantContext, requireTenantContext } from "@/lib/tenant";

async function tenantWithStatus(status: string) {
  return prisma.businessTenant.create({
    data: {
      code: `BT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Status Tenant",
      momoEnabled: true,
      susuEnabled: true,
      status,
      onboardingStatus: "COMPLETED",
    },
  });
}

async function adminFor(tenantId: string) {
  const user = await prisma.user.create({
    data: {
      tenantId,
      email: `admin-${Math.random().toString(36).slice(2, 8)}@example.com`,
      fullName: "Status Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  session.payload = {
    userId: user.id,
    role: "admin",
    tenantId,
    module: "admin",
    tokenVersion: user.tokenVersion,
  };
  return user;
}

describe("tenant status access", () => {
  beforeEach(async () => {
    await cleanDatabase();
    session.payload = null;
  });

  it("opens the workspace for an active business", async () => {
    const tenant = await tenantWithStatus("ACTIVE");
    await adminFor(tenant.id);
    const ctx = await getTenantContext("admin");
    expect(ctx?.tenantId).toBe(tenant.id);
  });

  it("opens billing for a newly provisioned pending-payment business", async () => {
    const tenant = await tenantWithStatus("PENDING_PAYMENT");
    await adminFor(tenant.id);
    const plan = await prisma.zeliPlan.create({
      data: {
        code: `starter-${Math.random().toString(36).slice(2, 7)}`,
        name: "Starter",
        billingInterval: "month",
        price: 99,
        status: "active",
        isPublic: true,
      },
    });
    await prisma.zeliSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "pending_payment",
        provider: "paystack",
        providerReference: "PEND-ACCESS-1",
        amount: 99,
        currency: "GHS",
        billingTerm: "monthly",
        standardAmount: 99,
      },
    });

    const ctx = await getTenantContext("admin");
    expect(ctx?.tenantId).toBe(tenant.id);
    // Paid operations remain blocked by the subscription state, not this guard.
    await expect(requireTenantAdminMomoForTest()).rejects.toThrow(
      "REDIRECT:/admin/billing?payment=required"
    );
  });

  it("still blocks a suspended business and returns the admin to the admin login", async () => {
    const tenant = await tenantWithStatus("SUSPENDED");
    await adminFor(tenant.id);
    expect(await getTenantContext("admin")).toBeNull();
    await expect(requireTenantContext("admin")).rejects.toThrow(
      "REDIRECT:/admin/login?reason=tenant_unavailable"
    );
  });

  it("denies an archived business and sends the admin to the admin login", async () => {
    const tenant = await tenantWithStatus("ARCHIVED");
    await adminFor(tenant.id);
    expect(await getTenantContext("admin")).toBeNull();
    await expect(requireTenantContext("admin")).rejects.toThrow(
      "REDIRECT:/admin/login?reason=tenant_unavailable"
    );
  });

  it("keeps the customer portal closed for a suspended business", async () => {
    const tenant = await tenantWithStatus("SUSPENDED");
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerId: `TEST-C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        fullName: "Portal Customer",
        phone: "0244000123",
        status: "active",
        portalEnabled: true,
        portalPasswordHash: "x",
      },
    });
    session.payload = {
      userId: customer.id,
      role: "customer",
      tenantId: tenant.id,
      module: "customer",
      tokenVersion: customer.tokenVersion ?? 0,
    };
    expect(await getTenantContext("customer")).toBeNull();
  });
});

/** Helper that exercises the paid-operations gate with the mocked redirect. */
async function requireTenantAdminMomoForTest() {
  const { requireTenantAdminMomo } = await import("@/lib/tenant");
  return requireTenantAdminMomo();
}
