/**
 * Phase 1 — branch-scoped Susu foundation.
 *
 * Synthetic fixtures only. Verifies that branch scope is resolved from
 * persisted server-side membership, never from client input, and that
 * historical financial attribution is immutable.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
  createTestTenant,
} from "./setup";
import type { TenantContext } from "@/lib/tenant";
import {
  assertBranchAccess,
  resolveBranchScope,
  resolveWriteBranch,
  LEGACY_UNASSIGNED_BRANCH,
} from "@/lib/branch";

function ctxFor(
  tenant: { id: string; code: string; name: string; momoEnabled: boolean; susuEnabled: boolean },
  userId: string,
  role: string
): TenantContext {
  return {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    tenantName: tenant.name,
    momoEnabled: tenant.momoEnabled,
    susuEnabled: tenant.susuEnabled,
    userId,
    role,
    modules: ["susu"],
  };
}

async function makeTenant(name: string, branchNames: string[]) {
  const tenant = await createTestTenant({ name, momo: false, susu: true });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: false, susu: true });
  const branches = [];
  for (const branchName of branchNames) {
    branches.push(
      await prisma.location.create({
        data: {
          tenantId: tenant.id,
          name: branchName,
          code: `${branchName.slice(0, 3).toUpperCase()}-${tenant.code}`,
          status: "active",
        },
      })
    );
  }
  return { tenant, admin, branches, ctx: ctxFor(tenant, admin.id, "admin") };
}

async function makeBranchManager(
  tenantId: string,
  branchId: string,
  name: string
) {
  const user = await prisma.user.create({
    data: {
      tenantId,
      email: `branch-manager-${name}@bikprestige.com`,
      fullName: `Branch Manager ${name}`,
      role: "admin",
      status: "active",
      passwordHash: "not-used-in-these-tests",
      momoEnabled: false,
      susuEnabled: true,
    },
  });
  await prisma.branchMembership.create({
    data: { tenantId, userId: user.id, locationId: branchId, role: "branch_manager", status: "active" },
  });
  return user;
}

async function makeCollector(tenantId: string, branchId: string, name: string) {
  const user = await prisma.user.create({
    data: {
      tenantId,
      email: `collector-${name}@bikprestige.com`,
      fullName: `Collector ${name}`,
      role: "collector",
      status: "active",
      passwordHash: "not-used-in-these-tests",
      momoEnabled: false,
      susuEnabled: true,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId, userId: user.id, branchId, status: "active" },
  });
  return { user, collector };
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("branch scope resolution", () => {
  it("keeps company-wide authority for an administrator without memberships", async () => {
    const { ctx } = await makeTenant("Wide", ["A", "B", "C"]);
    const scope = await resolveBranchScope(ctx);
    expect(scope.kind).toBe("all");
  });

  it("restricts a branch manager to persisted active memberships", async () => {
    const { tenant, branches } = await makeTenant("Scoped", ["A", "B", "C"]);
    const manager = await makeBranchManager(tenant.id, branches[0].id, "scoped");
    const scope = await resolveBranchScope(ctxFor(tenant, manager.id, "admin"));
    expect(scope.kind).toBe("limited");
    if (scope.kind !== "limited") throw new Error("expected limited scope");
    expect(scope.branchIds).toEqual([branches[0].id]);
    expect(await assertBranchAccess(ctxFor(tenant, manager.id, "admin"), branches[1].id)).toBe(false);
  });

  it("rejects a foreign tenant branch even when the id is supplied by a client", async () => {
    const a = await makeTenant("TenantA", ["A"]);
    const b = await makeTenant("TenantB", ["B"]);
    expect(await assertBranchAccess(a.ctx, b.branches[0].id)).toBe(false);
    expect(await resolveWriteBranch(a.ctx, b.branches[0].id)).toBeNull();
  });

  it("derives collector scope from the collector record, not from client input", async () => {
    const { tenant, branches } = await makeTenant("Collectors", ["A", "B"]);
    const collector = await makeCollector(tenant.id, branches[0].id, "one");
    const scope = await resolveBranchScope(ctxFor(tenant, collector.user.id, "collector"));
    expect(scope.kind).toBe("limited");
    if (scope.kind !== "limited") throw new Error("expected limited scope");
    expect(scope.branchIds).toEqual([branches[0].id]);
    expect(
      await assertBranchAccess(ctxFor(tenant, collector.user.id, "collector"), branches[1].id)
    ).toBe(false);
  });

  it("derives the write branch for a one-branch tenant without client input", async () => {
    const { ctx, branches } = await makeTenant("Single", ["Main"]);
    expect(await resolveWriteBranch(ctx)).toBe(branches[0].id);
  });

  it("fails closed when a wide admin has several branches and gives no explicit choice", async () => {
    const { ctx } = await makeTenant("Many", ["A", "B"]);
    expect(await resolveWriteBranch(ctx)).toBeNull();
  });

  it("lets a scoped manager write only to an owned active branch", async () => {
    const { tenant, branches } = await makeTenant("Manager", ["A", "B"]);
    const manager = await makeBranchManager(tenant.id, branches[0].id, "writer");
    const managerCtx = ctxFor(tenant, manager.id, "admin");
    expect(await resolveWriteBranch(managerCtx)).toBe(branches[0].id);
    expect(await resolveWriteBranch(managerCtx, branches[1].id)).toBeNull();
  });

  it("protects historical records when a collector changes branch", async () => {
    const { tenant, admin, branches } = await makeTenant("History", ["A", "B"]);
    const collector = await makeCollector(tenant.id, branches[0].id, "mover");
    const customer = await createTestCustomer(admin.id, 10, "history");
    const contribution = await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: customer.account.id,
        cycleId: customer.cycle.id,
        collectorId: collector.collector.id,
        recordedById: admin.id,
        branchId: branches[0].id,
        amount: 10,
        collectionDate: new Date(),
        channel: "collector",
        referenceId: `CON-history-${tenant.id}`,
      },
    });
    await prisma.collector.update({
      where: { id: collector.collector.id },
      data: { branchId: branches[1].id },
    });
    const after = await prisma.contribution.findUniqueOrThrow({ where: { id: contribution.id } });
    expect(after.branchId).toBe(branches[0].id);
    const scope = await resolveBranchScope(ctxFor(tenant, collector.user.id, "collector"));
    expect(scope.kind).toBe("limited");
    if (scope.kind !== "limited") throw new Error("expected limited scope");
    expect(scope.branchIds).toEqual([branches[1].id]);
  });

  it("allows reading a deactivated branch but blocks new writes", async () => {
    const { tenant, branches } = await makeTenant("Deactivated", ["A"]);
    const manager = await makeBranchManager(tenant.id, branches[0].id, "deact");
    const managerCtx = ctxFor(tenant, manager.id, "admin");
    await prisma.location.update({
      where: { id: branches[0].id },
      data: { status: "inactive" },
    });
    expect(await assertBranchAccess(managerCtx, branches[0].id, "read")).toBe(true);
    expect(await assertBranchAccess(managerCtx, branches[0].id, "write")).toBe(false);
  });

  it("labels legacy financial records without inventing a branch", async () => {
    const { tenant, admin } = await makeTenant("Legacy", ["A"]);
    const customer = await createTestCustomer(admin.id, 10, "legacy");
    const contribution = await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: customer.account.id,
        cycleId: customer.cycle.id,
        recordedById: admin.id,
        branchId: null,
        amount: 10,
        collectionDate: new Date(),
        channel: "direct_office",
        referenceId: `CON-legacy-${tenant.id}`,
      },
    });
    expect(contribution.branchId ?? LEGACY_UNASSIGNED_BRANCH).toBe(LEGACY_UNASSIGNED_BRANCH);
  });
});
