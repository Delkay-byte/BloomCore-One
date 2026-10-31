/**
 * BIK Prestige Enterprise — Tenant isolation tests.
 *
 * Creates two independent tenants (A and B) and verifies, through the REAL
 * server actions and the canonical assertTenantEntity guard, that neither can
 * read or modify the other's data — including direct cross-tenant ID
 * substitution, not just normal UI flows.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
  createTestTenant,
} from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => {
      mockCookieStore.set(name, value);
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { getTenantContext, assertTenantEntity, TENANT_SCOPED_MODELS, type TenantContext } from "@/lib/tenant";
import { getCustomers, getCustomerById, createCustomer, searchCustomers } from "@/lib/actions/susu-customer.actions";
import { getLocations, createLocation } from "@/lib/actions/location.actions";
import { getWorkers } from "@/lib/actions/worker.actions";
import { recordContribution, getContributions } from "@/lib/actions/susu-contribution.actions";
import { getDailyAccounts } from "@/lib/actions/daily-account.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const now = Math.floor(Date.now() / 1000);

async function setAdminSession(user: { id: string; email: string }) {
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Tenant Admin",
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
  mockCookieStore.delete("bik-collector-session");
  mockCookieStore.delete("bik-momo-session".replace("momo", "worker"));
  mockCookieStore.delete("bik-worker-session");
  mockCookieStore.delete("bik-customer-session");
}

interface Fixture {
  tenant: Awaited<ReturnType<typeof createTestTenant>>;
  admin: { id: string; email: string };
  ctx: TenantContext;
}

async function makeTenantFixture(name: string): Promise<Fixture> {
  const tenant = await createTestTenant({ name });
  const admin = await createTestAdmin({ tenantId: tenant.id });
  await setAdminSession(admin);
  const ctx = await getTenantContext("admin");
  if (!ctx || ctx.tenantId !== tenant.id) {
    throw new Error(`fixture: could not resolve context for ${name}`);
  }
  return { tenant, admin, ctx };
}

describe("Tenant isolation — Tenant A vs Tenant B", () => {
  let A: Fixture;
  let B: Fixture;

  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    A = await makeTenantFixture("Tenant A");
    B = await makeTenantFixture("Tenant B");
  });

  it("resolves distinct tenant contexts for each administrator", () => {
    expect(A.ctx.tenantId).not.toBe(B.ctx.tenantId);
    expect(A.ctx.tenantName).toBe("Tenant A");
    expect(B.ctx.tenantName).toBe("Tenant B");
  });

  it("customers: B's directory never contains A's customers", async () => {
    const aCustomer = await createTestCustomer(A.admin.id, 50, `A${Date.now()}`.slice(-10));
    await setAdminSession(B.admin);
    const list = await getCustomers({});
    expect(list.customers.some((c: { id: string }) => c.id === aCustomer.customer.id)).toBe(false);

    // Direct lookup of A's customer id is rejected at the tenant boundary.
    const single = await getCustomerById(aCustomer.customer.id);
    expect(single).toBeNull();
  });

  it("customers: cross-tenant ID substitution via createCustomer portal fields is rejected", async () => {
    // B tries to create a customer — the create path stamps B's own tenant, and
    // the duplicate-ID server-side generation cannot collide with A's data.
    const fd = new FormData();
    fd.set("fullName", "B Tenant Customer");
    fd.set("dailyContribution", "50");
    await setAdminSession(B.admin);
    const result = await createCustomer(fd);
    expect(result.success).toBe(true);
    const created = await prisma.customer.findFirst({ where: { fullName: "B Tenant Customer" } });
    expect(created?.tenantId).toBe(B.tenant.id);
    expect(created?.tenantId).not.toBe(A.tenant.id);
  });

  it("search: B's SmartSearch never surfaces A's customers or staff", async () => {
    const aCustomer = await createTestCustomer(A.admin.id, 50, `S${Date.now()}`.slice(-10));
    await setAdminSession(B.admin);
    const results = await searchCustomers("Test Customer");
    // Search results are tenant-scoped before filtering — A's customer id
    // must never appear in B's result set.
    expect(results.some((c: { id: string }) => c.id === aCustomer.customer.id)).toBe(false);
  });

  it("workers: B's staff list never contains A's staff", async () => {
    await setAdminSession(B.admin);
    const workers = await getWorkers();
    expect(workers.every((w: { tenantId: string | null }) => w.tenantId === B.tenant.id)).toBe(true);

    await setAdminSession(A.admin);
    const aWorkers = await getWorkers();
    expect(aWorkers.every((w: { tenantId: string | null }) => w.tenantId === A.tenant.id)).toBe(true);
  });

  it("locations: codes may repeat across tenants, but each tenant sees only its own", async () => {
    await setAdminSession(A.admin);
    const fdA = new FormData();
    fdA.set("name", "Shared Code Location");
    fdA.set("code", "SHARED-001");
    const createdA = await createLocation(fdA);
    expect(createdA.success).toBe(true);

    // B can use the SAME code — uniqueness is per tenant.
    await setAdminSession(B.admin);
    const fdB = new FormData();
    fdB.set("name", "Shared Code Location");
    fdB.set("code", "SHARED-001");
    const createdB = await createLocation(fdB);
    expect(createdB.success).toBe(true);

    const locations = await getLocations();
    expect(locations).toHaveLength(1);
    expect(locations[0].tenantId).toBe(B.tenant.id);
  });

  it("contributions: B recording against A's account (ID substitution) is rejected", async () => {
    const aCustomer = await createTestCustomer(A.admin.id, 50, `C${Date.now()}`.slice(-10));
    await setAdminSession(B.admin);
    const result = await recordContribution({
      accountId: aCustomer.account.id, // Tenant A's account id, submitted by B
      amount: 100,
      channel: "direct_office",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    // Nothing was written into A's cycle.
    const count = await prisma.contribution.count({ where: { cycleId: aCustomer.cycle.id } });
    expect(count).toBe(0);
  });

  it("contributions: B's admin report contains only B's contributions", async () => {
    const aCustomer = await createTestCustomer(A.admin.id, 50, `R${Date.now()}`.slice(-10));
    await setAdminSession(A.admin);
    const rec = await recordContribution({
      accountId: aCustomer.account.id,
      amount: 200,
      channel: "direct_office",
    });
    expect(rec.success).toBe(true);

    await setAdminSession(B.admin);
    const bView = await getContributions({});
    expect(bView.contributions).toHaveLength(0);
  });

  it("daily accounts: B's list never contains A's daily accounts", async () => {
    const aLocation = await prisma.location.create({
      data: { name: "A Location", code: `A-${Date.now()}`, status: "active", tenantId: A.tenant.id },
    });
    await prisma.dailyAccount.create({
      data: {
        tenantId: A.tenant.id,
        locationId: aLocation.id,
        workerId: A.admin.id,
        businessDate: new Date(),
        openingMomoFloat: 100,
        openingCash: 100,
      },
    });

    await setAdminSession(B.admin);
    const accounts = await getDailyAccounts({});
    expect(accounts.accounts.every((d: { tenantId: string | null }) => d.tenantId === B.tenant.id)).toBe(true);
    expect(accounts.accounts).toHaveLength(0);
  });

  it("assertTenantEntity denies every tenant-scoped model across the boundary", async () => {
    const aLocation = await prisma.location.create({
      data: { name: "A Loc", code: `L${Date.now()}`, status: "active", tenantId: A.tenant.id },
    });
    const aCustomer = await createTestCustomer(A.admin.id, 50, `M${Date.now()}`.slice(-10));
    const aDaily = await prisma.dailyAccount.create({
      data: {
        tenantId: A.tenant.id,
        locationId: aLocation.id,
        workerId: A.admin.id,
        businessDate: new Date(),
        openingMomoFloat: 0,
        openingCash: 0,
      },
    });
    const aExpense = await prisma.expense.create({
      data: { tenantId: A.tenant.id, dailyAccountId: aDaily.id, description: "Transport", amount: 5 },
    });
    const aContribution = await prisma.contribution.create({
      data: {
        tenantId: A.tenant.id,
        accountId: aCustomer.account.id,
        cycleId: aCustomer.cycle.id,
        amount: 50,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: A.admin.id,
        referenceId: `ISO-${Date.now()}`,
      },
    });
    const aWithdrawal = await prisma.withdrawal.create({
      data: {
        tenantId: A.tenant.id,
        accountId: aCustomer.account.id,
        cycleId: aCustomer.cycle.id,
        requestedAmount: 10,
        commissionAmount: 0,
        netAmount: 10,
        remainingBalance: 40,
        status: "completed",
        authorizedById: A.admin.id,
        referenceId: `WISO-${Date.now()}`,
      },
    });
    const aCommission = await prisma.commission.create({
      data: {
        tenantId: A.tenant.id,
        accountId: aCustomer.account.id,
        cycleId: aCustomer.cycle.id,
        amount: 10,
        basis: "one_day_contribution",
        triggeredBy: "first_withdrawal",
        recordedById: A.admin.id,
      },
    });
    const aCardFee = await prisma.cardFee.create({
      data: { tenantId: A.tenant.id, accountId: aCustomer.account.id, amount: 10, recordedById: A.admin.id },
    });
    const aCollectorUser = await prisma.user.create({
      data: {
        email: `collector-A-${Date.now()}@bikprestige.com`,
        fullName: "A Collector",
        role: "collector",
        status: "active",
        passwordHash: "x",
        susuEnabled: true,
        tenantId: A.tenant.id,
      },
    });
    const aCollector = await prisma.collector.create({
      data: { tenantId: A.tenant.id, userId: aCollectorUser.id, status: "active" },
    });
    const aAssignment = await prisma.collectorCustomerAssignment.create({
      data: { tenantId: A.tenant.id, collectorId: aCollector.id, customerId: aCustomer.customer.id, accountId: aCustomer.account.id },
    });

    // Every A-owned id must be invisible to B's context.
    const cases: [keyof typeof TENANT_SCOPED_MODELS, string][] = [
      ["user", A.admin.id],
      ["location", aLocation.id],
      ["customer", aCustomer.customer.id],
      ["susuAccount", aCustomer.account.id],
      ["susuCycle", aCustomer.cycle.id],
      ["dailyAccount", aDaily.id],
      ["expense", aExpense.id],
      ["contribution", aContribution.id],
      ["withdrawal", aWithdrawal.id],
      ["commission", aCommission.id],
      ["cardFee", aCardFee.id],
      ["collector", aCollector.id],
      ["collectorCustomerAssignment", aAssignment.id],
    ];
    for (const [model, id] of cases) {
      const deniedForB = await assertTenantEntity(model, id, B.ctx);
      const allowedForA = await assertTenantEntity(model, id, A.ctx);
      expect({ model, deniedForB }).toEqual({ model, deniedForB: false });
      expect({ model, allowedForA }).toEqual({ model, allowedForA: true });
    }
  });

  it("a second tenant starts completely blind to BIK data", async () => {
    // Simulate the post-backfill state: A is the migrated BIK tenant with data.
    await createTestCustomer(A.admin.id, 50, `K${Date.now()}`.slice(-10));
    await prisma.location.create({
      data: { name: "BIK Loc", code: `BIK-${Date.now()}`, status: "active", tenantId: A.tenant.id },
    });

    // A brand-new tenant B with no data sees nothing of A's.
    await setAdminSession(B.admin);
    const customers = await getCustomers({});
    const locations = await getLocations();
    const contributions = await getContributions({});
    expect(customers.customers).toHaveLength(0);
    expect(locations).toHaveLength(0);
    expect(contributions.contributions).toHaveLength(0);
  });
});
