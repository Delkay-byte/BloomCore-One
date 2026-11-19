/**
 * Financial audit atomicity.
 *
 * A financial row must never commit without its audit evidence. These tests
 * install a temporary SQLite trigger that aborts every AuditLog insert, then
 * prove the financial transaction rolls back instead of succeeding silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { recordContribution } from "@/lib/actions/susu-contribution.actions";
import { processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";
import { reverseContribution } from "@/lib/actions/financial-reversal.actions";
import { submitDailyAccount } from "@/lib/actions/daily-account.actions";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setSession(
  module: "admin" | "worker",
  user: { id: string; email: string },
  locationId?: string
) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    module === "admin" ? "bik-admin-session" : "bik-worker-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test",
      role: module,
      modules: module === "admin" ? ["susu"] : ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
      ...(locationId ? { locationId } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function blockAuditWrites() {
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_financial_audit
    BEFORE INSERT ON "AuditLog"
    BEGIN
      SELECT RAISE(ABORT, 'audit storage unavailable');
    END;
  `);
}

async function dropAuditBlock() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_financial_audit`);
}

afterEach(async () => {
  await dropAuditBlock();
});

beforeEach(async () => {
  await cleanDatabase();
  await dropAuditBlock();
});

describe("financial audit atomicity", () => {
  it("rolls back a contribution when its audit row cannot be written", async () => {
    const tenant = await createTestTenant({ susu: true, momo: false });
    const admin = await createTestAdmin({ tenantId: tenant.id, susu: true, momo: false });
    const { account } = await createTestCustomer(admin.id, 10, "AUD-CON");
    await setSession("admin", admin);

    await blockAuditWrites();
    const result = await recordContribution({
      accountId: account.id,
      amount: 10,
      channel: "direct_office",
      idempotencyKey: "AUDIT-ATOMIC-CON-1",
    });

    expect(result.success).toBe(false);
    expect(
      await prisma.contribution.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
  });

  it("rolls back a withdrawal when its audit row cannot be written", async () => {
    const tenant = await createTestTenant({ susu: true, momo: false });
    const admin = await createTestAdmin({ tenantId: tenant.id, susu: true, momo: false });
    const { account, cycle } = await createTestCustomer(admin.id, 10, "AUD-WD");
    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 100,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: "AUD-SEED-WD-1",
      },
    });
    await setSession("admin", admin);

    const grant = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "susu.withdrawal",
      targetType: "susuAccount",
      targetId: account.id,
      context: { amountMinor: "1000", currency: "GHS" },
    });
    expect(grant.success).toBe(true);
    const stepUpToken = (grant.data as { stepUpToken: string }).stepUpToken;

    await blockAuditWrites();
    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 10,
      stepUpToken,
    });

    expect(result.success).toBe(false);
    expect(
      await prisma.withdrawal.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
    expect(
      await prisma.commission.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
    const cycleAfter = await prisma.susuCycle.findUniqueOrThrow({
      where: { id: cycle.id },
    });
    expect(cycleAfter.commissionCharged).toBe(false);
  });


  it("rolls back a correction when its audit row cannot be written", async () => {
    const tenant = await createTestTenant({ susu: true, momo: false });
    const admin = await createTestAdmin({ tenantId: tenant.id, susu: true, momo: false });
    const { account, cycle } = await createTestCustomer(admin.id, 10, "AUD-REV");
    const original = await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 20,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: "AUD-SEED-REV-1",
      },
    });
    await setSession("admin", admin);

    const grant = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "susu.contribution.reverse",
      targetType: "contribution",
      targetId: original.id,
    });
    expect(grant.success).toBe(true);
    const stepUpToken = (grant.data as { stepUpToken: string }).stepUpToken;

    await blockAuditWrites();
    const result = await reverseContribution({
      contributionId: original.id,
      reason: "This correction must roll back without audit evidence.",
      stepUpToken,
    });

    expect(result.success).toBe(false);
    expect(
      await prisma.contribution.count({ where: { reversalOfId: original.id } })
    ).toBe(0);
    const after = await prisma.contribution.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(after.reversedAt).toBeNull();
  });

  it("leaves a daily account in draft when its submit audit fails", async () => {
    const tenant = await createTestTenant({ susu: false, momo: true });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Audit Branch", code: "AUD-1" },
    });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "audit-worker@test.invalid",
        fullName: "Audit Worker",
        role: "worker",
        passwordHash: "not-used",
        momoEnabled: true,
        locationId: location.id,
      },
    });
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date("2026-11-20T00:00:00.000Z"),
        status: "draft",
        openingCash: 100,
        openingMomoFloat: 100,
        closingCash: 100,
        closingMomoFloat: 100,
      },
    });
    await setSession("worker", worker, location.id);

    await blockAuditWrites();
    const result = await submitDailyAccount(account.id);

    expect(result.success).toBe(false);
    const after = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(after.status).toBe("draft");
    expect(after.submittedAt).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { tenantId: tenant.id, entityId: account.id },
      })
    ).toBe(0);
    // Keep the fixture explicitly referenced so the intent of the test stays
    // clear even if the helper user is no longer needed after setup.
    expect(admin.id).toBeTruthy();
  });
});
