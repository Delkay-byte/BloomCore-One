/**
 * Financial integrity regression tests.
 *
 * These exercise the real withdrawal action against two isolated tenants and
 * verify monetary validation, cross-tenant denial, single commission charging
 * and retry/idempotency behaviour.
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
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";
import {
  reverseContribution,
  reverseWithdrawal,
} from "@/lib/actions/financial-reversal.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Admin",
      role: "admin",
      modules: ["susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function seedBalance(
  tenantId: string,
  accountId: string,
  cycleId: string,
  amount: number,
  adminId: string
) {
  await prisma.contribution.create({
    data: {
      tenantId,
      accountId,
      cycleId,
      amount,
      collectionDate: new Date(),
      channel: "direct_office",
      recordedById: adminId,
      referenceId: `SEED-${Math.random().toString(16).slice(2)}`,
    },
  });
}

describe("financial operation security", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("rejects a cross-tenant withdrawal", async () => {
    const tenantA = await createTestTenant({ name: "Tenant A" });
    const tenantB = await createTestTenant({ name: "Tenant B" });
    const adminA = await createTestAdmin({ tenantId: tenantA.id });
    const adminB = await createTestAdmin({ tenantId: tenantB.id });
    const { account, cycle } = await createTestCustomer(adminB.id, 10, "B1");
    await seedBalance(tenantB.id, account.id, cycle.id, 100, adminB.id);

    await setAdminSession(adminA);
    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 10,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it("rejects NaN, Infinity and sub-cent amounts", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const { account } = await createTestCustomer(admin.id, 10, "N1");
    await setAdminSession(admin);

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 10.001, -5]) {
      const result = await processWithdrawal({
        accountId: account.id,
        requestedAmount: value,
      });
      expect(result.success).toBe(false);
    }
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it("charges commission once and rejects a replayed idempotency key", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const { account, cycle } = await createTestCustomer(admin.id, 10, "I1");
    await seedBalance(tenant.id, account.id, cycle.id, 100, admin.id);
    await setAdminSession(admin);

    const first = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "withdrawal-key-0001",
    });
    expect(first.success).toBe(true);

    const replay = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "withdrawal-key-0001",
    });
    expect(replay.success).toBe(false);
    expect(replay.error).toMatch(/already processed/i);

    const second = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "withdrawal-key-0002",
    });
    expect(second.success).toBe(true);

    const commissions = await prisma.commission.findMany({
      where: { cycleId: cycle.id },
    });
    expect(commissions).toHaveLength(1);
    expect(await prisma.withdrawal.count()).toBe(2);

    const audit = await prisma.auditLog.findMany({
      where: { action: "susu.withdrawal_processed" },
    });
    expect(audit).toHaveLength(2);
    expect(audit[0].tenantId).toBe(tenant.id);
  });

  it("reverses a withdrawal without deleting the original and blocks duplicates", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const { account, cycle } = await createTestCustomer(admin.id, 10, "R2");
    await seedBalance(tenant.id, account.id, cycle.id, 100, admin.id);
    await setAdminSession(admin);

    const withdrawal = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "reverse-key-0001",
    });
    expect(withdrawal.success).toBe(true);
    const original = await prisma.withdrawal.findFirstOrThrow({
      where: { accountId: account.id, status: "completed" },
    });

    const reversal = await reverseWithdrawal({
      withdrawalId: original.id,
      reason: "Customer disputed the payout; cash returned to the office.",
    });
    expect(reversal.success).toBe(true);

    const duplicate = await reverseWithdrawal({
      withdrawalId: original.id,
      reason: "Attempt to reverse the same withdrawal twice.",
    });
    expect(duplicate.success).toBe(false);

    const rows = await prisma.withdrawal.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("reversed");
    expect(rows[1].reversalOfId).toBe(original.id);
    expect(Number(rows[1].netAmount)).toBe(-20);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "susu.withdrawal_reversed", entityId: original.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.tenantId).toBe(tenant.id);
  });

  it("reverses a contribution with a compensating entry and excludes its days", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const { account, cycle } = await createTestCustomer(admin.id, 10, "R3");
    await seedBalance(tenant.id, account.id, cycle.id, 100, admin.id);
    await setAdminSession(admin);

    const original = await prisma.contribution.findFirstOrThrow({
      where: { accountId: account.id },
    });
    const reversal = await reverseContribution({
      contributionId: original.id,
      reason: "Contribution was recorded against the wrong customer account.",
    });
    expect(reversal.success).toBe(true);

    const duplicate = await reverseContribution({
      contributionId: original.id,
      reason: "Duplicate reversal attempt should be rejected.",
    });
    expect(duplicate.success).toBe(false);

    const rows = await prisma.contribution.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(Number(rows[1].amount)).toBe(-100);
    expect(rows[0].reversedAt).not.toBeNull();

    // No spendable balance remains and no days are outstanding-paid.
    const spend = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 10,
    });
    expect(spend.success).toBe(false);
  });
});
