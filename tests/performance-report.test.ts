/**
 * Business performance reporting rules and tenant-scoped action (Priority 5).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  buildPerformanceReport,
  comparePerformance,
  previousPerformancePeriod,
  resolvePerformancePeriod,
} from "@/lib/performance-report";

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

import { getPerformanceReport } from "@/lib/actions/performance.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test",
      role: "admin",
      modules: ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

const account = (
  id: string,
  locationId: string,
  businessDate: string,
  status: string,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  businessDate: new Date(`${businessDate}T00:00:00.000Z`),
  locationId,
  status,
  ledgerMode: "aggregate",
  commission: 0,
  otherIncome: 0,
  debtsCollected: 0,
  totalExpenses: 0,
  totalCashIn: 0,
  totalCashOut: 0,
  totalAirtimeSold: 0,
  calculatedDifference: 0,
  ...overrides,
});

describe("performance report rules", () => {
  it("uses commission and other income only, and excludes drafts", () => {
    const report = buildPerformanceReport({
      from: "2026-11-01",
      to: "2026-11-03",
      locations: [
        { id: "a", name: "Accra" },
        { id: "b", name: "Kumasi" },
      ],
      accounts: [
        account("a1", "a", "2026-11-01", "submitted", {
          commission: 100,
          otherIncome: 20,
          totalExpenses: 30,
          totalCashIn: 5000,
          totalCashOut: 4000,
          debtsCollected: 200,
          calculatedDifference: -10,
        }),
        account("b1", "b", "2026-11-01", "reviewed", {
          commission: 50,
          totalExpenses: 10,
          totalCashIn: 1000,
        }),
        account("a2", "a", "2026-11-02", "draft", {
          commission: 500,
          totalExpenses: 500,
          totalCashIn: 9000,
        }),
      ],
      ledger: [
        {
          id: "l1",
          type: "cash_in",
          status: "recorded",
          businessDate: new Date("2026-11-01T09:00:00Z"),
          locationId: "a",
          dailyAccountId: "a1",
        },
        {
          id: "l2",
          type: "commission",
          status: "recorded",
          businessDate: new Date("2026-11-01T10:00:00Z"),
          locationId: "a",
          dailyAccountId: null,
        },
      ],
      transfers: [
        {
          id: "t1",
          status: "completed",
          amount: 300,
          createdAt: new Date("2026-11-01T11:00:00Z"),
          sourceLocationId: "a",
        },
        {
          id: "t2",
          status: "dispatched",
          amount: 200,
          createdAt: new Date("2026-11-02T11:00:00Z"),
          sourceLocationId: "a",
        },
      ],
      shifts: [
        {
          id: "s1",
          status: "recorded",
          businessDate: new Date("2026-11-01T00:00:00Z"),
          locationId: "a",
          cashVariance: -20,
          floatVariance: 0,
        },
      ],
    });

    expect(report.totals).toMatchObject({
      revenue: 170,
      commission: 150,
      otherIncome: 20,
      expenses: 40,
      netOperating: 130,
      debtsCollected: 200,
      cashIn: 6000,
      cashOut: 4000,
      submittedDays: 2,
      reviewedDays: 1,
      draftDays: 1,
      shortageDays: 1,
      transactionCount: 2,
    });
    expect(report.drafts).toMatchObject({
      days: 1,
      revenue: 500,
      expenses: 500,
      netOperating: 0,
    });
    expect(report.drafts.cashIn).toBe(9000);

    const accra = report.byLocation.find((row) => row.locationId === "a");
    expect(accra).toMatchObject({
      revenue: 120,
      expenses: 30,
      netOperating: 90,
      shortageDays: 1,
      submittedDays: 1,
      draftDays: 1,
    });
    const kumasi = report.byLocation.find((row) => row.locationId === "b");
    expect(kumasi).toMatchObject({ revenue: 50, netOperating: 40 });

    expect(report.completeness).toMatchObject({
      activeLocations: 2,
      expectedLocationDays: 6,
      locationDaysWithoutAccount: 3,
      ledgerOnlyTransactions: 1,
      completedTransfers: 1,
      completedTransferAmount: 300,
      openTransferAmount: 200,
      openTransfers: 1,
      shifts: 1,
      shiftVariances: 1,
      shiftVarianceAmount: -20,
    });
    expect(report.source.confirmedStatuses).toEqual(["submitted", "reviewed"]);
  });

  it("does not treat principal or ledger rows as revenue", () => {
    const report = buildPerformanceReport({
      from: "2026-11-01",
      to: "2026-11-01",
      locations: [{ id: "a", name: "Accra" }],
      accounts: [
        account("a1", "a", "2026-11-01", "reviewed", {
          totalCashIn: 50_000,
          totalCashOut: 45_000,
          debtsCollected: 1_000,
          commission: 25,
        }),
      ],
      ledger: [
        {
          id: "l1",
          type: "cash_out",
          status: "recorded",
          businessDate: new Date("2026-11-01T09:00:00Z"),
          locationId: "a",
          dailyAccountId: "a1",
        },
      ],
    });

    expect(report.totals.revenue).toBe(25);
    expect(report.totals.cashIn).toBe(50_000);
    expect(report.totals.cashOut).toBe(45_000);
    expect(report.totals.debtsCollected).toBe(1_000);
  });

  it("compares with the previous period and handles a zero baseline honestly", () => {
    const base = {
      from: "2026-11-01",
      to: "2026-11-02",
      locations: [{ id: "a", name: "Accra" }],
      ledger: [],
    };
    const current = buildPerformanceReport({
      ...base,
      accounts: [
        account("a1", "a", "2026-11-01", "submitted", {
          commission: 120,
          totalExpenses: 20,
          totalCashIn: 500,
        }),
      ],
    });
    const previous = buildPerformanceReport({
      ...base,
      accounts: [
        account("p1", "a", "2026-10-30", "submitted", {
          commission: 100,
          totalExpenses: 20,
          totalCashIn: 400,
        }),
      ],
    });
    const delta = comparePerformance(current, previous);
    expect(delta.find((row) => row.metric === "revenue")).toMatchObject({
      current: 120,
      previous: 0,
      change: 120,
      changePercent: null,
    });

    const empty = comparePerformance(previous, previous);
    expect(empty.every((row) => row.change === 0 && row.changePercent === 0)).toBe(true);
  });

  it("normalises invalid dates and derives the adjacent period", () => {
    const safe = resolvePerformancePeriod("not-a-date", "2026-11-30");
    expect(safe.to).toBe("2026-11-30");
    expect(safe.from <= safe.to).toBe(true);

    expect(
      previousPerformancePeriod({ from: "2026-03-01", to: "2026-03-31" })
    ).toEqual({ from: "2026-01-29", to: "2026-02-28" });
  });
});

describe("tenant-scoped performance action", () => {
  let counter = 0;

  async function fixture() {
    counter += 1;
    const tenant = await createTestTenant({ momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Main Branch", code: `PERF-${counter}` },
    });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `perf-worker-${counter}@test.invalid`,
        fullName: "Perf Worker",
        role: "worker",
        status: "active",
        passwordHash: await bcrypt.hash("Test1234!", 4),
        momoEnabled: true,
        locationId: location.id,
      },
    });
    return { tenant, location, admin, worker };
  }

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns confirmed figures for the tenant and ignores another tenant", async () => {
    const f = await fixture();
    const other = await fixture();

    await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        businessDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "submitted",
        commission: 100,
        otherIncome: 10,
        totalExpenses: 25,
        totalCashIn: 1000,
        totalCashOut: 800,
      },
    });
    await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        businessDate: new Date("2026-11-06T00:00:00.000Z"),
        status: "draft",
        commission: 999,
        totalExpenses: 0,
      },
    });
    await prisma.dailyAccount.create({
      data: {
        tenantId: other.tenant.id,
        locationId: other.location.id,
        workerId: other.worker.id,
        businessDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "reviewed",
        commission: 5000,
      },
    });

    await setAdminSession(f.admin);
    const result = await getPerformanceReport({
      from: "2026-11-01",
      to: "2026-11-30",
    });

    expect(result.current.totals).toMatchObject({
      revenue: 110,
      expenses: 25,
      netOperating: 85,
      submittedDays: 1,
      draftDays: 1,
    });
    expect(result.locations).toHaveLength(1);
    expect(result.previous.totals.revenue).toBe(0);

    const filtered = await getPerformanceReport({
      from: "2026-11-01",
      to: "2026-11-30",
      locationId: f.location.id,
    });
    expect(filtered.current.totals.revenue).toBe(110);

    await setAdminSession(other.admin);
    const otherResult = await getPerformanceReport({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(otherResult.current.totals.revenue).toBe(5000);
  });
});
