/**
 * PostgreSQL concurrency regression test.
 *
 * Run only with the PostgreSQL client and an isolated database:
 *   npx prisma generate --schema=prisma/schema-pg.prisma
 *   DATABASE_URL=<rehearsal> npx vitest run --config vitest.pg.config.ts tests/pg-withdrawal-concurrency.test.ts
 *
 * Verifies that two simultaneous withdrawals on one account cannot spend the
 * same balance, and that a replayed idempotency key posts once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { createPrismaClient } from "@/lib/prisma-client";

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
import { hashStepUpToken, stepUpContextHash } from "@/lib/security/step-up";

const prisma = createPrismaClient();
let grantSeq = 0;
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!);

async function resetDatabase() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "FoundingAllocation","TenantNotification","ZeliUsagePeriod","AccountEnquiry","FinancialApproval","PlatformApprovalRequest","SecurityAlert","SecurityEventRecord","StepUpGrant","MfaRecoveryCode","AccountRecoveryRequest","SessionRecord","TabCredential","TabProofNonce","MfaChallengeUse","TurnstileTokenUse",
      "AuthThrottle","RateLimitCounter","PlatformAuditLog","PlatformSuperAdmin",
      "OfflineTransaction","DeviceEnrollment","PasswordResetToken","AuditLog",
      "CustomerImportRowEvent","CustomerImportRow","CustomerImportBatch",
      "Expense","DailyAccount","ContributionAllocation","Commission","CardFee",
      "Withdrawal","Contribution","SusuCycle","SusuAccount","CollectorRemittance",
      "CollectorCustomerAssignment","Collector","Customer","Location","User",
      "BusinessTenant" CASCADE
  `);
}

async function seed() {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PG-${Date.now()}`,
      name: "PG Concurrency Tenant",
      status: "ACTIVE",
      susuEnabled: true,
      onboardingStatus: "COMPLETED",
    },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pg-admin-${Date.now()}@example.com`,
      fullName: "PG Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `PG-C-${Date.now()}`,
      fullName: "PG Customer",
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `PG-S-${Date.now()}`,
      customerId: customer.id,
      dailyContribution: 10,
      status: "active",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date("2026-11-01T00:00:00Z"),
      endDate: new Date("2026-11-30T23:59:59Z"),
      dailyContribution: 10,
      status: "active",
    },
  });
  await prisma.contribution.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleId: cycle.id,
      amount: 100,
      collectionDate: new Date(),
      channel: "direct_office",
      recordedById: admin.id,
      referenceId: `SEED-${Date.now()}`,
    },
  });
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
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
  return { tenant, admin, account, cycle, sessionIat: now };
}

describe("PostgreSQL concurrent withdrawals", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("does not let two simultaneous withdrawals overdraw the account", { timeout: 60000 }, async () => {
    const { tenant, admin, account, cycle, sessionIat } = await seed();
    const grant = async (amountMinor: string) => {
      const raw = `pg-withdraw-grant-${++grantSeq}-${Date.now()}`;
      await prisma.stepUpGrant.create({
        data: {
          tokenHash: hashStepUpToken(raw),
          subjectType: "user",
          subjectId: admin.id,
          sessionId: `legacy:${admin.id}:${sessionIat}`,
          purpose: "susu.withdrawal",
          targetType: "susuAccount",
          targetId: account.id,
          contextHash: stepUpContextHash({
            purpose: "susu.withdrawal",
            targetType: "susuAccount",
            targetId: account.id,
            context: { amountMinor, currency: "GHS" },
          }),
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      return raw;
    };
    const [grantA, grantB] = [await grant("8000"), await grant("8000")];

    const [first, second] = await Promise.all([
      processWithdrawal({ accountId: account.id, requestedAmount: 80, stepUpToken: grantA }),
      processWithdrawal({ accountId: account.id, requestedAmount: 80, stepUpToken: grantB }),
    ]);

    const successes = [first, second].filter((r) => r.success);
    expect(successes).toHaveLength(1);

    const withdrawals = await prisma.withdrawal.findMany({
      where: { tenantId: tenant.id, cycleId: cycle.id },
    });
    expect(withdrawals).toHaveLength(1);

    const contributions = await prisma.contribution.aggregate({
      where: { cycleId: cycle.id, tenantId: tenant.id },
      _sum: { amount: true },
    });
    const paid = await prisma.withdrawal.aggregate({
      where: { cycleId: cycle.id, tenantId: tenant.id },
      _sum: { netAmount: true },
    });
    const commission = await prisma.commission.aggregate({
      where: { cycleId: cycle.id, tenantId: tenant.id },
      _sum: { amount: true },
    });
    const balance =
      Number(contributions._sum.amount ?? 0) -
      Number(paid._sum.netAmount ?? 0) -
      Number(commission._sum.amount ?? 0);
    expect(balance).toBe(10);
    expect(balance).toBeGreaterThanOrEqual(0);
  });

  it("posts a retried withdrawal once when the idempotency key matches", { timeout: 60000 }, async () => {
    const { account, admin, sessionIat } = await seed();
    const key = "pg-retry-key-0001";
    const grant = async () => {
      const raw = `pg-retry-grant-${++grantSeq}-${Date.now()}`;
      await prisma.stepUpGrant.create({
        data: {
          tokenHash: hashStepUpToken(raw),
          subjectType: "user",
          subjectId: admin.id,
          sessionId: `legacy:${admin.id}:${sessionIat}`,
          purpose: "susu.withdrawal",
          targetType: "susuAccount",
          targetId: account.id,
          contextHash: stepUpContextHash({
            purpose: "susu.withdrawal",
            targetType: "susuAccount",
            targetId: account.id,
            context: { amountMinor: "2000", currency: "GHS" },
          }),
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      return raw;
    };
    const [grantA, grantB] = [await grant(), await grant()];

    const [first, second] = await Promise.all([
      processWithdrawal({
        accountId: account.id,
        requestedAmount: 20,
        idempotencyKey: key,
        stepUpToken: grantA,
      }),
      processWithdrawal({
        accountId: account.id,
        requestedAmount: 20,
        idempotencyKey: key,
        stepUpToken: grantB,
      }),
    ]);

    expect([first, second].filter((r) => r.success)).toHaveLength(1);
    expect(await prisma.withdrawal.count()).toBe(1);
  });
});
