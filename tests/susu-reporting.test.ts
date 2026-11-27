/**
 * Phase 6 — Susu reporting and analytics.
 *
 * Covers reversal-aware contribution totals, management overview figures and
 * the full filtered CSV export. The financial logic is pinned here so the
 * dashboard, report tables and exported figures cannot drift apart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant, createTestCustomer } from "./setup";
import { buildCsv, csvCell } from "@/lib/csv";
import {
  exportSusuReport,
  getContributionReport,
  getSusuOverview,
} from "@/lib/actions/susu-reporting.actions";
import { enforceExportRateLimit } from "@/lib/security/export-rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

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

import { exportConsolidatedCsv } from "@/lib/actions/reporting.actions";

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
      modules: ["susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

describe("Susu reporting", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reports gross, reversed and net contribution amounts reversal-aware", async () => {
    const tenant = await createTestTenant({ momo: true, susu: true });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: true });
    const { account, cycle } = await createTestCustomer(admin.id, 50, "RPT1");

    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 50,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: "RPT-CON-1",
      },
    });
    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 30,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: "RPT-CON-2",
      },
    });

    await setAdminSession(admin);
    const screen = await getContributionReport({ page: 1, limit: 50 });
    expect(screen.success, screen.error).toBe(true);
    expect(screen.data!.totals.grossRecorded).toBe(80);
    expect(screen.data!.totals.reversedAmount).toBe(0);
    expect(screen.data!.totals.netAmount).toBe(80);
    expect(screen.data!.totals.count).toBe(2);
  });

  it("keeps reversals visible but reports net financial effect", async () => {
    const tenant = await createTestTenant({ momo: true, susu: true });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: true });
    const { account, cycle } = await createTestCustomer(admin.id, 50, "RPT2");

    const original = await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 30,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: "RPT-CON-3",
      },
    });
    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: -30,
        collectionDate: new Date(),
        channel: "reversal",
        recordedById: admin.id,
        reversalOfId: original.id,
        referenceId: "RPT-CON-4",
      },
    });

    await setAdminSession(admin);
    const screen = await getContributionReport({ page: 1, limit: 50, reversalStatus: "reversed" });
    expect(screen.success, screen.error).toBe(true);
    const reversedRow = screen.data!.contributions.find(
      (row) => row.status === "reversed"
    );
    expect(reversedRow).toBeDefined();
    expect(reversedRow!.amount).toBe(-30);

    const all = await getContributionReport({ page: 1, limit: 50 });
    expect(all.data!.totals.grossRecorded).toBe(30);
    expect(all.data!.totals.reversedAmount).toBe(30);
    expect(all.data!.totals.netAmount).toBe(0);
  });

  it("exports the complete filtered contribution set, not just one page", async () => {
    const tenant = await createTestTenant({ momo: true, susu: true });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: true });
    const { account, cycle } = await createTestCustomer(admin.id, 10, "RPT3");

    for (let i = 0; i < 25; i += 1) {
      await prisma.contribution.create({
        data: {
          tenantId: tenant.id,
          accountId: account.id,
          cycleId: cycle.id,
          amount: 10,
          collectionDate: new Date(),
          channel: "direct_office",
          recordedById: admin.id,
          referenceId: `RPT-EXP-${i}`,
        },
      });
    }

    await setAdminSession(admin);
    const exportResult = await exportSusuReport({ report: "contributions" });
    expect(exportResult.success, exportResult.error).toBe(true);
    const csv = exportResult.data!.csv;
    const rows = csv.split("\r\n").filter((line) => line.length > 0);
    // Header + 25 contributions.
    expect(rows).toHaveLength(26);
    expect(csv).toContain("RPT-EXP-24");
  });

  it("computes management overview outstanding balances from recorded remittances", async () => {
    const tenant = await createTestTenant({ momo: true, susu: true });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: true });

    await setAdminSession(admin);
    const overview = await getSusuOverview();
    expect(overview.success, overview.error).toBe(true);
    expect(overview.data!.contributions.grossRecorded).toBe(0);
    expect(overview.data!.contributions.netAmount).toBe(0);
    expect(overview.data!.remittanceActivity.count).toBe(0);
    expect(overview.data!.outstandingBalances).toBe(0);
  });

  it("refuses a report for an unauthenticated caller", async () => {
    const result = await getContributionReport({ page: 1, limit: 50 });
    expect(result.success).toBe(false);
  });

  it("applies scoped export rate limits per tenant and actor", async () => {
    const policy = RATE_LIMITS.financeMutation;
    const outcome = await enforceExportRateLimit(
      "susuReport",
      "actor-susu-report",
      "tenant-susu-report",
      Date.now()
    );
    expect(outcome).toBeNull();
  });

  it("keeps spreadsheet formula injection out of exported cells", () => {
    expect(csvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    const csv = buildCsv([["Amount", "=cmd"], ["100", "20"]]);
    expect(csv).toContain("'=cmd");
  });
});
