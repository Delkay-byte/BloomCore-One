/**
 * SEC-04, SEC-06 and SEC-14 regression tests.
 *
 * These exercise the real server actions against SQLite. PostgreSQL-specific
 * concurrency gates are covered by tests/pg-step-up.test.ts and
 * tests/pg-mfa-replay.test.ts.
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

import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import { processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";
import { recordRemittance } from "@/lib/actions/susu-collector.actions";
import {
  consumeEmailVerification,
  hashAccountToken,
  hashDestinationEmail,
  handleAccountEmailChanged,
  issueEmailVerification,
} from "@/lib/security/account-tokens";
import { beginMfaEnrollment } from "@/lib/security/mfa";
import { selfDisableAction } from "@/lib/security/mfa.actions";
import {
  stepUpContextHash,
  stepUpSessionBinding,
  hashStepUpToken,
} from "@/lib/security/step-up";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const PASSWORD = "Test1234!";

async function setAdminSession(
  user: { id: string; email: string },
  amr: "pwd" | "pwd+mfa" = "pwd"
) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Admin",
      role: "admin",
      modules: ["susu", "momo"],
      tokenVersion: 0,
      amr,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function grant(
  accountId: string,
  amountMinor: string,
  purpose: "susu.withdrawal" = "susu.withdrawal"
): Promise<string> {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "admin" } });
  await setAdminSession(admin);
  const result = await verifyPasswordAction(PASSWORD, {
    module: "admin",
    purpose,
    targetType: "susuAccount",
    targetId: accountId,
    context: { amountMinor, currency: "GHS" },
  });
  if (!result.success) throw new Error(result.error ?? "grant failed");
  return (result.data as { stepUpToken: string }).stepUpToken;
}

async function seedBalance(
  adminId: string,
  tenantId: string,
  accountId: string,
  cycleId: string,
  amount = 100
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
      referenceId: `SEC04-${Math.random().toString(16).slice(2)}`,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("SEC-04 server-side step-up grants", () => {
  it("rejects a withdrawal with a valid admin session but no grant", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "S04");
    await seedBalance(admin.id, admin.tenantId!, account.id, cycle.id);
    await setAdminSession(admin);

    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reauthentication/i);
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it("does not create a grant for a wrong password", async () => {
    const admin = await createTestAdmin();
    await setAdminSession(admin);
    const result = await verifyPasswordAction("WrongPassword9!", {
      module: "admin",
      purpose: "susu.withdrawal",
      targetType: "susuAccount",
      targetId: "account-x",
      context: { amountMinor: "1000", currency: "GHS" },
    });
    expect(result.success).toBe(false);
    expect(await prisma.stepUpGrant.count()).toBe(0);
  });

  it("rejects a grant when the withdrawal amount changes", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "S04A");
    await seedBalance(admin.id, admin.tenantId!, account.id, cycle.id);
    const token = await grant(account.id, "2000");

    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 10,
      stepUpToken: token,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reauthentication/i);
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it("allows one use and rejects replay of the same grant", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "S04B");
    await seedBalance(admin.id, admin.tenantId!, account.id, cycle.id);
    const token = await grant(account.id, "2000");

    const first = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      stepUpToken: token,
      idempotencyKey: "sec04-first-use",
    });
    expect(first.success).toBe(true);

    const replay = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      stepUpToken: token,
      idempotencyKey: "sec04-second-use",
    });
    expect(replay.success).toBe(false);
    expect(replay.error).toMatch(/reauthentication/i);
    expect(await prisma.withdrawal.count()).toBe(1);
  });

  it("rejects an expired grant", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "S04C");
    await seedBalance(admin.id, admin.tenantId!, account.id, cycle.id);
    const token = await grant(account.id, "2000");
    await prisma.stepUpGrant.updateMany({
      where: { tokenHash: hashStepUpToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      stepUpToken: token,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reauthentication/i);
  });

  it("rejects a grant bound to another session", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "S04D");
    await seedBalance(admin.id, admin.tenantId!, account.id, cycle.id);
    const token = await grant(account.id, "2000");
    // A different sign-in (different iat) cannot use the first session's grant.
    await setAdminSession(admin);
    mockCookieStore.set(
      "bik-admin-session",
      await new SignJWT({
        userId: admin.id,
        email: admin.email,
        fullName: "Admin",
        role: "admin",
        modules: ["susu", "momo"],
        tokenVersion: 0,
        amr: "pwd",
        lastActivityAt: Math.floor(Date.now() / 1000) - 10,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
        .setExpirationTime("1h")
        .sign(JWT_SECRET)
    );

    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      stepUpToken: token,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reauthentication/i);
  });

  it("refuses step-up for an MFA-enrolled account when the session is password-only", async () => {
    const admin = await createTestAdmin();
    await prisma.user.update({
      where: { id: admin.id },
      data: { mfaEnabled: true, mfaSecret: "encrypted-placeholder" },
    });
    await setAdminSession(admin, "pwd");
    const result = await verifyPasswordAction(PASSWORD, {
      module: "admin",
      purpose: "susu.withdrawal",
      targetType: "susuAccount",
      targetId: "account-x",
      context: { amountMinor: "1000", currency: "GHS" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multi-factor/i);
    expect(await prisma.stepUpGrant.count()).toBe(0);
  });

  it("accepts a properly bound grant", async () => {
    const admin = await createTestAdmin();
    const { account, cycle } = await createTestCustomer(admin.id, 10, "S04E");
    await seedBalance(admin.id, admin.tenantId!, account.id, cycle.id);
    const token = await grant(account.id, "2000");
    const result = await processWithdrawal({
      accountId: account.id,
      requestedAmount: 20,
      stepUpToken: token,
    });
    expect(result.success).toBe(true);
    expect(await prisma.withdrawal.count()).toBe(1);
  });
});

describe("SEC-06 collector remittance idempotency", () => {
  async function collectorFixture() {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `sec06-${Date.now()}@test.local`,
        fullName: "Collector",
        role: "collector",
        status: "active",
        passwordHash: "not-used",
      },
    });
    const collector = await prisma.collector.create({
      data: { tenantId: tenant.id, userId: user.id, status: "active" },
    });
    await setAdminSession(admin);
    return { tenant, admin, collector };
  }

  it("returns the original row for a retry with the same key", async () => {
    const { collector } = await collectorFixture();
    const first = await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 50,
      idempotencyKey: "remittance-key-1",
    });
    const second = await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 50,
      idempotencyKey: "remittance-key-1",
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect((first.data as { id: string }).id).toBe((second.data as { id: string }).id);
    expect(await prisma.collectorRemittance.count()).toBe(1);
  });

  it("rejects reuse of a key with different parameters", async () => {
    const { collector } = await collectorFixture();
    await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 50,
      idempotencyKey: "remittance-key-2",
    });
    const conflict = await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 60,
      idempotencyKey: "remittance-key-2",
    });
    expect(conflict.success).toBe(false);
    expect(conflict.error).toMatch(/different remittance details/i);
    expect(await prisma.collectorRemittance.count()).toBe(1);
  });

  it("records separate keys as separate legitimate submissions", async () => {
    const { collector } = await collectorFixture();
    await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 50,
      idempotencyKey: "remittance-key-3",
    });
    await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 50,
      idempotencyKey: "remittance-key-4",
    });
    expect(await prisma.collectorRemittance.count()).toBe(2);
  });

  it("still rejects non-finite and over-precision amounts", async () => {
    const { collector } = await collectorFixture();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0.001, 1_000_000.01]) {
      const result = await recordRemittance({
        collectorId: collector.id,
        remittedAmount: value,
        idempotencyKey: `invalid-${String(value)}`,
      });
      expect(result.success).toBe(false);
    }
    expect(await prisma.collectorRemittance.count()).toBe(0);
  });
});

describe("SEC-14 verification tokens are bound to their destination", () => {
  it("refuses a token whose destination no longer matches the account", async () => {
    const tenant = await createTestTenant();
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "original@example.test",
        fullName: "Verify Me",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        emailVerified: false,
      },
    });
    const raw = "legacy-style-token";
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        tokenHash: hashAccountToken(raw),
        destinationEmailHash: hashDestinationEmail("original@example.test"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { email: "changed@example.test" },
    });

    const result = await consumeEmailVerification(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.emailVerified).toBe(false);
  });

  it("refuses a legacy token with no destination snapshot", async () => {
    const tenant = await createTestTenant();
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "legacy@example.test",
        fullName: "Legacy",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        emailVerified: false,
      },
    });
    const raw = "legacy-no-destination";
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        tokenHash: hashAccountToken(raw),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const result = await consumeEmailVerification(raw);
    expect(result.ok).toBe(false);
  });

  it("invalidates old links and reissues for the new address on an email change", async () => {
    const tenant = await createTestTenant();
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "before@example.test",
        fullName: "Changing",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        emailVerified: false,
      },
    });
    const issued = await issueEmailVerification(user.id);
    expect(issued.sent).toBe(true);
    const oldToken = await prisma.emailVerificationToken.findFirstOrThrow({
      where: { userId: user.id, usedAt: null },
    });
    expect(oldToken.destinationEmailHash).toBe(hashDestinationEmail("before@example.test"));

    await prisma.user.update({
      where: { id: user.id },
      data: { email: "after@example.test" },
    });
    await handleAccountEmailChanged(user.id);

    const used = await prisma.emailVerificationToken.findUniqueOrThrow({
      where: { id: oldToken.id },
    });
    expect(used.usedAt).not.toBeNull();
    const fresh = await prisma.emailVerificationToken.findFirstOrThrow({
      where: { userId: user.id, usedAt: null },
    });
    expect(fresh.destinationEmailHash).toBe(hashDestinationEmail("after@example.test"));
    const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(account.emailVerified).toBe(false);
  });

  it("accepts a token when the destination still matches", async () => {
    const tenant = await createTestTenant();
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "match@example.test",
        fullName: "Match",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        emailVerified: false,
      },
    });
    const raw = "matching-destination";
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        tokenHash: hashAccountToken(raw),
        destinationEmailHash: hashDestinationEmail("match@example.test"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const result = await consumeEmailVerification(raw);
    expect(result.ok).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.emailVerified).toBe(true);
  });
});

describe("SEC-04 grant model invariants", () => {
  it("stores only a token hash and a canonical context hash", async () => {
    const admin = await createTestAdmin();
    const { account } = await createTestCustomer(admin.id, 10, "S04F");
    const token = await grant(account.id, "2000");
    const row = await prisma.stepUpGrant.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(hashStepUpToken(token));
    expect(row.contextHash).toBe(
      stepUpContextHash({
        purpose: "susu.withdrawal",
        targetType: "susuAccount",
        targetId: account.id,
        context: { amountMinor: "2000", currency: "GHS" },
      })
    );
    expect(row.sessionId).toBe(stepUpSessionBinding(
      { iat: Math.floor(Number(row.sessionId.split(":").pop())) },
      admin.id
    ));
  });
});

describe("SEC-15 MFA enrollment and disable controls", () => {
  it("reuses an unexpired pending secret instead of replacing it", async () => {
    const user = await prisma.user.create({
      data: {
        email: `sec15-enrol-${Date.now()}@test.local`,
        fullName: "Enrol",
        role: "admin",
        status: "active",
        passwordHash: "not-used",
      },
    });
    const first = await beginMfaEnrollment({
      subjectType: "user",
      subjectId: user.id,
      accountName: user.email,
    });
    const second = await beginMfaEnrollment({
      subjectType: "user",
      subjectId: user.id,
      accountName: user.email,
    });
    expect(second.secret).toBe(first.secret);
    const restarted = await beginMfaEnrollment({
      subjectType: "user",
      subjectId: user.id,
      accountName: user.email,
      restart: true,
    });
    expect(restarted.secret).not.toBe(first.secret);
  });

  it("rate-limits repeated wrong disable codes without disabling MFA", async () => {
    const admin = await createTestAdmin();
    await prisma.user.update({
      where: { id: admin.id },
      data: { mfaEnabled: true, mfaSecret: "invalid-ciphertext" },
    });
    await setAdminSession(admin);
    let limited = false;
    for (let i = 0; i < 7; i += 1) {
      const form = new FormData();
      form.set("password", PASSWORD);
      form.set("code", "000000");
      form.set("reason", "Testing repeated wrong codes");
      form.set("confirm", "on");
      const result = await selfDisableAction(form);
      if (result.error?.match(/too many/i)) limited = true;
    }
    expect(limited).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.mfaEnabled).toBe(true);
  });
});
