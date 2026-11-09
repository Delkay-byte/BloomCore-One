/**
 * MaaCash operational improvements:
 *  - Airtime Sold is stored and displayed but never enters the combined
 *    accountability formula.
 *  - Physical handover is confirmed separately from accounting review.
 *  - The handover preserves the actual amount and any discrepancy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
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

import {
  confirmDailyHandover,
  createDailyAccount,
  saveDailyAccount,
  submitDailyAccount,
} from "@/lib/actions/daily-account.actions";
import { calculateReconciliation } from "@/lib/momo-reconciliation";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setSession(
  module: "admin" | "momo",
  user: { id: string; email: string }
) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    module === "admin" ? "bik-admin-session" : "bik-worker-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test",
      role: module === "admin" ? "admin" : "worker",
      modules: module === "admin" ? ["momo"] : ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function fixture() {
  const tenant = await createTestTenant({ momo: true, susu: false });
  const location = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Airtime Shop", code: "AIR-1" },
  });
  const agent = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `airtime-agent-${Date.now()}@test.invalid`,
      fullName: "Airtime Agent",
      role: "worker",
      passwordHash: await bcrypt.hash("Test1234!", 4),
      momoEnabled: true,
      locationId: location.id,
    },
  });
  return { tenant, location, agent };
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("Airtime Sold in daily closing", () => {
  it("accepts zero when no airtime was sold and keeps the formula unchanged", async () => {
    const { location, agent } = await fixture();
    await setSession("momo", agent);
    const created = await createDailyAccount(location.id, "2026-11-09");
    const id = (created.data as { id: string }).id;

    const saved = await saveDailyAccount(
      id,
      form({
        openingCash: "500",
        openingMomoFloat: "1000",
        closingCash: "500",
        closingMomoFloat: "1000",
        commission: "0",
        debtsCollected: "0",
        totalAirtimeSold: "0",
        expenses: "[]",
      })
    );
    expect(saved.success).toBe(true);
    const row = await prisma.dailyAccount.findUniqueOrThrow({ where: { id } });
    expect(Number(row.totalAirtimeSold)).toBe(0);
    expect(Number(row.calculatedDifference)).toBe(0);
  });

  it("records GH₵100 airtime without changing expected or actual combined money", async () => {
    const { location, agent } = await fixture();
    await setSession("momo", agent);
    const created = await createDailyAccount(location.id, "2026-11-10");
    const id = (created.data as { id: string }).id;

    // Airtime 100: physical cash +100, E-cash -100. Combined stays 1500.
    const saved = await saveDailyAccount(
      id,
      form({
        openingCash: "500",
        openingMomoFloat: "1000",
        closingCash: "600",
        closingMomoFloat: "900",
        commission: "0",
        debtsCollected: "0",
        totalAirtimeSold: "100",
        expenses: "[]",
      })
    );
    expect(saved.success).toBe(true);

    const row = await prisma.dailyAccount.findUniqueOrThrow({ where: { id } });
    expect(Number(row.totalAirtimeSold)).toBe(100);
    expect(Number(row.closingCash)).toBe(600);
    expect(Number(row.closingMomoFloat)).toBe(900);
    expect(Number(row.calculatedDifference)).toBe(0);

    const result = calculateReconciliation({
      openingCash: Number(row.openingCash),
      openingMomoFloat: Number(row.openingMomoFloat),
      commission: Number(row.commission),
      debtsCollected: Number(row.debtsCollected),
      totalExpenses: Number(row.totalExpenses),
      closingCash: Number(row.closingCash),
      closingMomoFloat: Number(row.closingMomoFloat),
    });
    expect(result.openingTotal).toBe(1500);
    expect(result.expectedClosing).toBe(1500);
    expect(result.actualClosing).toBe(1500);
    expect(result.difference).toBe(0);
  });

  it("does not double-count airtime alongside commission, debts and expenses", async () => {
    const { location, agent } = await fixture();
    await setSession("momo", agent);
    const created = await createDailyAccount(location.id, "2026-11-11");
    const id = (created.data as { id: string }).id;

    // Opening 1000 + commission 20 + debts 50 - expenses 30 = expected 1040.
    // Airtime 100 only moves the split: cash 520, e-cash 520.
    const saved = await saveDailyAccount(
      id,
      form({
        openingCash: "400",
        openingMomoFloat: "600",
        closingCash: "520",
        closingMomoFloat: "520",
        commission: "20",
        debtsCollected: "50",
        totalAirtimeSold: "100",
        expenses: JSON.stringify([{ description: "Transport", amount: 30 }]),
      })
    );
    expect(saved.success).toBe(true);

    const row = await prisma.dailyAccount.findUniqueOrThrow({ where: { id } });
    const result = calculateReconciliation({
      openingCash: Number(row.openingCash),
      openingMomoFloat: Number(row.openingMomoFloat),
      commission: Number(row.commission),
      debtsCollected: Number(row.debtsCollected),
      totalExpenses: Number(row.totalExpenses),
      closingCash: Number(row.closingCash),
      closingMomoFloat: Number(row.closingMomoFloat),
    });
    expect(Number(row.totalAirtimeSold)).toBe(100);
    expect(result.expectedClosing).toBe(1040);
    expect(result.actualClosing).toBe(1040);
    expect(result.difference).toBe(0);
    expect(result.netIncrease).toBe(40);
  });

  it("rejects airtime with more than two decimal places on the server", async () => {
    const { location, agent } = await fixture();
    await setSession("momo", agent);
    const created = await createDailyAccount(location.id, "2026-11-12");
    const id = (created.data as { id: string }).id;

    const saved = await saveDailyAccount(
      id,
      form({
        openingCash: "100",
        openingMomoFloat: "100",
        closingCash: "100",
        closingMomoFloat: "100",
        commission: "0",
        debtsCollected: "0",
        totalAirtimeSold: "10.001",
        expenses: "[]",
      })
    );
    expect(saved.success).toBe(false);
    expect(saved.error).toContain("two decimal");
  });
});

describe("physical handover confirmation", () => {
  it("is separate from review and preserves the actual amount and discrepancy", async () => {
    const { tenant, location, agent } = await fixture();
    await setSession("momo", agent);
    const created = await createDailyAccount(location.id, "2026-11-13");
    const id = (created.data as { id: string }).id;
    await saveDailyAccount(
      id,
      form({
        openingCash: "500",
        openingMomoFloat: "1000",
        closingCash: "600",
        closingMomoFloat: "900",
        commission: "0",
        debtsCollected: "0",
        totalAirtimeSold: "100",
        expenses: "[]",
      })
    );
    expect((await submitDailyAccount(id)).success).toBe(true);

    const admin = await createTestAdmin({
      tenantId: tenant.id,
      momo: true,
      susu: false,
    });
    await setSession("admin", admin);

    const mismatch = await confirmDailyHandover(
      id,
      form({ actualAmountReceived: "1480", handoverNote: "" })
    );
    expect(mismatch.success).toBe(false);
    expect(mismatch.error).toContain("Explain the difference");

    const confirmed = await confirmDailyHandover(
      id,
      form({
        actualAmountReceived: "1480",
        handoverNote: "GH₵20 was withheld for an agreed float top-up.",
      })
    );
    expect(confirmed.success).toBe(true);

    const row = await prisma.dailyAccount.findUniqueOrThrow({ where: { id } });
    expect(Number(row.actualAmountReceived)).toBe(1480);
    expect(Number(row.handoverDifference)).toBe(-20);
    expect(row.handoverNote).toContain("float top-up");
    expect(row.handoverConfirmedAt).not.toBeNull();
    // Airtime remains informational and does not alter expected handover.
    expect(Number(row.totalAirtimeSold)).toBe(100);
    expect(Number(row.calculatedDifference)).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "daily_account.handover_confirmed", entityId: id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.details).toContain("1480");
  });
});
