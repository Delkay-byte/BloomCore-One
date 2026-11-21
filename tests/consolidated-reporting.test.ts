/**
 * Consolidated MoMo reporting (Priority 10).
 *
 * The audit found three honest gaps: branch declarations were not in BI, a report
 * could look complete because missing days were simply absent, and some labels used
 * "income" or "profit" for what were principal or operational movements. These tests
 * pin all three.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  ASSET_TYPE_LABELS,
  computeCashPosition,
  computeConsolidatedFlow,
  transferSettled,
} from "@/lib/reporting/cash-position";
import { computeCompleteness, eachDay, LATE_SUBMISSION_DAYS } from "@/lib/reporting/completeness";
import { FORBIDDEN_LABELS, METRIC_BY_KEY, METRIC_DICTIONARY } from "@/lib/reporting/dictionary";

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

import { exportConsolidatedCsv, getConsolidatedReport } from "@/lib/actions/reporting.actions";

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

const D = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe("metric dictionary", () => {
  it("never calls an operational movement income, revenue or profit", () => {
    for (const metric of METRIC_DICTIONARY) {
      const label = metric.label.toLowerCase();
      for (const forbidden of FORBIDDEN_LABELS) {
        expect(label).not.toBe(forbidden);
      }
      expect(metric.formula.length).toBeGreaterThan(10);
      expect(metric.excludes.length).toBeGreaterThan(5);
    }
  });

  it("labels principal as volume and the operating result as accounting", () => {
    expect(METRIC_BY_KEY.get("principal_in")?.kind).toBe("volume");
    expect(METRIC_BY_KEY.get("principal_out")?.kind).toBe("volume");
    expect(METRIC_BY_KEY.get("net_operating")?.kind).toBe("accounting");
    expect(METRIC_BY_KEY.get("net_operating")?.excludes).toMatch(/not profit/i);
    expect(METRIC_BY_KEY.get("declared_cash")?.kind).toBe("position");
    expect(METRIC_BY_KEY.get("transfers_in")?.kind).toBe("operational_flow");
  });

  it("has a unique key for every metric", () => {
    const keys = METRIC_DICTIONARY.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(METRIC_DICTIONARY.length).toBeGreaterThanOrEqual(15);
  });
});

describe("cash position arithmetic", () => {
  it("takes the newest declaration per asset and splits float by network", () => {
    const report = computeCashPosition({
      from: "2026-12-01",
      to: "2026-12-10",
      asOf: D("2026-12-11"),
      locations: ["branch-a"],
      declarations: [
        { locationId: "branch-a", assetType: "cash", declaredBalance: 100, declaredAt: D("2026-12-01") },
        { locationId: "branch-a", assetType: "cash", declaredBalance: 250, declaredAt: D("2026-12-09") },
        { locationId: "branch-a", assetType: "mtn_float", declaredBalance: 500, declaredAt: D("2026-12-09") },
        { locationId: "branch-a", assetType: "telecel_float", declaredBalance: 0, declaredAt: D("2026-12-09") },
      ],
      closes: [],
      transfers: [],
    });
    const branch = report.branches[0];
    expect(branch.declaredCash).toBe(250);
    expect(branch.declaredFloat).toBe(500);
    expect(branch.declaredFloatByNetwork).toEqual({ mtn_float: 500 });
    expect(branch.declarationAgeDays).toBe(2);
    expect(report.totals.declaredCash).toBe(250);
  });

  it("counts only settled transfers, in and out, inside the period", () => {
    const report = computeCashPosition({
      from: "2026-12-01",
      to: "2026-12-10",
      asOf: D("2026-12-10"),
      locations: ["a", "b"],
      declarations: [],
      closes: [],
      transfers: [
        {
          sourceLocationId: "a",
          destinationLocationId: "b",
          assetType: "cash",
          amount: 300,
          status: "received",
          movedAt: D("2026-12-05"),
        },
        {
          sourceLocationId: "a",
          destinationLocationId: "b",
          assetType: "cash",
          amount: 100,
          status: "completed",
          movedAt: D("2026-12-06"),
        },
        {
          sourceLocationId: "b",
          destinationLocationId: "a",
          assetType: "cash",
          amount: 50,
          status: "dispatched",
          movedAt: D("2026-12-07"),
        },
        {
          sourceLocationId: "b",
          destinationLocationId: "a",
          assetType: "cash",
          amount: 999,
          status: "received",
          movedAt: D("2026-11-20"),
        },
      ],
    });
    const a = report.branches.find((row) => row.locationId === "a")!;
    const b = report.branches.find((row) => row.locationId === "b")!;
    expect(a.transfersOut).toBe(400);
    expect(a.transfersIn).toBe(0);
    expect(b.transfersIn).toBe(400);
    expect(b.transfersOut).toBe(0);
    expect(report.totals.transfersIn).toBe(400);
    expect(report.totals.transfersOut).toBe(400);
    expect(transferSettled("received")).toBe(true);
    expect(transferSettled("dispatched")).toBe(false);
  });

  it("compares a declaration with the last reported close instead of adding them", () => {
    const report = computeCashPosition({
      from: "2026-12-01",
      to: "2026-12-10",
      asOf: D("2026-12-10"),
      locations: ["a"],
      declarations: [
        { locationId: "a", assetType: "cash", declaredBalance: 1_000, declaredAt: D("2026-12-09") },
      ],
      closes: [
        {
          locationId: "a",
          businessDate: D("2026-12-08"),
          status: "submitted",
          closingCash: 950,
          closingMomoFloat: 400,
          calculatedCashVariance: -10,
          calculatedMomoVariance: 5,
          calculatedDifference: -5,
        },
        {
          locationId: "a",
          businessDate: D("2026-12-09"),
          status: "reviewed",
          closingCash: 900,
          closingMomoFloat: 420,
          calculatedCashVariance: -20,
          calculatedMomoVariance: 0,
          calculatedDifference: -20,
        },
      ],
      transfers: [],
    });
    const branch = report.branches[0];
    expect(branch.closingCashReported).toBe(900);
    expect(branch.cashVariance).toBe(-30);
    expect(branch.cashMismatch).toBe(100);
    expect(branch.declaredCash + branch.closingCashReported).not.toBe(report.totals.declaredCash);
  });

  it("flags a stale declaration rather than presenting it as the position", () => {
    const report = computeCashPosition({
      from: "2026-12-01",
      to: "2026-12-10",
      asOf: D("2026-12-20"),
      locations: ["a", "b"],
      declarations: [
        { locationId: "a", assetType: "cash", declaredBalance: 100, declaredAt: D("2026-12-01") },
        { locationId: "b", assetType: "cash", declaredBalance: 100, declaredAt: D("2026-12-19") },
      ],
      closes: [],
      transfers: [],
    });
    expect(report.staleDeclarations).toEqual([{ locationId: "a", ageDays: 19 }]);
    expect(report.notes.some((note) => /older than 7 days/.test(note))).toBe(true);
  });

  it("labels each asset type in words", () => {
    expect(ASSET_TYPE_LABELS.cash).toBe("Cash");
    expect(ASSET_TYPE_LABELS.mtn_float).toBe("MTN float");
  });
});

describe("consolidated flow", () => {
  it("keeps principal out of income and excludes reversals", () => {
    const flow = computeConsolidatedFlow({
      transactions: [
        { type: "cash_in", direction: "inflow", amount: 10_000, status: "completed", isReversal: false },
        { type: "cash_out", direction: "outflow", amount: 4_000, status: "completed", isReversal: false },
        { type: "cash_in", direction: "inflow", amount: 999, status: "reversal", isReversal: true },
        { type: "cash_in", direction: "inflow", amount: 500, status: "failed", isReversal: false },
      ],
      closes: [
        {
          commission: 120,
          otherIncome: 30,
          debtsCollected: 50,
          totalExpenses: 40,
          status: "submitted",
        },
        {
          commission: 30,
          otherIncome: 0,
          debtsCollected: 0,
          totalExpenses: 10,
          status: "draft",
        },
      ],
    });
    expect(flow.principalIn).toBe(10_000);
    expect(flow.principalOut).toBe(4_000);
    expect(flow.commission).toBe(120);
    expect(flow.otherIncome).toBe(30);
    expect(flow.debtsCollected).toBe(50);
    expect(flow.expenses).toBe(40);
    expect(flow.netOperating).toBe(160);
    // The operating result does not include principal volume.
    expect(flow.netOperating).toBeLessThan(flow.principalIn);
  });

  it("can report a negative operating result without calling it a cash shortage", () => {
    const flow = computeConsolidatedFlow({
      transactions: [],
      closes: [
        { commission: 10, otherIncome: 0, debtsCollected: 0, totalExpenses: 60, status: "submitted" },
      ],
    });
    expect(flow.netOperating).toBe(-50);
    expect(flow.principalIn).toBe(0);
  });
});

describe("completeness", () => {
  it("lists the days that should exist and counts the ones that do not", () => {
    const report = computeCompleteness({
      from: "2026-12-01",
      to: "2026-12-05",
      branches: [{ id: "a", name: "Accra" }],
      workers: [
        { id: "w1", fullName: "Ama", locationId: "a", status: "active" },
        { id: "w2", fullName: "Kofi", locationId: "a", status: "active" },
      ],
      accounts: [
        {
          locationId: "a",
          workerId: "w1",
          businessDate: D("2026-12-01"),
          status: "submitted",
          submittedAt: D("2026-12-01"),
        },
        {
          locationId: "a",
          workerId: "w1",
          businessDate: D("2026-12-02"),
          status: "draft",
          submittedAt: null,
        },
      ],
    });
    expect(report.days).toBe(5);
    const branch = report.branches[0];
    expect(branch.expectedDays).toBe(5);
    expect(branch.submittedDays).toBe(1);
    expect(branch.missingDays).toEqual(["2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"]);
    expect(branch.coveragePct).toBe(20);
    expect(report.totals.missingDays).toBe(4);
    expect(report.operatorsWithoutClose.map((row) => row.fullName)).toEqual(["Kofi"]);
  });

  it("counts a late submission and says why it matters", () => {
    const report = computeCompleteness({
      from: "2026-12-01",
      to: "2026-12-03",
      branches: [{ id: "a", name: "Accra" }],
      workers: [{ id: "w1", fullName: "Ama", locationId: "a", status: "active" }],
      accounts: [
        {
          locationId: "a",
          workerId: "w1",
          businessDate: D("2026-12-01"),
          status: "submitted",
          submittedAt: new Date(D("2026-12-01").getTime() + 4 * 86_400_000),
        },
      ],
    });
    expect(report.branches[0].lateDays).toBe(1);
    expect(report.notes.some((note) => note.includes(String(LATE_SUBMISSION_DAYS)))).toBe(true);
  });

  it("still counts a day a branch was closed instead of hiding it", () => {
    const report = computeCompleteness({
      from: "2026-12-01",
      to: "2026-12-02",
      branches: [{ id: "a", name: "Accra" }],
      workers: [],
      accounts: [],
    });
    expect(report.branches[0].expectedDays).toBe(2);
    expect(report.branches[0].missingDays).toEqual(["2026-12-01", "2026-12-02"]);
    expect(report.notes.some((note) => /is a trend/.test(note))).toBe(true);
  });

  it("builds an inclusive list of days and refuses a reversed range", () => {
    expect(eachDay("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(eachDay("2026-12-05", "2026-12-01")).toEqual([]);
    expect(eachDay("not-a-date", "2026-12-01")).toEqual([]);
  });
});

describe("consolidated report over records", () => {
  let fixture: Awaited<ReturnType<typeof makeFixture>> | null = null;

  async function makeFixture() {
    const tenant = await createTestTenant({ momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Report Branch", code: `RPT-${Date.now().toString().slice(-6)}` },
    });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `report-worker-${Date.now()}@test.invalid`,
        fullName: "Report Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        locationId: location.id,
      },
    });
    return { tenant, location, admin, worker };
  }

  function day(offset: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
      .toISOString()
      .slice(0, 10);
  }

  beforeEach(async () => {
    await cleanDatabase();
    fixture = await makeFixture();
  });

  it("reports declared cash, float, a settled transfer and the flow from records", async () => {
    const f = fixture!;
    const destination = await prisma.location.create({
      data: { tenantId: f.tenant.id, name: "Second Branch", code: `RPT2-${Date.now().toString().slice(-6)}` },
    });
    await prisma.branchAssetBalance.createMany({
      data: [
        { tenantId: f.tenant.id, locationId: f.location.id, assetType: "cash", declaredBalance: 1_500 },
        { tenantId: f.tenant.id, locationId: f.location.id, assetType: "mtn_float", declaredBalance: 800 },
      ],
    });
    await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        businessDate: D(day(1)),
        status: "submitted",
        submittedAt: new Date(),
        closingCash: 1_400,
        closingMomoFloat: 780,
        calculatedCashVariance: -100,
        calculatedMomoVariance: -20,
        calculatedDifference: -120,
        commission: 150,
        otherIncome: 25,
        debtsCollected: 0,
        totalExpenses: 40,
      },
    });
    await prisma.momoTransaction.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        type: "cash_in",
        network: "mtn",
        direction: "inflow",
        amount: 5_000,
        businessDate: D(day(1)),
        occurredAt: new Date(),
        reference: `RPT-${Date.now()}`,
        idempotencyKey: `rpt-${Date.now()}`,
        recordedById: f.worker.id,
      },
    });
    await prisma.branchTransfer.create({
      data: {
        tenantId: f.tenant.id,
        reference: `TRF-${Date.now()}`,
        idempotencyKey: `trf-${Date.now()}`,
        assetType: "cash",
        network: "none",
        sourceLocationId: f.location.id,
        destinationLocationId: destination.id,
        amount: 300,
        status: "received",
        initiatedById: f.admin.id,
        dispatchedAt: new Date(),
        receivedAt: new Date(),
      },
    });

    await setAdminSession(f.admin);
    const result = await getConsolidatedReport({ from: day(10), to: day(0) });
    expect(result.success, result.error).toBe(true);
    const report = result.data!;
    expect(report.branches).toHaveLength(2);
    expect(report.position.totals.declaredCash).toBe(1_500);
    expect(report.position.totals.declaredFloat).toBe(800);
    expect(report.position.totals.transfersOut).toBe(300);
    expect(report.position.totals.transfersIn).toBe(300);
    expect(report.flow.principalIn).toBe(5_000);
    expect(report.flow.commission).toBe(150);
    expect(report.flow.netOperating).toBe(135);
    expect(report.position.totals.cashVariance).toBe(-100);
    expect(report.dictionary.length).toBe(METRIC_DICTIONARY.length);
    expect(report.note).toMatch(/not profit/i);
  });

  it("shows a missing close as a missing day, not a quiet one", async () => {
    const f = fixture!;
    await setAdminSession(f.admin);
    const result = await getConsolidatedReport({ from: day(3), to: day(0) });
    const report = result.data!;
    const branch = report.completeness.branches.find((row) => row.locationId === f.location.id)!;
    expect(branch.expectedDays).toBe(4);
    expect(branch.submittedDays).toBe(0);
    expect(branch.missingDays).toHaveLength(4);
    expect(report.completeness.totals.coveragePct).toBe(0);
  });

  it("exports a CSV whose figures match the screen and whose labels avoid profit", async () => {
    const f = fixture!;
    await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        businessDate: D(day(1)),
        status: "submitted",
        submittedAt: new Date(),
        commission: 90,
        totalExpenses: 10,
      },
    });
    await setAdminSession(f.admin);

    const screen = await getConsolidatedReport({ from: day(5), to: day(0) });
    const csv = await exportConsolidatedCsv({ from: day(5), to: day(0) });
    expect(csv.success, csv.error).toBe(true);
    expect(csv.data!.filename).toContain(screen.data!.period.from);
    expect(csv.data!.csv).toContain("Consolidated MoMo report");
    expect(csv.data!.csv).toContain("Commission earned,Accounting result,90");
    expect(csv.data!.csv).toContain("Net operating result,Accounting result,80");
    expect(csv.data!.csv.toLowerCase()).not.toContain("net profit,");
    expect(csv.data!.csv.toLowerCase()).not.toContain("cash income");
    expect(csv.data!.csv).toContain("Report Branch");
  });

  it("refuses a period it cannot honour and keeps the range inside a year", async () => {
    const f = fixture!;
    await setAdminSession(f.admin);
    const reversed = await getConsolidatedReport({ from: "2026-12-10", to: "2026-12-01" });
    expect(reversed.data!.period).toEqual({ from: "2026-12-01", to: "2026-12-10" });

    const huge = await getConsolidatedReport({ from: "2020-01-01", to: "2026-12-01" });
    const span =
      (new Date(`${huge.data!.period.to}T00:00:00Z`).getTime() -
        new Date(`${huge.data!.period.from}T00:00:00Z`).getTime()) /
      86_400_000;
    expect(span).toBeLessThanOrEqual(366);
  });

  it("keeps another business's records out of the report", async () => {
    const f = fixture!;
    const otherTenant = await createTestTenant({ momo: true, susu: false });
    const otherAdmin = await createTestAdmin({
      tenantId: otherTenant.id,
      momo: true,
      susu: false,
    });
    const otherLocation = await prisma.location.create({
      data: {
        tenantId: otherTenant.id,
        name: "Other Branch",
        code: `OTH-${Date.now().toString().slice(-6)}`,
      },
    });
    await prisma.branchAssetBalance.create({
      data: {
        tenantId: otherTenant.id,
        locationId: otherLocation.id,
        assetType: "cash",
        declaredBalance: 99_999,
      },
    });

    await setAdminSession(otherAdmin);
    const other = await getConsolidatedReport({ from: day(2), to: day(0) });
    expect(other.success).toBe(true);
    expect(other.data!.position.totals.declaredCash).toBe(99_999);

    await setAdminSession(f.admin);
    const mine = await getConsolidatedReport({ from: day(2), to: day(0) });
    expect(mine.success).toBe(true);
    expect(mine.data!.position.totals.declaredCash).toBe(0);
  });
});
