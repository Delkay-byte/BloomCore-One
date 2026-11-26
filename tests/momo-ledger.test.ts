/**
 * MoMo operational transaction ledger — Priority 1 acceptance tests.
 *
 * These exercise the real server actions and the real SQLite test database.
 * The only mocked layers are next/headers (cookie jar), next/navigation
 * (redirect) and next/cache (revalidation).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
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

import {
  createDailyAccount,
  saveDailyAccount,
  submitDailyAccount,
  reviewDailyAccount,
} from "@/lib/actions/daily-account.actions";
import {
  enableLedgerMode,
  recordMomoTransaction,
  reverseMomoTransaction,
  correctMomoTransaction,
  getAccountLedgerView,
  getAdminLedgerView,
  exportLedgerCsv,
  applyOpeningCarryForward,
} from "@/lib/actions/momo-ledger.actions";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import { calculateReconciliation, encodeReconciliationStatus } from "@/lib/momo-reconciliation";
import {
  decideOpeningCarryForward,
  projectLedgerPosition,
  summariseLedger,
} from "@/lib/momo-ledger";

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

async function fixture(options: { code?: string; locationCode?: string } = {}) {
  const tenant = await createTestTenant({ momo: true, susu: false });
  const location = await prisma.location.create({
    data: {
      tenantId: tenant.id,
      name: "Ledger Shop",
      code: options.locationCode ?? "LED-1",
    },
  });
  const worker = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `ledger-worker-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`,
      fullName: "Ledger Worker",
      role: "worker",
      status: "active",
      passwordHash: await bcrypt.hash("Test1234!", 4),
      momoEnabled: true,
      locationId: location.id,
    },
  });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
  return { tenant, location, worker, admin };
}

function entry(
  overrides: Partial<{
    type: string;
    network: string;
    amount: number;
    commissionAmount: number;
    occurredAt: string;
    reference: string;
    externalReference: string | null;
    note: string;
    supportingEvidence: string;
    idempotencyKey: string;
  }> = {}
) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    type: "cash_in",
    network: "mtn",
    amount: 100,
    commissionAmount: 0,
    occurredAt: "2026-11-24T09:00:00.000Z",
    reference: `REF-${unique}`,
    externalReference: null as string | null,
    note: "Synthetic test entry",
    idempotencyKey: `idem-${unique}`,
    ...overrides,
  };
}

function dailyForm(values: Record<string, string>) {
  const form = new FormData();
  const base: Record<string, string> = {
    openingMomoFloat: "500",
    openingCash: "1000",
    commission: "0",
    debtsCollected: "0",
    totalAirtimeSold: "0",
    closingMomoFloat: "0",
    closingCash: "1500",
    reconciliationNote: "",
    expenses: "[]",
    ...values,
  };
  for (const [key, value] of Object.entries(base)) form.set(key, value);
  return form;
}

async function ledgerAccount(workerId: string, locationId: string, date: string) {
  await setSession("momo", { id: workerId, email: "worker@test.invalid" });
  const created = await createDailyAccount(locationId, date);
  expect(created.success).toBe(true);
  const accountId = (created.data as { id: string }).id;
  const enabled = await enableLedgerMode(accountId);
  expect(enabled.success).toBe(true);
  return accountId;
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

// ---------------------------------------------------------------------------
// Pure domain rules
// ---------------------------------------------------------------------------

describe("ledger totals", () => {
  it("never counts customer principal as revenue or profit", () => {
    const summary = summariseLedger([
      { type: "cash_in", amount: 5000, status: "recorded" },
      { type: "cash_out", amount: 3000, status: "recorded" },
      { type: "airtime_sale", amount: 200, status: "recorded" },
    ]);
    expect(summary.cashIn).toBe(5000);
    expect(summary.cashOut).toBe(3000);
    expect(summary.airtimeSold).toBe(200);
    expect(summary.netIncrease).toBe(0);
    expect(summary.commission).toBe(0);
    // Principal moves between pockets but leaves the combined total intact.
    expect(summary.cashMovement + summary.floatMovement).toBe(0);
  });

  it("counts commission, debts and expenses once and separates them", () => {
    const summary = summariseLedger([
      { type: "commission", amount: 40, status: "recorded" },
      { type: "debts_collected", amount: 25, status: "recorded" },
      { type: "other_income", amount: 5, status: "recorded" },
      { type: "expense", amount: 12, status: "recorded" },
    ]);
    expect(summary.commission).toBe(40);
    expect(summary.commissionBasis).toBe("day_total");
    expect(summary.debtsCollected).toBe(25);
    expect(summary.otherIncome).toBe(5);
    expect(summary.expenses).toBe(12);
    expect(summary.netIncrease).toBe(58);
  });

  it("uses one commission source and never adds day totals to per-transaction amounts", () => {
    const summary = summariseLedger([
      { type: "cash_in", amount: 100, commissionAmount: 3, status: "recorded" },
      { type: "cash_out", amount: 50, commissionAmount: 2, status: "recorded" },
    ]);
    expect(summary.commissionBasis).toBe("per_transaction");
    expect(summary.commission).toBe(5);

    const withDayTotal = summariseLedger([
      { type: "cash_in", amount: 100, commissionAmount: 3, status: "recorded" },
      { type: "commission", amount: 20, status: "recorded" },
    ]);
    expect(withDayTotal.commissionBasis).toBe("day_total");
    expect(withDayTotal.commission).toBe(20);
  });

  it("excludes reversed, corrected and reversal rows from effective totals", () => {
    const summary = summariseLedger([
      { type: "cash_in", amount: 100, status: "reversed" },
      { type: "cash_in", amount: 100, status: "reversal" },
      { type: "commission", amount: 10, status: "corrected" },
      { type: "commission", amount: 12, status: "recorded" },
    ]);
    expect(summary.principalTotal).toBe(0);
    expect(summary.commission).toBe(12);
  });

  it("projects each pocket from opening balances", () => {
    const summary = summariseLedger([
      { type: "cash_in", amount: 100, status: "recorded" },
      { type: "expense", amount: 10, status: "recorded" },
    ]);
    const projection = projectLedgerPosition(summary, {
      openingCash: 500,
      openingFloat: 300,
    });
    expect(projection.projectedCash).toBe(590);
    expect(projection.projectedFloat).toBe(200);
    expect(projection.expectedClosing).toBe(790);
  });

  it("does not carry forward an unreviewed or unresolved prior close", () => {
    const prior = {
      id: "a1",
      businessDate: new Date("2026-11-23T00:00:00.000Z"),
      status: "submitted",
      closingCash: 100,
      closingMomoFloat: 50,
    };
    expect(
      decideOpeningCarryForward(prior, { status: "balanced" }).reason
    ).toBe("prior_unapproved");
    expect(
      decideOpeningCarryForward({ ...prior, status: "reviewed" }, { status: "shortage" })
        .reason
    ).toBe("prior_unresolved");
    const carried = decideOpeningCarryForward(
      { ...prior, status: "reviewed" },
      { status: "balanced" }
    );
    expect(carried.available).toBe(true);
    expect(carried.openingCash).toBe(100);
    expect(carried.openingMomoFloat).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Recording, tenant isolation and idempotency
// ---------------------------------------------------------------------------

describe("transaction recording", () => {
  it("records a transaction with location, worker, direction and audit history", async () => {
    const { tenant, location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");

    const result = await recordMomoTransaction(
      accountId,
      entry({ type: "cash_in", amount: 250, network: "mtn" })
    );
    expect(result.success).toBe(true);

    const row = await prisma.momoTransaction.findFirst({
      where: { tenantId: tenant.id, dailyAccountId: accountId },
    });
    expect(row).not.toBeNull();
    expect(Number(row!.amount)).toBe(250);
    expect(row!.direction).toBe("neutral");
    expect(row!.recordingSource).toBe("manual_operator");
    expect(row!.workerId).toBe(worker.id);
    expect(row!.locationId).toBe(location.id);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, action: "momo.transaction_recorded" },
    });
    expect(audit).not.toBeNull();
  });

  it("records manual entries as operator-recorded and never provider-confirmed", async () => {
    const { tenant, location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");

    const result = await recordMomoTransaction(accountId, {
      ...entry({
        type: "cash_out",
        amount: 120,
        externalReference: "PROV-REF-1",
        supportingEvidence: "Receipt R-1042 held at the branch",
      }),
      // A client must not be able to promote its own entry.
      verificationStatus: "provider_confirmed",
    } as never);
    expect(result.success).toBe(true);

    const row = await prisma.momoTransaction.findFirstOrThrow({
      where: { tenantId: tenant.id, dailyAccountId: accountId },
    });
    expect(row.verificationStatus).toBe("operator_recorded");
    expect(row.recordingSource).toBe("manual_operator");
    expect(row.supportingEvidence).toBe("Receipt R-1042 held at the branch");
    expect(row.recordedDeviceId).toBeNull();
  });

  it("exposes cash and float effects without counting principal as income", async () => {
    const { location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");

    await recordMomoTransaction(
      accountId,
      entry({ type: "cash_in", network: "mtn", amount: 300 })
    );
    await recordMomoTransaction(
      accountId,
      entry({
        type: "cash_out",
        network: "mtn",
        amount: 100,
        commissionAmount: 2,
        reference: "MM-OUT-1",
      })
    );

    const view = await getAccountLedgerView(accountId);
    const cashIn = view!.entries.find((item) => item.type === "cash_in");
    const cashOut = view!.entries.find((item) => item.type === "cash_out");
    expect(cashIn).toMatchObject({
      cashEffect: 300,
      floatEffect: -300,
      verificationStatus: "operator_recorded",
      verificationLabel: "Operator-recorded",
    });
    expect(cashOut).toMatchObject({ cashEffect: -100, floatEffect: 100 });
    expect(cashOut!.commissionAmount).toBe(2);

    // A reversal row carries the opposite effect, so the pair nets to zero.
    const reversed = await reverseMomoTransaction({
      transactionId: cashIn!.id,
      reason: "Synthetic reversal for the effect check",
    });
    expect(reversed.success).toBe(true);
    const after = await getAccountLedgerView(accountId);
    const reversal = after!.entries.find((item) => item.direction === "reversal");
    expect(reversal).toMatchObject({
      cashEffect: -300,
      floatEffect: 300,
      verificationStatus: "operator_recorded",
    });
  });

  it("rejects a location the worker is not assigned to", async () => {
    const { tenant, location, worker } = await fixture();
    const otherLocation = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Other", code: "LED-2" },
    });
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");

    // Move the worker to the other location after the account exists.
    await prisma.user.update({
      where: { id: worker.id },
      data: { locationId: otherLocation.id },
    });
    await setSession("momo", { id: worker.id, email: worker.email });

    const result = await recordMomoTransaction(accountId, entry());
    expect(result.success).toBe(false);
    expect(result.error).toContain("access");
  });

  it("isolates tenants for recording and reading", async () => {
    const first = await fixture({ locationCode: "LED-A" });
    const second = await fixture({ locationCode: "LED-B" });
    const accountId = await ledgerAccount(
      first.worker.id,
      first.location.id,
      "2026-11-24"
    );

    await setSession("momo", { id: second.worker.id, email: second.worker.email });
    const deniedRecord = await recordMomoTransaction(accountId, entry());
    expect(deniedRecord.success).toBe(false);
    expect(await getAccountLedgerView(accountId)).toBeNull();

    await setSession("momo", { id: first.worker.id, email: first.worker.email });
    expect(await recordMomoTransaction(accountId, entry())).toMatchObject({
      success: true,
    });
  });

  it("is idempotent for a repeated submission key and under concurrency", async () => {
    const { tenant, location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");
    const payload = entry({ amount: 75 });

    const first = await recordMomoTransaction(accountId, payload);
    const replay = await recordMomoTransaction(accountId, payload);
    expect(first.success).toBe(true);
    expect(replay.success).toBe(true);
    expect((replay.data as { duplicate?: boolean }).duplicate).toBe(true);
    expect(await prisma.momoTransaction.count({ where: { tenantId: tenant.id } })).toBe(1);

    const concurrent = await Promise.all([
      recordMomoTransaction(accountId, entry({ idempotencyKey: "same-key-concurrent" })),
      recordMomoTransaction(accountId, entry({ idempotencyKey: "same-key-concurrent" })),
    ]);
    expect(concurrent.filter((result) => result.success).length).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.momoTransaction.count({
        where: { tenantId: tenant.id, idempotencyKey: "same-key-concurrent" },
      })
    ).toBe(1);
  });

  it("rejects a duplicate business or provider reference", async () => {
    const { location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");
    const payload = entry({ reference: "MM-UNIQUE-1", externalReference: "PROV-1" });
    expect((await recordMomoTransaction(accountId, payload)).success).toBe(true);

    const duplicateBusiness = await recordMomoTransaction(accountId, {
      ...payload,
      idempotencyKey: "different-key",
    });
    expect(duplicateBusiness.success).toBe(false);
    expect(duplicateBusiness.error).toContain("reference");

    const duplicateProvider = await recordMomoTransaction(accountId, {
      ...payload,
      reference: "MM-UNIQUE-2",
      idempotencyKey: "different-key-2",
    });
    expect(duplicateProvider.success).toBe(false);
    expect(duplicateProvider.error).toContain("provider reference");
  });

  it("refuses to record on an aggregate day or another worker's account", async () => {
    const { location, worker } = await fixture();
    await setSession("momo", { id: worker.id, email: worker.email });
    const created = await createDailyAccount(location.id, "2026-11-24");
    const aggregateId = (created.data as { id: string }).id;

    const refused = await recordMomoTransaction(aggregateId, entry());
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("transaction ledger");

    // An aggregate day with manual figures cannot be switched silently.
    const saved = await saveDailyAccount(
      aggregateId,
      dailyForm({ commission: "25", closingCash: "1525" })
    );
    expect(saved.success).toBe(true);
    const enable = await enableLedgerMode(aggregateId);
    expect(enable.success).toBe(false);
    const untouched = await prisma.dailyAccount.findUnique({ where: { id: aggregateId } });
    expect(Number(untouched!.commission)).toBe(25);
    expect(untouched!.ledgerMode).toBe("aggregate");
  });
});

// ---------------------------------------------------------------------------
// Daily close integration and double-count prevention
// ---------------------------------------------------------------------------

describe("daily close integration", () => {
  it("derives commission, debts, expenses and airtime from the ledger and ignores manual duplicates", async () => {
    const { location, worker, admin } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");

    expect(
      (
        await recordMomoTransaction(
          accountId,
          entry({ type: "cash_in", amount: 500, reference: "MM-CI-1" })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await recordMomoTransaction(
          accountId,
          entry({ type: "commission", amount: 20, reference: "MM-COM-1" })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await recordMomoTransaction(
          accountId,
          entry({ type: "debts_collected", amount: 10, reference: "MM-DEBT-1" })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await recordMomoTransaction(
          accountId,
          entry({ type: "expense", amount: 5, reference: "MM-EXP-1" })
        )
      ).success
    ).toBe(true);

    // The form deliberately posts conflicting manual figures. They must be
    // ignored: opening 1500 + 20 + 10 - 5 = expected 1525.
    const saved = await saveDailyAccount(
      accountId,
      dailyForm({
        commission: "9999",
        debtsCollected: "9999",
        totalAirtimeSold: "9999",
        expenses: JSON.stringify([{ description: "Duplicate", amount: "9999" }]),
        closingCash: "1505",
        closingMomoFloat: "0",
        // Money from the cash-in principal is in the pocket projection but not
        // in accountability, so the counted close is 1505.
      })
    );
    expect(saved.success).toBe(true);

    const account = await prisma.dailyAccount.findUnique({ where: { id: accountId } });
    expect(Number(account!.commission)).toBe(20);
    expect(Number(account!.debtsCollected)).toBe(10);
    expect(Number(account!.totalExpenses)).toBe(5);
    expect(Number(account!.totalAirtimeSold)).toBe(0);
    expect(Number(account!.calculatedDifference)).toBe(0);
    expect(account!.differenceStatus).toContain("balanced");
    expect(await prisma.expense.count({ where: { dailyAccountId: accountId } })).toBe(0);

    const submitted = await submitDailyAccount(accountId);
    expect(submitted.success).toBe(true);
    const closed = await prisma.dailyAccount.findUnique({ where: { id: accountId } });
    expect(closed!.status).toBe("submitted");
    expect(Number(closed!.commission)).toBe(20);

    await setSession("admin", { id: admin.id, email: admin.email });
    expect((await reviewDailyAccount(accountId)).success).toBe(true);
  });

  it("records a shortage only against the derived totals and preserves the note", async () => {
    const { location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");
    await recordMomoTransaction(
      accountId,
      entry({ type: "commission", amount: 50, reference: "MM-COM-SHORT" })
    );
    const saved = await saveDailyAccount(
      accountId,
      dailyForm({ closingCash: "1400", closingMomoFloat: "0", reconciliationNote: "" })
    );
    expect(saved.success).toBe(true);

    const blocked = await submitDailyAccount(accountId);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain("shortage");

    const withNote = await saveDailyAccount(
      accountId,
      dailyForm({
        closingCash: "1400",
        closingMomoFloat: "0",
        reconciliationNote: "Unrecorded cash removal under investigation.",
      })
    );
    expect(withNote.success).toBe(true);
    expect((await submitDailyAccount(accountId)).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Opening roll-forward
// ---------------------------------------------------------------------------

describe("opening-balance roll-forward", () => {
  async function priorAccount(
    tenantId: string,
    locationId: string,
    workerId: string,
    date: string,
    options: { status: string; cash: number; float: number; difference: number }
  ) {
    return prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId,
        workerId,
        businessDate: new Date(`${date}T00:00:00.000Z`),
        status: options.status,
        openingCash: 0,
        openingMomoFloat: 0,
        closingCash: options.cash,
        closingMomoFloat: options.float,
        calculatedDifference: options.difference,
        differenceStatus: encodeReconciliationStatus(
          options.difference === 0 ? "balanced" : "shortage"
        ),
      },
    });
  }

  it("carries a reviewed, balanced close into the next opening", async () => {
    const { tenant, location, worker } = await fixture();
    const prior = await priorAccount(tenant.id, location.id, worker.id, "2026-11-23", {
      status: "reviewed",
      cash: 1200,
      float: 300,
      difference: 0,
    });

    await setSession("momo", { id: worker.id, email: worker.email });
    const created = await createDailyAccount(location.id, "2026-11-24");
    expect(created.success).toBe(true);
    const account = created.data as {
      id: string;
      openingCash: unknown;
      openingMomoFloat: unknown;
      openingBalanceSource: string;
      carriedFromAccountId: string | null;
    };
    expect(Number(account.openingCash)).toBe(1200);
    expect(Number(account.openingMomoFloat)).toBe(300);
    expect(account.openingBalanceSource).toBe("carried");
    expect(account.carriedFromAccountId).toBe(prior.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "daily_account.created", entityId: account.id },
    });
    expect(audit?.details).toContain("carried");
  });

  it("does not carry an unreviewed or unresolved close", async () => {
    const { tenant, location, worker } = await fixture();
    await priorAccount(tenant.id, location.id, worker.id, "2026-11-22", {
      status: "submitted",
      cash: 900,
      float: 100,
      difference: 0,
    });
    await setSession("momo", { id: worker.id, email: worker.email });
    const created = await createDailyAccount(location.id, "2026-11-23");
    const account = created.data as {
      openingCash: unknown;
      openingMomoFloat: unknown;
      openingBalanceSource: string;
    };
    expect(Number(account.openingCash)).toBe(0);
    expect(Number(account.openingMomoFloat)).toBe(0);
    expect(account.openingBalanceSource).toBe("manual");

    await priorAccount(tenant.id, location.id, worker.id, "2026-11-24", {
      status: "reviewed",
      cash: 800,
      float: 100,
      difference: -50,
    });
    const next = await createDailyAccount(location.id, "2026-11-25");
    const unresolved = next.data as { openingCash: unknown; openingBalanceSource: string };
    expect(Number(unresolved.openingCash)).toBe(0);
    expect(unresolved.openingBalanceSource).toBe("manual");
  });

  it("requires an explanation for a material manual opening difference", async () => {
    const { tenant, location, worker } = await fixture();
    await priorAccount(tenant.id, location.id, worker.id, "2026-11-23", {
      status: "reviewed",
      cash: 1000,
      float: 200,
      difference: 0,
    });
    await setSession("momo", { id: worker.id, email: worker.email });
    const created = await createDailyAccount(location.id, "2026-11-24");
    const accountId = (created.data as { id: string }).id;

    const unexplained = await saveDailyAccount(
      accountId,
      dailyForm({ openingCash: "1050", openingMomoFloat: "200" })
    );
    expect(unexplained.success).toBe(false);
    expect(unexplained.error).toContain("Explain");

    const explained = await saveDailyAccount(
      accountId,
      dailyForm({
        openingCash: "1050",
        openingMomoFloat: "200",
        openingAdjustmentReason: "Owner added GH₵50 working cash this morning.",
      })
    );
    expect(explained.success).toBe(true);
    const row = await prisma.dailyAccount.findUnique({ where: { id: accountId } });
    expect(row!.openingBalanceSource).toBe("manual_adjusted");
    expect(row!.openingAdjustmentReason).toContain("Owner added");

    // A second unapproved account cannot inherit the unresolved figure.
    const applied = await applyOpeningCarryForward(accountId);
    expect(applied.success).toBe(false);
  });

  it("preserves historical aggregate rows exactly", async () => {
    const { tenant, location, worker } = await fixture();
    const historical = await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date("2026-06-01T00:00:00.000Z"),
        status: "reviewed",
        openingCash: 400,
        openingMomoFloat: 600,
        commission: 33,
        debtsCollected: 11,
        totalExpenses: 7,
        totalCashIn: 4500,
        totalCashOut: 4200,
        closingCash: 500,
        closingMomoFloat: 537,
        calculatedDifference: 0,
        differenceStatus: encodeReconciliationStatus("balanced"),
      },
    });
    await setSession("momo", { id: worker.id, email: worker.email });
    await createDailyAccount(location.id, "2026-06-02");

    const unchanged = await prisma.dailyAccount.findUnique({ where: { id: historical.id } });
    expect(Number(unchanged!.totalCashIn)).toBe(4500);
    expect(Number(unchanged!.totalCashOut)).toBe(4200);
    expect(Number(unchanged!.commission)).toBe(33);
    expect(unchanged!.ledgerMode).toBe("aggregate");
    expect(await prisma.momoTransaction.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reversal and correction history
// ---------------------------------------------------------------------------

describe("reversal and correction", () => {
  it("reverses a transaction without deleting the original posting", async () => {
    const { tenant, location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");
    const recorded = await recordMomoTransaction(
      accountId,
      entry({ type: "commission", amount: 30, reference: "MM-REV-1" })
    );
    const transactionId = (recorded.data as { entry: { id: string } }).entry.id;

    await setSession("momo", { id: worker.id, email: worker.email });
    const reversed = await reverseMomoTransaction({
      transactionId,
      reason: "Commission was recorded twice by mistake.",
    });
    expect(reversed.success).toBe(true);

    const original = await prisma.momoTransaction.findUnique({ where: { id: transactionId } });
    expect(original!.status).toBe("reversed");
    expect(Number(original!.amount)).toBe(30);
    const all = await prisma.momoTransaction.findMany({ where: { tenantId: tenant.id } });
    expect(all).toHaveLength(2);
    expect(all.some((row) => row.status === "reversal")).toBe(true);

    const view = await getAccountLedgerView(accountId);
    expect(view!.summary.commission).toBe(0);

    // A retry is idempotent.
    const retry = await reverseMomoTransaction({
      transactionId,
      reason: "Commission was recorded twice by mistake.",
    });
    expect(retry.success).toBe(true);
    expect((retry.data as { duplicate?: boolean }).duplicate).toBe(true);
  });

  it("appends a correction successor and counts only the successor", async () => {
    const { tenant, location, worker } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");
    const recorded = await recordMomoTransaction(
      accountId,
      entry({ type: "cash_in", amount: 500, reference: "MM-COR-1" })
    );
    const transactionId = (recorded.data as { entry: { id: string } }).entry.id;

    await setSession("momo", { id: worker.id, email: worker.email });
    const corrected = await correctMomoTransaction({
      transactionId,
      amount: 450,
      commissionAmount: 0,
      network: "mtn",
      occurredAt: "2026-11-24T11:00:00.000Z",
      reference: "MM-COR-1-C",
      externalReference: null,
      note: "Corrected from 500 to 450 after receipt check.",
      reason: "Receipt shows GH₵450, not GH₵500.",
      idempotencyKey: "correction-1",
    });
    expect(corrected.success).toBe(true);

    const original = await prisma.momoTransaction.findUnique({ where: { id: transactionId } });
    expect(original!.status).toBe("corrected");
    expect(Number(original!.amount)).toBe(500);

    const successor = await prisma.momoTransaction.findFirst({
      where: { tenantId: tenant.id, correctsTransactionId: transactionId },
    });
    expect(successor).not.toBeNull();
    expect(Number(successor!.amount)).toBe(450);

    const view = await getAccountLedgerView(accountId);
    expect(view!.summary.cashIn).toBe(450);
    expect(view!.summary.principalCount).toBe(1);
    expect(view!.entries).toHaveLength(2);

    const retry = await correctMomoTransaction({
      transactionId,
      amount: 450,
      commissionAmount: 0,
      network: "mtn",
      occurredAt: "2026-11-24T11:00:00.000Z",
      reference: "MM-COR-1-C",
      externalReference: null,
      note: "Corrected from 500 to 450 after receipt check.",
      reason: "Receipt shows GH₵450, not GH₵500.",
      idempotencyKey: "correction-1",
    });
    expect(retry.success).toBe(true);
    expect((retry.data as { duplicate?: boolean }).duplicate).toBe(true);
  });

  it("requires step-up for an administrator correction after submission", async () => {
    const { tenant, location, worker, admin } = await fixture();
    const accountId = await ledgerAccount(worker.id, location.id, "2026-11-24");
    const recorded = await recordMomoTransaction(
      accountId,
      entry({ type: "commission", amount: 15, reference: "MM-STEP-1" })
    );
    const transactionId = (recorded.data as { entry: { id: string } }).entry.id;
    await saveDailyAccount(
      accountId,
      dailyForm({ closingCash: "1515", closingMomoFloat: "500" })
    );
    expect((await submitDailyAccount(accountId)).success).toBe(true);

    await setSession("admin", { id: admin.id, email: admin.email });
    const denied = await reverseMomoTransaction({
      transactionId,
      reason: "Commission belongs to a different day.",
    });
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("Reauthentication");

    const grant = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "finance.momo_transaction.reverse",
      targetType: "momoTransaction",
      targetId: transactionId,
      context: { amountMinor: 1500 },
    });
    expect(grant.success).toBe(true);
    const token = (grant.data as { stepUpToken: string }).stepUpToken;

    const reversed = await reverseMomoTransaction({
      transactionId,
      reason: "Commission belongs to a different day.",
      stepUpToken: token,
    });
    expect(reversed.success).toBe(true);
    const original = await prisma.momoTransaction.findUnique({ where: { id: transactionId } });
    expect(original!.status).toBe("reversed");
    expect(
      await prisma.auditLog.count({
        where: { tenantId: tenant.id, action: "momo.transaction_reversed" },
      })
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reporting and export
// ---------------------------------------------------------------------------

describe("ledger reporting", () => {
  it("filters within one tenant and exports a safe CSV", async () => {
    const first = await fixture({ locationCode: "LED-X" });
    const second = await fixture({ locationCode: "LED-Y" });
    const accountId = await ledgerAccount(
      first.worker.id,
      first.location.id,
      "2026-11-24"
    );
    const recorded = await recordMomoTransaction(
      accountId,
      entry({ type: "cash_out", amount: 120, externalReference: "=FORMULA-1" })
    );
    expect(recorded.success).toBe(true);

    await setSession("admin", { id: first.admin.id, email: first.admin.email });
    const view = await getAdminLedgerView({ locationId: first.location.id });
    expect(view.total).toBe(1);
    expect(view.entries[0].locationName).toBe("Ledger Shop");
    expect(view.summary.cashOut).toBe(120);

    const csv = await exportLedgerCsv({});
    expect(csv.csv).toContain("Business date");
    expect(csv.csv).toContain("Ledger Shop");
    expect(csv.csv).toContain("Cash effect (GHS)");
    expect(csv.csv).toContain("Verification");
    expect(csv.csv).toContain("operator_recorded");
    // The formula-leading reference is neutralised.
    expect(csv.csv).toContain("\"'=FORMULA-1\"");
    expect(csv.csv).not.toContain(second.tenant.code);
  });

  it("keeps aggregate reconciliation unchanged when other income is absent", () => {
    const without = calculateReconciliation({
      openingCash: 100,
      openingMomoFloat: 0,
      commission: 10,
      totalExpenses: 5,
      closingCash: 105,
      closingMomoFloat: 0,
    });
    const withZero = calculateReconciliation({
      openingCash: 100,
      openingMomoFloat: 0,
      commission: 10,
      otherIncome: 0,
      totalExpenses: 5,
      closingCash: 105,
      closingMomoFloat: 0,
    });
    expect(withZero).toEqual(without);
    expect(withZero.otherIncome).toBe(0);
  });
});
