import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase } from "./pg-setup";

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

import { correctDailyAccount } from "@/lib/actions/daily-account.actions";
import { recordRemittance, reverseRemittance } from "@/lib/actions/susu-collector.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function session(admin: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: admin.id,
      email: admin.email,
      fullName: "Admin",
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function seedTenant() {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PG-COR-${Date.now()}`,
      name: "PG Correction",
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pg-cor-admin-${Date.now()}@test.local`,
      fullName: "PG Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  await session(admin);
  return { tenant, admin };
}

function form() {
  const data = new FormData();
  const fields = {
    openingMomoFloat: "10",
    openingCash: "10",
    totalCashIn: "20",
    totalCashOut: "0",
    totalCashReceived: "0",
    totalCashPaid: "0",
    commission: "0",
    otherIncome: "0",
    closingMomoFloat: "30",
    closingCash: "10",
    expenses: "[]",
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("PostgreSQL financial corrections", () => {
  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
  });

  it("allows only one concurrent daily-account correction", async () => {
    const { tenant, admin } = await seedTenant();
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, code: "PG-COR-01", name: "PG Location", status: "active" },
    });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `pg-worker-${Date.now()}@test.local`,
        fullName: "PG Worker",
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
        workerId: worker.id,
        businessDate: new Date("2026-11-03T00:00:00.000Z"),
        status: "submitted",
        submittedAt: new Date(),
      },
    });

    const results = await Promise.all([
      correctDailyAccount(account.id, form(), "Concurrent correction A reason"),
      correctDailyAccount(account.id, form(), "Concurrent correction B reason"),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);

    const updated = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { revisions: true },
    });
    expect(updated.revisionCount).toBe(1);
    expect(updated.revisions).toHaveLength(1);
    expect(updated.correctedById).toBe(admin.id);
  });

  it("allows only one concurrent remittance reversal", async () => {
    const { tenant } = await seedTenant();
    const collectorUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `pg-collector-${Date.now()}@test.local`,
        fullName: "PG Collector",
        role: "collector",
        status: "active",
        passwordHash: "not-used",
      },
    });
    const collector = await prisma.collector.create({
      data: { tenantId: tenant.id, userId: collectorUser.id, status: "active" },
    });
    const recorded = await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 10,
    });
    expect(recorded.success).toBe(true);
    const id = (recorded.data as { id: string }).id;

    const results = await Promise.all([
      reverseRemittance({ remittanceId: id, reason: "Concurrent reversal reason A" }),
      reverseRemittance({ remittanceId: id, reason: "Concurrent reversal reason B" }),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);

    const row = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("reversed");
    expect(row.reversedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { tenantId: tenant.id, action: "susu.remittance_reversed", entityId: id },
      })
    ).toBe(1);
  });
});
