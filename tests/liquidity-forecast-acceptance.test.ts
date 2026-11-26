/**
 * Branch liquidity forecasting — local acceptance on a real database.
 *
 * The pure module is covered by `liquidity-forecast.test.ts`. This file proves the two
 * things that only a database run can prove: that the read action derives its history from
 * one branch's own recorded days, and that it writes nothing at all. No forecast may create
 * a transfer, reserve float, or alter a balance — an actual transfer must go through the
 * existing branch-transfer approval process, which this action cannot touch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdminMomo: async () => ctxHolder.current,
  requireTenantAdmin: async () => ctxHolder.current,
}));

import { getBranchLiquidityForecast } from "@/lib/actions/liquidity-forecast.actions";

/** Deterministic business days ending yesterday, so the target date is today. */
function daysAgo(count: number): Date[] {
  const out: Date[] = [];
  const today = new Date();
  for (let index = count; index >= 1; index -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - index));
    out.push(date);
  }
  return out;
}

describe("branch liquidity forecast — read-only acceptance", () => {
  let tenantId: string;
  let adminId: string;
  let subjectWorkerId: string;
  let locationId: string;
  let otherLocationId: string;

  async function seedDay(location: string, businessDate: Date, cashOut: number, cashIn: number) {
    await prisma.momoTransaction.create({
      data: {
        tenantId,
        locationId: location,
        workerId: subjectWorkerId,
        type: "cash_out",
        network: "mtn",
        direction: "outflow",
        amount: cashOut,
        businessDate,
        occurredAt: businessDate,
        reference: `FX-OUT-${businessDate.toISOString().slice(0, 10)}-${location.slice(-4)}`,
        idempotencyKey: `fx-out-${businessDate.toISOString().slice(0, 10)}-${location.slice(-4)}`,
        recordedById: subjectWorkerId,
      },
    });
    await prisma.momoTransaction.create({
      data: {
        tenantId,
        locationId: location,
        workerId: subjectWorkerId,
        type: "cash_in",
        network: "mtn",
        direction: "inflow",
        amount: cashIn,
        businessDate,
        occurredAt: businessDate,
        reference: `FX-IN-${businessDate.toISOString().slice(0, 10)}-${location.slice(-4)}`,
        idempotencyKey: `fx-in-${businessDate.toISOString().slice(0, 10)}-${location.slice(-4)}`,
        recordedById: subjectWorkerId,
      },
    });
  }

  beforeEach(async () => {
    await cleanDatabase();
    const tenant = await prisma.businessTenant.create({
      data: { code: `FX-${Math.random().toString(36).slice(2, 8)}`, name: "Forecast Tenant", status: "ACTIVE" },
    });
    tenantId = tenant.id;
    const admin = await prisma.user.create({
      data: {
        tenantId,
        email: `fx-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Forecast Owner",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    adminId = admin.id;
    const worker = await prisma.user.create({
      data: {
        tenantId,
        email: `fx-w-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Forecast Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
      },
    });
    subjectWorkerId = worker.id;
    const main = await prisma.location.create({
      data: { tenantId, name: "Main Branch", code: `M${Date.now() % 100000}` },
    });
    locationId = main.id;
    const other = await prisma.location.create({
      data: { tenantId, name: "Other Branch", code: `O${Date.now() % 100000}` },
    });
    otherLocationId = other.id;

    ctxHolder.current = { tenantId, userId: adminId, role: "admin", modules: ["admin"] };
  });

  it("forecasts from one branch's own days and writes nothing", async () => {
    for (const day of daysAgo(30)) {
      await seedDay(locationId, day, 2600, 2100);
    }
    // A second branch with much heavier days must not leak into this branch's forecast.
    for (const day of daysAgo(30)) {
      await seedDay(otherLocationId, day, 90000, 1000);
    }

    const before = {
      transfers: await prisma.branchTransfer.count({ where: { tenantId } }),
      balances: await prisma.branchAssetBalance.count({ where: { tenantId } }),
      snapshots: await prisma.branchLiquiditySnapshot.count({ where: { tenantId } }),
      transactions: await prisma.momoTransaction.count({ where: { tenantId } }),
      ledger: await prisma.auditLog.count({ where: { tenantId } }),
    };

    const result = await getBranchLiquidityForecast({ locationId });
    expect(result.success, result.success ? "" : result.error).toBe(true);
    if (!result.success) return;

    const { forecast, locationName, historyDays, empty } = result.data;
    expect(locationName).toBe("Main Branch");
    expect(empty).toBe(false);
    expect(historyDays).toBe(30);
    expect(forecast.sampleSize).toBe(30);

    // Around GH₵26 a day, not the other branch's GH₵900.
    expect(forecast.expectedOutflowMinor).toBeGreaterThan(250_000);
    expect(forecast.expectedOutflowMinor).toBeLessThan(280_000);
    expect(forecast.expectedInflowMinor).toBeGreaterThan(200_000);
    expect(forecast.expectedInflowMinor).toBeLessThan(230_000);
    expect(Number.isInteger(forecast.expectedOutflowMinor)).toBe(true);
    expect(Number.isInteger(forecast.suggestedOpeningFloatMinor)).toBe(true);

    // The suggestion is the upper band, and it is a suggestion.
    expect(forecast.suggestedOpeningFloatMinor).toBe(forecast.upperOutflowMinor);
    expect(forecast.suggestedOpeningFloatMinor).toBeGreaterThanOrEqual(forecast.expectedOutflowMinor);
    expect(forecast.autoTransfer).toBe(false);
    expect(forecast.requiresHumanAction).toBe(true);
    expect(forecast.explanation.length).toBeGreaterThan(3);

    const after = {
      transfers: await prisma.branchTransfer.count({ where: { tenantId } }),
      balances: await prisma.branchAssetBalance.count({ where: { tenantId } }),
      snapshots: await prisma.branchLiquiditySnapshot.count({ where: { tenantId } }),
      transactions: await prisma.momoTransaction.count({ where: { tenantId } }),
      ledger: await prisma.auditLog.count({ where: { tenantId } }),
    };
    expect(after).toEqual(before);
  });

  it("reports an empty branch honestly instead of inventing float", async () => {
    const result = await getBranchLiquidityForecast({ locationId });
    if (!result.success) throw new Error(result.error);
    expect(result.data.empty).toBe(true);
    expect(result.data.historyDays).toBe(0);
    expect(result.data.forecast.suggestedOpeningFloatMinor).toBe(0);
    expect(result.data.forecast.limitedHistory).toBe(true);
    expect(result.data.forecast.explanation.join(" ")).toMatch(/no usable history/i);
  });

  it("ignores a reversed day and a day older than the history window", async () => {
    for (const day of daysAgo(10)) {
      await seedDay(locationId, day, 2600, 2100);
    }
    const reversedDay = daysAgo(3)[0];
    await prisma.momoTransaction.updateMany({
      where: { tenantId, businessDate: reversedDay, type: "cash_out" },
      data: { status: "reversed" },
    });

    const result = await getBranchLiquidityForecast({ locationId, targetDate: "2099-01-01" });
    if (!result.success) throw new Error(result.error);
    // Ten cash-out days, one of them reversed, so nine carry outflow.
    expect(result.data.forecast.expectedOutflowMinor).toBe(260_000);
  });

  it("refuses another business's branch", async () => {
    const other = await prisma.businessTenant.create({
      data: { code: `FX2-${Math.random().toString(36).slice(2, 8)}`, name: "Other", status: "ACTIVE" },
    });
    const otherLocation = await prisma.location.create({
      data: { tenantId: other.id, name: "Foreign", code: `F${Date.now() % 100000}` },
    });
    const result = await getBranchLiquidityForecast({ locationId: otherLocation.id });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/branch not found/i);
  });
});
