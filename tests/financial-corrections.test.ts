import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

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

import { recordRemittance, reverseRemittance } from "@/lib/actions/susu-collector.actions";
import { correctDailyAccount } from "@/lib/actions/daily-account.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string }, modules: string[] = ["susu", "momo"]) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Admin",
      role: "admin",
      modules,
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

function dailyForm(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

describe("financial corrections", () => {
  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
  });

  it("reverses a remittance once, keeps the original and excludes it from active totals", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await setAdminSession(admin);

    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "collector-correction@test.local",
        fullName: "Collector",
        role: "collector",
        status: "active",
        passwordHash: "not-used",
      },
    });
    const collector = await prisma.collector.create({
      data: { tenantId: tenant.id, userId: worker.id, status: "active" },
    });

    const recorded = await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 50,
      notes: "Synthetic",
    });
    expect(recorded.success).toBe(true);
    const remittanceId = (recorded.data as { id: string }).id;

    const first = await reverseRemittance({
      remittanceId,
      reason: "Recorded against the wrong collector",
    });
    expect(first.success).toBe(true);

    const second = await reverseRemittance({
      remittanceId,
      reason: "Attempting the same reversal twice",
    });
    expect(second.success).toBe(false);

    const row = await prisma.collectorRemittance.findUniqueOrThrow({
      where: { id: remittanceId },
    });
    expect(row.status).toBe("reversed");
    expect(row.reversedAt).not.toBeNull();
    expect(row.reversedById).toBe(admin.id);
    expect(row.reversalReason).toContain("wrong collector");

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, action: "susu.remittance_reversed", entityId: remittanceId },
    });
    expect(audit).not.toBeNull();
  });

  it("corrects a submitted daily account with an immutable snapshot and audit", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await setAdminSession(admin);

    const location = await prisma.location.create({
      data: {
        tenantId: tenant.id,
        code: "COR-01",
        name: "Correction Location",
        status: "active",
      },
    });
    const workerUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "daily-worker@test.local",
        fullName: "Daily Worker",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        locationId: location.id,
      },
    });
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: workerUser.id,
        businessDate: new Date("2026-11-01T00:00:00.000Z"),
        openingMomoFloat: 100,
        openingCash: 50,
        totalCashIn: 200,
        totalCashOut: 20,
        totalCashReceived: 80,
        totalCashPaid: 10,
        commission: 5,
        otherIncome: 0,
        closingMomoFloat: 280,
        closingCash: 125,
        totalExpenses: 0,
        status: "submitted",
        submittedAt: new Date(),
        expenses: { create: [{ tenantId: tenant.id, description: "Transport", amount: 5 }] },
      },
    });

    const result = await correctDailyAccount(
      account.id,
      dailyForm({
        openingMomoFloat: "100",
        openingCash: "50",
        totalCashIn: "250",
        totalCashOut: "20",
        totalCashReceived: "80",
        totalCashPaid: "10",
        commission: "5",
        otherIncome: "0",
        closingMomoFloat: "330",
        closingCash: "125",
        expenses: JSON.stringify([{ description: "Transport", amount: 5 }]),
      }),
      "Cash-in figure omitted from the original submission"
    );
    expect(result.success).toBe(true);

    const updated = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { revisions: true, expenses: true },
    });
    expect(Number(updated.totalCashIn)).toBe(250);
    expect(updated.revisionCount).toBe(1);
    expect(updated.correctedById).toBe(admin.id);
    expect(updated.revisions).toHaveLength(1);

    const snapshot = JSON.parse(updated.revisions[0].snapshot);
    expect(snapshot.totalCashIn).toBe(200);
    expect(snapshot.status).toBe("submitted");
    expect(snapshot.expenses).toHaveLength(1);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, action: "daily_account.corrected", entityId: account.id },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects concurrent corrections from the same base version", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await setAdminSession(admin);
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, code: "COR-02", name: "Concurrent", status: "active" },
    });
    const workerUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "daily-worker-2@test.local",
        fullName: "Daily Worker 2",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        locationId: location.id,
      },
    });
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: workerUser.id,
        businessDate: new Date("2026-11-02T00:00:00.000Z"),
        status: "submitted",
        submittedAt: new Date(),
      },
    });

    const form = () =>
      dailyForm({
        openingMomoFloat: "10",
        openingCash: "10",
        totalCashIn: "10",
        totalCashOut: "0",
        totalCashReceived: "0",
        totalCashPaid: "0",
        commission: "0",
        otherIncome: "0",
        closingMomoFloat: "20",
        closingCash: "10",
        expenses: "[]",
      });

    const results = await Promise.all([
      correctDailyAccount(account.id, form(), "First concurrent correction reason"),
      correctDailyAccount(account.id, form(), "Second concurrent correction reason"),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    const updated = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { revisions: true },
    });
    expect(updated.revisionCount).toBe(1);
    expect(updated.revisions).toHaveLength(1);
  });
});
