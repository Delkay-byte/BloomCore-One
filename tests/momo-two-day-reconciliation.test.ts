/**
 * Two-day MoMo agent reconciliation simulation under the corrected
 * combined-accountability model.
 *
 * This is an ISOLATED SIMULATION, not production activity. It runs against the
 * dedicated SQLite test database, creates a clearly-labelled disposable tenant,
 * location and agent, and drives the REAL server actions
 * (createDailyAccount -> saveDailyAccount -> submitDailyAccount) exactly as the
 * application does. No staging or production database, customer, agent or
 * payment is touched.
 *
 * Day 1 is a correctly managed day. Deposits, cash out and airtime move money
 * between the two pockets; commission and expenses change accountability.
 *
 * Day 2 opens with Day 1's actual closing balances and deliberately introduces
 * one operational error: the agent records the correct movements but counts
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
import { parseReconciliationStatus } from "@/lib/momo-reconciliation";

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
  additionalCashReceived?: number;
  additionalMomoFloat?: number;
  customerDeposit: number;
  cashOut: number;
  airtimeSold?: number;
  commission: number;
  closingMomoFloat: number;
  closingCash: number;
  expenses?: Array<{ description: string; amount: number }>;
  note?: string;
}) {
  const formData = new FormData();
  formData.set("openingMomoFloat", String(values.openingMomoFloat));
  formData.set("openingCash", String(values.openingCash));
  formData.set(
    "additionalCashReceived",
    String(values.additionalCashReceived ?? 0)
  );
  formData.set("additionalMomoFloat", String(values.additionalMomoFloat ?? 0));
  formData.set("totalCashIn", String(values.customerDeposit));
  formData.set("totalCashOut", String(values.cashOut));
  formData.set("totalAirtimeSold", String(values.airtimeSold ?? 0));
  formData.set("commission", String(values.commission));
  formData.set("closingMomoFloat", String(values.closingMomoFloat));
  formData.set("closingCash", String(values.closingCash));
  if (values.note) formData.set("reconciliationNote", values.note);
  formData.set("expenses", JSON.stringify(values.expenses ?? []));
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
    // Opening 1000 float + 500 cash = 1500.
    // Deposits 600, cash out 450, airtime 100 move between pockets only.
    // Commission 15 raises accountability; expense 20 lowers it.
    // Expected = 1500 + 15 - 20 = 1495.
    // Closing float = 1000 - 600 + 450 - 100 + 15 = 765.
    // Closing cash  = 500 + 600 - 450 + 100 - 20 = 730.
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
        airtimeSold: 100,
        commission: 15,
        closingMomoFloat: 765,
        closingCash: 730,
        expenses: [{ description: "Test airtime float top-up", amount: 20 }],
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
      airtimeSold: Number(dayOneRow.totalAirtimeSold),
      commission: Number(dayOneRow.commission),
      totalExpenses: Number(dayOneRow.totalExpenses),
      closingMomoFloat: Number(dayOneRow.closingMomoFloat),
      closingCash: Number(dayOneRow.closingCash),
      cashPaidOutStored: Number(dayOneRow.totalCashPaid),
      cashInStored: Number(dayOneRow.totalCashReceived),
      difference: Number(dayOneRow.calculatedDifference),
      differenceStatus: dayOneRow.differenceStatus,
      status: dayOneRow.status,
    };
    expect(dayOneResult.difference).toBe(0);
    expect(parseReconciliationStatus(dayOneResult.differenceStatus).status).toBe("balanced");
    expect(dayOneResult.cashPaidOutStored).toBe(0);
    expect(dayOneResult.cashInStored).toBe(0);
    // Legacy variance columns still carry the combined difference for older
    // consumers: total = 0.
    expect(
      Number(dayOneRow.calculatedMomoVariance) +
        Number(dayOneRow.calculatedCashVariance)
    ).toBe(0);

    // ---------- DAY 2: same agent, balances carried forward ----------
    // Opening 765 float + 730 cash = 1495.
    // Deposits 400, cash out 520, commission 12 -> expected 1507.
    // Correct float = 765 - 400 + 520 + 12 = 897.
    // Correct cash  = 730 + 400 - 520 = 610.
    // Agent counts 565 cash, so 45 is missing.
    const dayTwo = await createDailyAccount(location.id, "2026-11-03");
    expect(dayTwo.success).toBe(true);
    const dayTwoId = (dayTwo.data as { id: string }).id;

    const dayTwoSave = await saveDailyAccount(
      dayTwoId,
      accountForm({
        openingMomoFloat: dayOneResult.closingMomoFloat,
        openingCash: dayOneResult.closingCash,
        customerDeposit: 400,
        cashOut: 520,
        airtimeSold: 0,
        commission: 12,
        closingMomoFloat: 897,
        closingCash: 565,
        note: "SIMULATION — GH₵45 missing from the cash drawer count.",
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
      airtimeSold: Number(dayTwoRow.totalAirtimeSold),
      commission: Number(dayTwoRow.commission),
      totalExpenses: Number(dayTwoRow.totalExpenses),
      closingMomoFloat: Number(dayTwoRow.closingMomoFloat),
      closingCash: Number(dayTwoRow.closingCash),
      difference: Number(dayTwoRow.calculatedDifference),
      differenceStatus: dayTwoRow.differenceStatus,
      reconciliationNote: dayTwoRow.reconciliationNote,
      status: dayTwoRow.status,
    };

    expect(dayTwoResult.openingCash).toBe(dayOneResult.closingCash);
    expect(dayTwoResult.openingMomoFloat).toBe(dayOneResult.closingMomoFloat);
    expect(dayTwoResult.difference).toBe(-33);
    expect(parseReconciliationStatus(dayTwoResult.differenceStatus).status).toBe("shortage");
    expect(dayTwoResult.reconciliationNote).toContain("GH₵45");

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

  it("blocks submission of a shortage without an explanation", async () => {
    const tenant = await prisma.businessTenant.create({
      data: {
        code: `SIM-BLOCK-${Date.now().toString(36).toUpperCase()}`,
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
        name: `${TEST_IDENTITY} — BLOCK SHOP`,
        code: "SIM-002",
        status: "active",
      },
    });
    const agent = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `sim-momo-block-${Date.now()}@test.invalid`,
        fullName: "TEST — MOMO AGENT — BLOCK CASE",
        role: "worker",
        status: "active",
        passwordHash: await bcrypt.hash(`Sim-${Date.now()}!A1`, 4),
        momoEnabled: true,
        locationId: location.id,
      },
    });
    await setWorkerSession(agent);

    const day = await createDailyAccount(location.id, "2026-11-04");
    const id = (day.data as { id: string }).id;
    const saved = await saveDailyAccount(
      id,
      accountForm({
        openingMomoFloat: 0,
        openingCash: 100,
        customerDeposit: 0,
        cashOut: 0,
        airtimeSold: 0,
        commission: 0,
        closingMomoFloat: 0,
        closingCash: 50,
      })
    );
    expect(saved.success).toBe(true);

    const blocked = await submitDailyAccount(id);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/shortage/i);

    const stillDraft = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id },
    });
    expect(stillDraft.status).toBe("draft");
    expect(Number(stillDraft.closingCash)).toBe(50);

    await prisma.auditLog.deleteMany({ where: { userId: agent.id } });
    await prisma.dailyAccount.delete({ where: { id } });
    await prisma.user.delete({ where: { id: agent.id } });
    await prisma.location.delete({ where: { id: location.id } });
    await prisma.businessTenant.delete({ where: { id: tenant.id } });
  });
});
