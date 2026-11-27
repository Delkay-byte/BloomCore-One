/**
 * Phase 1 — server-side branch boundary tests.
 *
 * Direct server-action calls with real tenant contexts. No page-only checks.
 * Synthetic multi-tenant, multi-branch fixtures; no production data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { getBranchesForScope, setBranchMembership, updateBranch } from "@/lib/actions/branch.actions";
import { recordContribution, getContributions } from "@/lib/actions/susu-contribution.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string; fullName?: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: user.fullName ?? "Test Admin",
      role: "admin",
      modules: ["momo", "susu"],
      module: "admin",
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function tenantWithBranches(name: string, codes: string[]) {
  const tenant = await createTestTenant({ name, momo: false, susu: true });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: false, susu: true });
  const branches = [];
  for (const code of codes) {
    branches.push(
      await prisma.location.create({
        data: { tenantId: tenant.id, name: `${name} ${code}`, code, status: "active" },
      })
    );
  }
  return { tenant, admin, branches };
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("server-side branch boundaries", () => {
  it("shows only held branches to a branch manager", async () => {
    const a = await tenantWithBranches("WideA", ["A1", "A2"]);
    const manager = await prisma.user.create({
      data: {
        tenantId: a.tenant.id,
        email: "manager-a1@example.test",
        fullName: "Manager A1",
        role: "admin",
        status: "active",
        passwordHash: "unused",
        susuEnabled: true,
      },
    });
    await prisma.branchMembership.create({
      data: {
        tenantId: a.tenant.id,
        userId: manager.id,
        locationId: a.branches[0].id,
        role: "branch_manager",
      },
    });
    await setAdminSession(manager);
    const branches = await getBranchesForScope();
    expect(branches.map((b) => b.id)).toEqual([a.branches[0].id]);
  });

  it("refuses to mutate another tenant's branch", async () => {
    const a = await tenantWithBranches("TenantA", ["A1"]);
    const b = await tenantWithBranches("TenantB", ["B1"]);
    const form = new FormData();
    form.set("name", "Renamed B1");
    form.set("code", "B1");
    await setAdminSession(a.admin);
    const result = await updateBranch(b.branches[0].id, form);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses membership assignment to a foreign tenant user or branch", async () => {
    const a = await tenantWithBranches("TenantA", ["A1"]);
    const b = await tenantWithBranches("TenantB", ["B1"]);
    await setAdminSession(a.admin);
    const result = await setBranchMembership({
      userId: b.admin.id,
      branchId: b.branches[0].id,
      role: "branch_manager",
      status: "active",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in this business/i);
  });

  it("rejects a client-supplied foreign branch on contribution recording", async () => {
    const a = await tenantWithBranches("TenantA", ["A1"]);
    const b = await tenantWithBranches("TenantB", ["B1"]);
    const collectorUser = await prisma.user.create({
      data: {
        tenantId: a.tenant.id,
        email: "collector-a@example.test",
        fullName: "Collector A",
        role: "collector",
        status: "active",
        passwordHash: "unused",
        susuEnabled: true,
      },
    });
    const collector = await prisma.collector.create({
      data: { tenantId: a.tenant.id, userId: collectorUser.id, branchId: a.branches[0].id },
    });
    const customer = await createTestCustomer(a.admin.id, 10, "branchaction");
    await prisma.collectorCustomerAssignment.create({
      data: {
        tenantId: a.tenant.id,
        collectorId: collector.id,
        customerId: customer.customer.id,
        accountId: customer.account.id,
      },
    });
    await setAdminSession(a.admin);
    const before = await prisma.contribution.count({ where: { tenantId: a.tenant.id } });
    const result = await recordContribution({
      accountId: customer.account.id,
      amount: 10,
      channel: "collector",
      collectorId: collector.id,
      branchId: b.branches[0].id,
    });
    // A client-supplied branch id is ignored, not trusted. The record is
    // attributed to the authenticated collector's own branch.
    expect(result.success).toBe(true);
    const referenceId =
      result.data && typeof result.data === "object" && "referenceId" in result.data
        ? String(result.data.referenceId)
        : "";
    const stored = await prisma.contribution.findFirst({
      where: { tenantId: a.tenant.id, referenceId },
    });
    expect(await prisma.contribution.count({ where: { tenantId: a.tenant.id } })).toBe(before + 1);
    expect(stored?.branchId ?? null).toBe(a.branches[0].id);
  });

  it("hides another branch's contributions from a scoped manager", async () => {
    const a = await tenantWithBranches("Scoped", ["A1", "A2"]);
    const manager = await prisma.user.create({
      data: {
        tenantId: a.tenant.id,
        email: "scoped-manager@example.test",
        fullName: "Scoped Manager",
        role: "admin",
        status: "active",
        passwordHash: "unused",
        susuEnabled: true,
      },
    });
    await prisma.branchMembership.create({
      data: {
        tenantId: a.tenant.id,
        userId: manager.id,
        locationId: a.branches[0].id,
        role: "branch_manager",
      },
    });
    const customer = await createTestCustomer(a.admin.id, 10, "scopedlist");
    for (const [index, branch] of a.branches.entries()) {
      await prisma.contribution.create({
        data: {
          tenantId: a.tenant.id,
          branchId: branch.id,
          accountId: customer.account.id,
          cycleId: customer.cycle.id,
          recordedById: a.admin.id,
          amount: 10,
          collectionDate: new Date(),
          channel: "direct_office",
          referenceId: `CON-scoped-${index}-${a.tenant.id}`,
        },
      });
    }
    await setAdminSession(manager);
    const result = await getContributions({ limit: 50 });
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0].branchId).toBe(a.branches[0].id);
  });
});
