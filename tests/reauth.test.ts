/**
 * Susu withdrawal step-up authentication regression tests.
 *
 * The reported defect: an administrator entered their own valid password on
 * the withdrawal confirmation dialog and received "Incorrect password".
 *
 * Root cause covered here: step-up verification resolved identity by falling
 * through admin -> MoMo -> Susu sessions. When the admin session was not the
 * one attached to the request, the password was checked against a different
 * account (a worker/collector session in the same browser). The withdrawal
 * screen now names the admin session explicitly.
 *
 * Also covered: the submitted password is compared exactly as typed. Sign-in
 * does not trim passwords, so trimming during step-up made a valid password
 * fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
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

import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import { processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const ADMIN_PASSWORD = "Test1234!";

async function tokenFor(
  user: { id: string; email: string; tokenVersion?: number },
  role: "admin" | "worker" | "collector",
  modules: string[]
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    userId: user.id,
    email: user.email,
    fullName: "Session User",
    role,
    modules,
    tokenVersion: user.tokenVersion ?? 0,
    lastActivityAt: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function setAdminSession(user: { id: string; email: string }) {
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await tokenFor(user, "admin", ["momo", "susu"])
  );
}

async function setOnlyWorkerSession(user: { id: string; email: string }) {
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-worker-session",
    await tokenFor(user, "worker", ["momo"])
  );
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("Susu withdrawal step-up verification", () => {
  it("accepts the authorised administrator's own correct password", async () => {
    const admin = await createTestAdmin();
    await setAdminSession(admin);

    const result = await verifyPasswordAction(ADMIN_PASSWORD, {
      module: "admin",
    });

    expect(result.success).toBe(true);
    const success = await prisma.auditLog.findFirst({
      where: { action: "auth.reauth_success", userId: admin.id },
    });
    expect(success?.entityId).toBe(admin.id);
  });

  it("rejects an incorrect password and writes a failure audit event", async () => {
    const admin = await createTestAdmin();
    await setAdminSession(admin);

    const result = await verifyPasswordAction("DefinitelyWrong1!", {
      module: "admin",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Incorrect password");
    const failure = await prisma.auditLog.findFirst({
      where: { action: "auth.reauth_failed", userId: admin.id },
    });
    expect(failure?.entityId).toBe(admin.id);
    // The rejected password never reaches the audit trail.
    expect(JSON.stringify(failure?.details ?? "")).not.toContain(
      "DefinitelyWrong1!"
    );
  });

  it("does not create a withdrawal when password verification fails", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "R1");
    await prisma.contribution.create({
      data: {
        tenantId: admin.tenantId!,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 100,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: "REAUTH-SEED-1",
      },
    });
    await setAdminSession(admin);

    const result = await verifyPasswordAction("WrongPassword9!", {
      module: "admin",
    });
    expect(result.success).toBe(false);
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it("never verifies a different account's session password", async () => {
    const admin = await createTestAdmin();
    const worker = await prisma.user.create({
      data: {
        email: `reauth-worker-${Date.now()}@example.com`,
        fullName: "MoMo Worker",
        role: "worker",
        status: "active",
        passwordHash: await bcrypt.hash("WorkerPass1!", 4),
        momoEnabled: true,
        tenantId: admin.tenantId!,
      },
    });

    // Only a worker session is attached — the admin session is absent.
    await setOnlyWorkerSession(worker);

    // The worker's own valid password must NOT authorise an admin action.
    const result = await verifyPasswordAction("WorkerPass1!", {
      module: "admin",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session has expired/i);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("compares the password exactly as typed, matching sign-in behaviour", async () => {
    const admin = await createTestAdmin();
    await prisma.user.update({
      where: { id: admin.id },
      data: { passwordHash: await bcrypt.hash("Pass 1234 ", 4) },
    });
    await setAdminSession(admin);

    // A password with a trailing space works at sign-in (login does not trim),
    // so it must also work at step-up confirmation.
    const result = await verifyPasswordAction("Pass 1234 ", {
      module: "admin",
    });
    expect(result.success).toBe(true);
  });

  it("denies a worker session from processing a Susu withdrawal", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "R2");
    await prisma.contribution.create({
      data: {
        tenantId: admin.tenantId!,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 100,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: "REAUTH-SEED-2",
      },
    });
    const worker = await prisma.user.create({
      data: {
        email: `reauth-worker2-${Date.now()}@example.com`,
        fullName: "MoMo Worker 2",
        role: "worker",
        status: "active",
        passwordHash: await bcrypt.hash("WorkerPass1!", 4),
        momoEnabled: true,
        tenantId: admin.tenantId!,
      },
    });
    await setOnlyWorkerSession(worker);

    await expect(
      processWithdrawal({ accountId: account.id, requestedAmount: 10 })
    ).rejects.toThrow(/REDIRECT/);
    expect(await prisma.withdrawal.count()).toBe(0);
  });
});

async function seedContribution(
  admin: { id: string; tenantId: string | null },
  account: { id: string },
  cycle: { id: string },
  amount: number,
  referenceId: string
) {
  await prisma.contribution.create({
    data: {
      tenantId: admin.tenantId!,
      accountId: account.id,
      cycleId: cycle.id,
      amount,
      collectionDate: new Date(),
      channel: "direct_office",
      recordedById: admin.id,
      referenceId,
    },
  });
}

describe("Susu withdrawal processing and audit", () => {
  it("rejects another administrator's valid password", async () => {
    const admin = await createTestAdmin();
    const other = await createTestAdmin({ tenantId: admin.tenantId! });
    await prisma.user.update({
      where: { id: other.id },
      data: { passwordHash: await bcrypt.hash("OtherAdmin9!", 4) },
    });
    await setAdminSession(admin);

    // The other administrator's genuine password is not this session's proof.
    const result = await verifyPasswordAction("OtherAdmin9!", {
      module: "admin",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Incorrect password");
    const failure = await prisma.auditLog.findFirst({
      where: { action: "auth.reauth_failed", userId: admin.id },
    });
    expect(failure?.entityId).toBe(admin.id);
  });

  it("processes one withdrawal after the administrator's own password is confirmed", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "W1");
    await seedContribution(admin, account, cycle, 100, "WDR-SEED-1");
    await setAdminSession(admin);

    const reauth = await verifyPasswordAction(ADMIN_PASSWORD, { module: "admin" });
    expect(reauth.success).toBe(true);

    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "withdraw-one-key",
    });
    expect(result.success).toBe(true);

    const withdrawals = await prisma.withdrawal.findMany();
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0].authorizedById).toBe(admin.id);
    expect(Number(withdrawals[0].netAmount)).toBe(20);
    // A first withdrawal charges exactly one day's contribution.
    expect(Number(withdrawals[0].commissionAmount)).toBe(10);
    expect(Number(withdrawals[0].remainingBalance)).toBe(70);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "susu.withdrawal_processed" },
    });
    expect(audit?.userId).toBe(admin.id);
    expect(audit?.entityId).toBe(withdrawals[0].id);
    expect(audit?.tenantId).toBe(admin.tenantId);
  });

  it("does not process the same idempotency key twice", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "W2");
    await seedContribution(admin, account, cycle, 100, "WDR-SEED-2");
    await setAdminSession(admin);

    const first = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "duplicate-key-1",
    });
    expect(first.success).toBe(true);

    const second = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "duplicate-key-1",
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already processed/i);
    expect(await prisma.withdrawal.count()).toBe(1);
    expect(await prisma.commission.count()).toBe(1);
  });

  it("charges commission only on the first withdrawal of a cycle", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "W3");
    await seedContribution(admin, account, cycle, 100, "WDR-SEED-3");
    await setAdminSession(admin);

    const first = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "commission-first",
    });
    expect(first.success).toBe(true);
    const second = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      idempotencyKey: "commission-second",
    });
    expect(second.success).toBe(true);

    const withdrawals = await prisma.withdrawal.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(withdrawals).toHaveLength(2);
    expect(Number(withdrawals[0].commissionAmount)).toBe(10);
    expect(Number(withdrawals[1].commissionAmount)).toBe(0);
    // 100 contributed - 10 commission - 20 - 20 withdrawn = 50.
    expect(Number(withdrawals[1].remainingBalance)).toBe(50);
    expect(await prisma.commission.count()).toBe(1);
  });

  it("rejects a withdrawal larger than the available balance and creates nothing", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "W4");
    await seedContribution(admin, account, cycle, 30, "WDR-SEED-4");
    await setAdminSession(admin);

    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 25,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insufficient balance/i);
    expect(await prisma.withdrawal.count()).toBe(0);
    // The failed transaction must not leave a commission behind either.
    expect(await prisma.commission.count()).toBe(0);
    expect(
      (await prisma.susuCycle.findUnique({ where: { id: cycle.id } }))
        ?.commissionCharged
    ).toBe(false);
  });
});
