/**
 * BIK Prestige Enterprise — Customer Portal, Smart Search & Office Attribution
 *
 * Tests the pilot-critical behaviours from the spec:
 *  - Customer sees ONLY their own financial records (isolation)
 *  - Office payments store Received By separately from Recorded By
 *  - Smart search is case-insensitive (Kofi === kofi === KOFI)
 *  - Customer statement shows the receiver, never the internal recorder
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test assertions read untyped action payloads */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, cleanDatabase, createTestTenant } from "./setup";

// --- Auth + cache mocking so server actions can run in the test DB ----------
const adminId = "test-admin-id";
const receiverId = "test-receiver-id";
const collectorUserId = "test-collector-user-id";
const collectorId = "test-collector-id";
const custAId = "test-customer-a";
const custBId = "test-customer-b";

let customerSessionId = custAId;

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAdmin: async () => ({ userId: adminId, role: "admin", lastActivityAt: Math.floor(Date.now() / 1000) }),
    requireAuth: async () => ({ userId: adminId, role: "admin", lastActivityAt: Math.floor(Date.now() / 1000) }),
    getAnyAuthUser: async () => ({ userId: adminId, role: "admin", lastActivityAt: Math.floor(Date.now() / 1000) }),
    getAdminSession: async () => ({ userId: adminId, role: "admin", lastActivityAt: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
    getSusuSession: async () => null,
    getCustomerSession: async () => ({
      userId: customerSessionId,
      role: "customer",
      modules: ["customer"],
      lastActivityAt: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    resolveAuthenticatedCollector: async () => null,
    requireCustomer: async () => ({
      userId: customerSessionId,
      role: "customer",
      modules: ["customer"],
    }),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import * as customerActions from "@/lib/actions/susu-customer.actions";
import * as workerActions from "@/lib/actions/worker.actions";
import { getContributions, recordContribution } from "@/lib/actions/susu-contribution.actions";

beforeEach(async () => {
  await cleanDatabase();
  customerSessionId = custAId;

  const tenant = await createTestTenant({ momo: true, susu: true });

  await prisma.user.create({
    data: { id: adminId, email: "admin@bik.test", fullName: "Admin User", role: "admin", status: "active", passwordHash: "x", tenantId: tenant.id },
  });
  await prisma.user.create({
    data: { id: receiverId, email: "receiver@bik.test", fullName: "Ama Mensah", role: "worker", status: "active", passwordHash: "x", tenantId: tenant.id },
  });
  await prisma.user.create({
    data: { id: collectorUserId, email: "collector@bik.test", fullName: "Kofi Mensah", role: "collector", status: "active", passwordHash: "x", susuEnabled: true, tenantId: tenant.id },
  });
  await prisma.collector.create({
    data: { id: collectorId, userId: collectorUserId, status: "active", tenantId: tenant.id },
  });

  await makeCustomer(custAId, "BIK-C-A", "Kofi Mensah", "+233000A", tenant.id);
  await makeCustomer(custBId, "BIK-C-B", "Ama Serwaa", "+233000B", tenant.id);
}, 30_000);

async function makeCustomer(id: string, customerId: string, fullName: string, phone: string, tenantId: string) {
  await prisma.customer.create({
    data: { id, customerId, fullName, phone, status: "active", portalEnabled: true, tenantId },
  });
  const account = await prisma.susuAccount.create({
    data: { accountId: `BIK-S-${customerId}`, customerId: id, dailyContribution: 50, status: "active", cardCustody: "customer", tenantId },
  });
  await prisma.susuCycle.create({
    data: {
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date(2026, 0, 1),
      endDate: new Date(2026, 0, 31),
      dailyContribution: 50,
      status: "active",
      commissionCharged: false,
      tenantId,
    },
  });
}

async function activeAccount(customerId: string) {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  return prisma.susuAccount.findFirstOrThrow({ where: { customerId: c.id } });
}

describe("Smart Search — case insensitivity", () => {
  it("finds a customer for KOFI, kofi and KoFi (all equal)", async () => {
    const upper = await customerActions.searchCustomers("KOFI");
    const lower = await customerActions.searchCustomers("kofi");
    const mixed = await customerActions.searchCustomers("KoFi");
    expect(upper.length).toBeGreaterThan(0);
    expect(lower.length).toBeGreaterThan(0);
    expect(mixed.length).toBeGreaterThan(0);
    const idsUpper = upper.map((u: any) => u.id);
    const idsLower = lower.map((u: any) => u.id);
    expect(idsUpper).toEqual(expect.arrayContaining(idsLower));
  });

  it("finds staff by uppercase AMA and lowercase ama identically", async () => {
    const upper = await workerActions.searchStaff("AMA");
    const lower = await workerActions.searchStaff("ama");
    expect(upper.length).toBeGreaterThan(0);
    expect(lower.length).toBeGreaterThan(0);
    expect(upper.map((u: any) => u.id)).toEqual(expect.arrayContaining(lower.map((u: any) => u.id)));
  });

  it("finds by customer ID fragment regardless of case", async () => {
    const byId = await customerActions.searchCustomers("bik-c-a");
    expect(byId.map((u: any) => u.id)).toContain(custAId);
  });
});

describe("Office payment accountability", () => {
  it("stores Received By separately from Recorded By for direct office", async () => {
    const account = await activeAccount(custAId);
    const result = await recordContribution({
      accountId: account.id,
      amount: 50,
      channel: "direct_office",
      receivedById: receiverId,
    });
    expect(result.success).toBe(true);

    const stored = await prisma.contribution.findUniqueOrThrow({
      where: { id: (result.data as any).contributionId },
    });
    expect(stored.receivedById).toBe(receiverId);
    expect(stored.recordedById).toBe(adminId);
    expect(stored.receivedById).not.toBe(stored.recordedById);
  });

  it("defaults Received By to the recorder when none supplied", async () => {
    const account = await activeAccount(custAId);
    const result = await recordContribution({
      accountId: account.id,
      amount: 50,
      channel: "direct_office",
    });
    const stored = await prisma.contribution.findUniqueOrThrow({
      where: { id: (result.data as any).contributionId },
    });
    expect(stored.receivedById).toBe(adminId);
  });

  it("getContributions exposes Received By to staff (not just the recorder)", async () => {
    const account = await activeAccount(custAId);
    await recordContribution({ accountId: account.id, amount: 50, channel: "direct_office", receivedById: receiverId });

    const { contributions } = await getContributions({});
    expect(contributions.length).toBeGreaterThan(0);
    const office = contributions.find((c: any) => c.channel === "direct_office");
    expect(office!.receivedBy?.fullName).toBe("Ama Mensah");
    expect(office!.recordedBy?.fullName).toBe("Admin User");
  });

  it("rejects an unknown Received By identity", async () => {
    const account = await activeAccount(custAId);
    const result = await recordContribution({
      accountId: account.id,
      amount: 50,
      channel: "direct_office",
      receivedById: "does-not-exist",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/staff/i);
  });

  it("stores the free-text Received By name entered at the office", async () => {
    const account = await activeAccount(custAId);
    const result = await recordContribution({
      accountId: account.id,
      amount: 50,
      channel: "direct_office",
      receivedByName: "Kwame Osei",
    });
    expect(result.success).toBe(true);

    const stored = await prisma.contribution.findUniqueOrThrow({
      where: { id: (result.data as any).contributionId },
    });
    expect(stored.receivedByName).toBe("Kwame Osei");
    // System still records the internal recorder for audit
    expect(stored.recordedById).toBe(adminId);
  });

  it("customer statement shows the typed Received By name, not the recorder", async () => {
    customerSessionId = custAId;
    const account = await activeAccount(custAId);
    await recordContribution({
      accountId: account.id,
      amount: 50,
      channel: "direct_office",
      receivedByName: "Kwame Osei",
    });

    const entries = (await customerActions.getCustomerStatement()) as any[];
    const contribution = entries.find((e) => e.type === "contribution");
    expect(contribution).toBeTruthy();
    expect(contribution.receivedBy).toBe("Kwame Osei");
    expect(contribution.receivedBy).not.toBe("Admin User");
  });
});

describe("Customer data isolation", () => {
  it("customer A only sees their own account", async () => {
    customerSessionId = custAId;
    const account = await customerActions.getCustomerAccount();
    expect((account as any).id).toBe(custAId);
    expect((account as any).customerId).toBe("BIK-C-A");
  });

  it("customer B sees only their own account, never A's", async () => {
    customerSessionId = custBId;
    const account = await customerActions.getCustomerAccount();
    expect((account as any).id).toBe(custBId);
    expect((account as any).customerId).toBe("BIK-C-B");
  });

  it("statement shows the receiver, never the internal recorder", async () => {
    customerSessionId = custAId;
    const account = await activeAccount(custAId);
    await recordContribution({ accountId: account.id, amount: 50, channel: "direct_office", receivedById: receiverId });

    const entries = (await customerActions.getCustomerStatement()) as any[];
    const contribution = entries.find((e) => e.type === "contribution");
    expect(contribution).toBeTruthy();
    expect(contribution.receivedBy).toBe("Ama Mensah");
    expect(contribution.receivedBy).not.toBe("Admin User");
  });
});

describe("Create customer with temporary password", () => {
  it("enables portal access when a temporary password is supplied at creation", async () => {
    const fd = new FormData();
    fd.set("fullName", "New Portal Customer");
    fd.set("phone", "+233241111111");
    fd.set("dailyContribution", "50");
    fd.set("temporaryPassword", "TempPass123");

    const result = await customerActions.createCustomer(fd);
    expect(result.success).toBe(true);
    expect((result.data as any).portalEnabled).toBe(true);

    const created = await prisma.customer.findFirstOrThrow({ where: { fullName: "New Portal Customer" } });
    expect(created.portalEnabled).toBe(true);
    expect(created.forcePortalPasswordReset).toBe(true);
    expect(created.portalPasswordHash).toBeTruthy();
    expect(created.portalPasswordHash).not.toBe("TempPass123"); // stored hashed, never plaintext
  });

  it("does not enable portal access when no password is supplied", async () => {
    const fd = new FormData();
    fd.set("fullName", "No Portal Customer");
    fd.set("dailyContribution", "50");
    const result = await customerActions.createCustomer(fd);
    expect(result.success).toBe(true);

    const created = await prisma.customer.findFirstOrThrow({ where: { fullName: "No Portal Customer" } });
    expect(created.portalEnabled).toBe(false);
    expect(created.portalPasswordHash).toBeNull();
  });

  it("rejects a too-short temporary password", async () => {
    const fd = new FormData();
    fd.set("fullName", "Bad Pass Customer");
    fd.set("dailyContribution", "50");
    fd.set("temporaryPassword", "short");
    const result = await customerActions.createCustomer(fd);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/8 characters/i);
  });
});
