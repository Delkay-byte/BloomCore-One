/**
 * Two-day MoMo agent reconciliation simulation.
 *
 * This is an ISOLATED SIMULATION, not production activity. It runs against the
 * dedicated SQLite test database, creates a clearly-labelled disposable tenant,
 * location and agent, and drives the REAL server actions
 * (createDailyAccount -> saveDailyAccount -> submitDailyAccount) exactly as the
 * application does. No staging or production database, customer, agent or
 * payment is touched.
 *
 * Day 1 is a correctly managed day: every movement is recorded and the cash
 * count matches the calculation, so both differences are zero.
 *
 * Day 2 opens with Day 1's actual closing balances and deliberately introduces
 * one operational error: the agent records the correct cash-out but counts
 * GH₵45 less physical cash than the drawer should hold. The shortfall is a
 * genuine consequence of the recorded transactions and the closing count, not a
 * value typed into a difference field.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase } from "./setup";

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
  createDailyAccount,
  saveDailyAccount,
  submitDailyAccount,
} from "@/lib/actions/daily-account.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const TEST_IDENTITY =
  "TEST — MOMO RECONCILIATION — DO NOT USE FOR REAL TRANSACTIONS";

async function setWorkerSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-worker-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test MoMo Agent",
      role: "worker",
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

function accountForm(values: {
  openingMomoFloat: number;
  openingCash: number;
  customerDeposit: number;
  cashOut: number;
  cashIn: number;
  commission: number;
  otherIncome?: number;
  closingMomoFloat: number;
  closingCash: number;
  expenses?: Array<{ description: string; amount: number }>;
}) {
  const formData = new FormData();
  formData.set("openingMomoFloat", String(values.openingMomoFloat));
  formData.set("openingCash", String(values.openingCash));
  formData.set("totalCashIn", String(values.customerDeposit));
  formData.set("totalCashOut", String(values.cashOut));
  formData.set("totalCashReceived", String(values.cashIn));
  formData.set("commission", String(values.commission));
  formData.set("otherIncome", String(values.otherIncome ?? 0));
  formData.set("closingMomoFloat", String(values.closingMomoFloat));
  formData.set("closingCash", String(values.closingCash));
  formData.set(
    "expenses",
    JSON.stringify(values.expenses ?? [])
  );
  return formData;
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("Two consecutive MoMo end-of-day reconciliations", () => {
  it("balances Day 1 and produces a genuine shortfall on Day 2", async () => {
    const tenant = await prisma.businessTenant.create({
      data: {
        code: `SIM-${Date.now().toString(36).toUpperCase()}`,
        name: TEST_IDENTITY,
        momoEnabled: true,
        susuEnabled: false,
        status: "ACTIVE",
        onboardingStatus: "COMPLETED",
      },
    });
    const location = await prisma.location.create({
      data: {
        tenantId: tenant.id,
        name: `${TEST_IDENTITY} — SIMULATED SHOP`,
        code: "SIM-001",
        status: "active",
      },
    });
    const agent = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `sim-momo-${Date.now()}@test.invalid`,
        fullName: "TEST — MOMO AGENT — DO NOT USE FOR REAL TRANSACTIONS",
        role: "worker",
        status: "active",
        passwordHash: await bcrypt.hash(`Sim-${Date.now()}!A1`, 4),
        momoEnabled: true,
        locationId: location.id,
      },
    });
    await setWorkerSession(agent);

    // ---------- DAY 1: correctly managed ----------
    const dayOne = await createDailyAccount(location.id, "2026-11-02");
    expect(dayOne.success).toBe(true);
    const dayOneId = (dayOne.data as { id: string }).id;

    const dayOneSave = await saveDailyAccount(
      dayOneId,
      accountForm({
        openingMomoFloat: 1000,
        openingCash: 500,
        customerDeposit: 600,
        cashOut: 450,
        cashIn: 600,
        commission: 15,
        closingMomoFloat: 1150,
        closingCash: 665,
      })
    );
    expect(dayOneSave.success).toBe(true);
    const dayOneSubmit = await submitDailyAccount(dayOneId);
    expect(dayOneSubmit.success).toBe(true);

    const dayOneRow = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: dayOneId },
    });
    const dayOneResult = {
      businessDate: dayOneRow.businessDate.toISOString().slice(0, 10),
      openingMomoFloat: Number(dayOneRow.openingMomoFloat),
      openingCash: Number(dayOneRow.openingCash),
      customerDeposit: Number(dayOneRow.totalCashIn),
      cashOut: Number(dayOneRow.totalCashOut),
      cashIn: Number(dayOneRow.totalCashReceived),
      commission: Number(dayOneRow.commission),
      closingMomoFloat: Number(dayOneRow.closingMomoFloat),
      closingCash: Number(dayOneRow.closingCash),
      cashPaidOutStored: Number(dayOneRow.totalCashPaid),
      momoVariance: Number(dayOneRow.calculatedMomoVariance),
      cashVariance: Number(dayOneRow.calculatedCashVariance),
      status: dayOneRow.status,
    };
    expect(dayOneResult.momoVariance).toBe(0);
    expect(dayOneResult.cashVariance).toBe(0);
    expect(dayOneResult.cashPaidOutStored).toBe(0);

    // ---------- DAY 2: same agent, balances carried forward ----------
    const dayTwo = await createDailyAccount(location.id, "2026-11-03");
    expect(dayTwo.success).toBe(true);
    const dayTwoId = (dayTwo.data as { id: string }).id;

    // Correct float movement. Expected closing cash is 665 + 400 + 12 - 520 =
    // 557, but the agent counts only 512 in the drawer: GH₵45 is missing.
    const dayTwoSave = await saveDailyAccount(
      dayTwoId,
      accountForm({
        openingMomoFloat: dayOneResult.closingMomoFloat,
        openingCash: dayOneResult.closingCash,
        customerDeposit: 400,
        cashOut: 520,
        cashIn: 400,
        commission: 12,
        closingMomoFloat: 1030,
        closingCash: 512,
      })
    );
    expect(dayTwoSave.success).toBe(true);
    const dayTwoSubmit = await submitDailyAccount(dayTwoId);
    expect(dayTwoSubmit.success).toBe(true);

    const dayTwoRow = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: dayTwoId },
    });
    const dayTwoResult = {
      businessDate: dayTwoRow.businessDate.toISOString().slice(0, 10),
      openingMomoFloat: Number(dayTwoRow.openingMomoFloat),
      openingCash: Number(dayTwoRow.openingCash),
      customerDeposit: Number(dayTwoRow.totalCashIn),
      cashOut: Number(dayTwoRow.totalCashOut),
      cashIn: Number(dayTwoRow.totalCashReceived),
      commission: Number(dayTwoRow.commission),
      closingMomoFloat: Number(dayTwoRow.closingMomoFloat),
      closingCash: Number(dayTwoRow.closingCash),
      cashPaidOutStored: Number(dayTwoRow.totalCashPaid),
      momoVariance: Number(dayTwoRow.calculatedMomoVariance),
      cashVariance: Number(dayTwoRow.calculatedCashVariance),
      status: dayTwoRow.status,
    };

    expect(dayTwoResult.openingCash).toBe(dayOneResult.closingCash);
    expect(dayTwoResult.openingMomoFloat).toBe(dayOneResult.closingMomoFloat);
    expect(dayTwoResult.momoVariance).toBe(0);
    expect(dayTwoResult.cashVariance).toBe(-45);

    // Machine-readable evidence for the written investigation report.
    console.log(
      "MOMO_SIMULATION_RESULT " +
        JSON.stringify(
          { testIdentity: TEST_IDENTITY, dayOne: dayOneResult, dayTwo: dayTwoResult },
          null,
          2
        )
    );

    // ---------- CLEANUP ----------
    await prisma.expense.deleteMany({
      where: { dailyAccountId: { in: [dayOneId, dayTwoId] } },
    });
    await prisma.dailyAccountRevision.deleteMany({
      where: { dailyAccountId: { in: [dayOneId, dayTwoId] } },
    });
    await prisma.auditLog.deleteMany({ where: { userId: agent.id } });
    await prisma.dailyAccount.deleteMany({
      where: { id: { in: [dayOneId, dayTwoId] } },
    });
    await prisma.user.delete({ where: { id: agent.id } });
    await prisma.location.delete({ where: { id: location.id } });
    await prisma.businessTenant.delete({ where: { id: tenant.id } });

    expect(
      await prisma.dailyAccount.count({ where: { id: { in: [dayOneId, dayTwoId] } } })
    ).toBe(0);
    expect(await prisma.user.count({ where: { id: agent.id } })).toBe(0);
    expect(
      await prisma.businessTenant.count({ where: { name: TEST_IDENTITY } })
    ).toBe(0);
  });
});
