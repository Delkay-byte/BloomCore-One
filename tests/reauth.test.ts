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
