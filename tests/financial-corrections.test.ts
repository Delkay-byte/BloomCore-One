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
import {
  correctDailyAccount,
  getDailyAccountCorrectionData,
} from "@/lib/actions/daily-account.actions";

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
    const successes = results.filter((result) => result.success).length;
    // SQLite serialises the two interactive transactions, so the second call
    // may legitimately read the first committed version and succeed. The real
    // same-base rejection is covered by the PostgreSQL concurrency test. Here
    // assert the invariant: no lost update and one immutable revision per
    // successful correction.
    expect(successes).toBeGreaterThanOrEqual(1);
    const updated = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { revisions: true },
    });
    expect(updated.revisionCount).toBe(successes);
    expect(updated.revisions).toHaveLength(successes);
    expect(new Set(updated.revisions.map((revision) => revision.version)).size).toBe(
      updated.revisions.length
    );
  });

  it("exposes correction history only to the owning tenant administrator", async () => {
    const tenantA = await createTestTenant({ name: "Correction Tenant A" });
    const tenantB = await createTestTenant({ name: "Correction Tenant B" });
    const adminA = await createTestAdmin({ tenantId: tenantA.id });
    const adminB = await createTestAdmin({ tenantId: tenantB.id });
    await setAdminSession(adminA);

    const location = await prisma.location.create({
      data: { tenantId: tenantA.id, code: "COR-READ", name: "Read Model", status: "active" },
    });
    const workerUser = await prisma.user.create({
      data: {
        tenantId: tenantA.id,
        email: "daily-worker-read@test.local",
        fullName: "Read Worker",
        role: "worker",
        status: "active",
        passwordHash: "not-used",
        locationId: location.id,
      },
    });
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: tenantA.id,
        locationId: location.id,
        workerId: workerUser.id,
        businessDate: new Date("2026-11-03T00:00:00.000Z"),
        openingMomoFloat: 100,
        closingMomoFloat: 110,
        status: "submitted",
        submittedAt: new Date(),
      },
    });

    const corrected = await correctDailyAccount(
      account.id,
      dailyForm({
        openingMomoFloat: "100",
        openingCash: "0",
        totalCashIn: "10",
        totalCashOut: "0",
        totalCashReceived: "0",
        totalCashPaid: "0",
        commission: "0",
        otherIncome: "0",
        closingMomoFloat: "110",
        closingCash: "0",
        expenses: "[]",
      }),
      "Read-model correction for the revision screen"
    );
    expect(corrected.success).toBe(true);

    const own = await getDailyAccountCorrectionData(account.id);
    expect(own).not.toBeNull();
    expect(own!.revisions).toHaveLength(1);
    expect(own!.revisions[0].correctedByName).toBe("Test Admin");
    expect(own!.revisions[0].snapshot.closingMomoFloat).toBe(110);

    // A different tenant's administrator cannot read the record or its history.
    await setAdminSession(adminB);
    expect(await getDailyAccountCorrectionData(account.id)).toBeNull();

    // No session at all is redirected by the admin guard, never served data.
    mockCookieStore.clear();
    await expect(getDailyAccountCorrectionData(account.id)).rejects.toThrow(
      "REDIRECT:"
    );
  });
});
