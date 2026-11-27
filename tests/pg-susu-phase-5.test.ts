/**
 * Phase 5 concurrency on PostgreSQL.
 *
 * SQLite proves the lifecycle. This suite runs the same exported actions
 * against a disposable PostgreSQL database so the advisory locks, unique
 * constraints and conditional state changes are exercised under real
 * parallel transactions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { prisma, cleanDatabase } from "./pg-setup";
import { createSessionRecord } from "@/lib/security/session-store";
import {
  openReconciliationSession,
  reconcileSession,
  raiseCasesForSession,
  openDailyCollectorClosing,
  declareDailyClosing,
  recordDailyClosingHandover,
  receiveDailyClosing,
  closeDailyClosing,
} from "@/lib/actions/susu-reconciliation.actions";
import { openExceptionCase } from "@/lib/actions/susu-exception-cases.actions";

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
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
let sequence = 0;

async function asAdmin(user: { id: string; tenantId: string | null; email: string }) {
  if (!user.tenantId) throw new Error("test user has no tenant");
  const now = Math.floor(Date.now() / 1000);
  const jti = `pgp5-${now}-${Math.random().toString(16).slice(2)}`;
  await createSessionRecord({
    id: jti,
    subjectType: "user",
    subjectId: user.id,
    tenantId: user.tenantId,
    expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "PG Phase 5 Admin",
      role: "admin",
      modules: ["susu"],
      tokenVersion: 0,
      jti,
      iat: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function fixture() {
  sequence += 1;
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PGP5-${sequence}-${suffix}`,
      name: `PG Phase 5 Tenant ${sequence}`,
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  const branch = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Accra", code: `PG5ACC-${sequence}`, status: "active" },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pgp5-admin-${sequence}-${suffix}@test.local`,
      fullName: "PG Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
    },
  });
  await prisma.businessTenant.update({
    where: { id: tenant.id },
    data: { primaryAdminUserId: admin.id },
  });
  const collectorUser = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pgp5-collector-${sequence}-${suffix}@test.local`,
      fullName: "PG Collector",
      role: "collector",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
      locationId: branch.id,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId: tenant.id, userId: collectorUser.id, status: "active", branchId: branch.id },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `PG5-C-${sequence}-${suffix}`,
      fullName: "PG Customer",
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `PG5-S-${sequence}-${suffix}`,
      customerId: customer.id,
      dailyContribution: 50,
      status: "active",
      cardCustody: "customer",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleNumber: 1,
      startDate: day,
      endDate: new Date(day.getTime() + 86_400_000 * 31),
      dailyContribution: 50,
      status: "active",
      commissionCharged: false,
    },
  });
  await prisma.contribution.create({
    data: {
      tenantId: tenant.id,
      branchId: branch.id,
      accountId: account.id,
      cycleId: cycle.id,
      amount: 50,
      collectionDate: new Date(),
      channel: "collector",
      collectorId: collector.id,
      recordedById: admin.id,
      referenceId: `PG5-${suffix}`,
    },
  });
  return { tenant, branch, admin, collector, day };
}

describe("Phase 5 PostgreSQL concurrency", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates one daily closing when two open requests race for the same day", async () => {
    const { branch, admin, collector, day } = await fixture();
    await asAdmin(admin);

    const results = await Promise.all([
      openDailyCollectorClosing({ collectorId: collector.id, closingDate: day }),
      openDailyCollectorClosing({ collectorId: collector.id, closingDate: day }),
      openDailyCollectorClosing({ collectorId: collector.id, closingDate: day }),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    const ids = results.map((result) => result.data?.id).filter(Boolean);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);

    const rows = await prisma.dailyCollectorClosing.findMany({
      where: { tenantId: branch.tenantId, collectorId: collector.id },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].expectedCash)).toBe(50);
  });

  it("closes a received day once and creates one case under a retry", async () => {
    const { branch, admin, collector, day } = await fixture();
    await asAdmin(admin);
    const opened = await openDailyCollectorClosing({
      collectorId: collector.id,
      closingDate: day,
    });
    expect(opened.success).toBe(true);
    const closingId = opened.data!.id;

    expect((await declareDailyClosing({ closingId, declaredCash: 50 })).success).toBe(true);

    // Handover and receipt are separate pairs of eyes.
    const handover = await prisma.user.create({
      data: {
        tenantId: branch.tenantId,
        email: `pgp5-handover-${randomBytes(4).toString("hex")}@test.local`,
        fullName: "PG Handover",
        role: "admin",
        status: "active",
        passwordHash: "not-used",
        susuEnabled: true,
      },
    });
    await asAdmin(handover);
    expect(
      (await recordDailyClosingHandover({ closingId, handoverAmount: 50 })).success
    ).toBe(true);

    const receiver = await prisma.user.create({
      data: {
        tenantId: branch.tenantId,
        email: `pgp5-receiver-${randomBytes(4).toString("hex")}@test.local`,
        fullName: "PG Receiver",
        role: "admin",
        status: "active",
        passwordHash: "not-used",
        susuEnabled: true,
      },
    });
    await asAdmin(receiver);
    expect(
      (
        await receiveDailyClosing({
          closingId,
          receivedAmount: 40,
          note: "Synthetic shortfall",
          evidenceRef: "PG-TEST-RECEIPT",
        })
      ).success
    ).toBe(true);

    const attempts = await Promise.all([
      closeDailyClosing({ closingId }),
      closeDailyClosing({ closingId }),
      closeDailyClosing({ closingId }),
    ]);
    expect(attempts.every((result) => result.success)).toBe(true);

    const closing = await prisma.dailyCollectorClosing.findUniqueOrThrow({
      where: { id: closingId },
    });
    expect(closing.status).toBe("exception");
    expect(closing.exceptionCaseId).toBeTruthy();
    const cases = await prisma.reconciliationExceptionCase.findMany({
      where: { tenantId: branch.tenantId, sourceSessionId: null, category: "daily_close" },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe(closing.exceptionCaseId);
  });

  it("creates one case when raiseCasesForSession is retried concurrently", async () => {
    const { branch, admin, collector } = await fixture();
    await asAdmin(admin);
    const opened = await openReconciliationSession({
      type: "daily_close",
      branchId: branch.id,
      collectorId: collector.id,
      periodStart: new Date(new Date().setUTCHours(0, 0, 0, 0)),
      periodEnd: new Date(new Date().setUTCHours(0, 0, 0, 0)),
    });
    expect(opened.success).toBe(true);
    const sessionId = opened.data!.id;
    const detection = await reconcileSession(sessionId);
    expect(detection.success).toBe(true);
    expect(detection.data?.created ?? 0).toBeGreaterThan(0);

    const attempts = await Promise.all([
      raiseCasesForSession(sessionId),
      raiseCasesForSession(sessionId),
      raiseCasesForSession(sessionId),
    ]);
    expect(attempts.every((result) => result.success)).toBe(true);

    const cases = await prisma.reconciliationExceptionCase.findMany({
      where: { tenantId: branch.tenantId, sourceSessionId: sessionId },
    });
    expect(cases).toHaveLength(1);
    const lines = await prisma.reconciliationLine.findMany({
      where: { sessionId, exceptionCaseId: cases[0].id },
    });
    expect(lines.length).toBeGreaterThan(0);
  });

  it("allocates unique sequential case numbers under concurrent inserts", async () => {
    const { branch, admin } = await fixture();
    await asAdmin(admin);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        openExceptionCase({
          category: "other",
          severity: "low",
          title: `Concurrent case ${index}`,
          description: "Synthetic concurrency probe",
          branchId: branch.id,
          amountAtStake: 0,
        })
      )
    );
    expect(results.every((result) => result.success)).toBe(true);
    const caseIds = results.map((result) => result.data?.id).filter(Boolean);
    expect(new Set(caseIds).size).toBe(5);

    const cases = await prisma.reconciliationExceptionCase.findMany({
      where: { id: { in: caseIds as string[] } },
      select: { caseNumber: true },
    });
    expect(cases).toHaveLength(5);
    expect(new Set(cases.map((row) => row.caseNumber)).size).toBe(5);
    for (const row of cases) {
      expect(row.caseNumber).toMatch(/^REC-\d{4}-\d{4}$/);
    }
  });
});
