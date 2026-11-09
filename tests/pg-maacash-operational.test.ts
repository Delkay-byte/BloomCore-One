/**
 * PostgreSQL coverage for the Airtime Sold operational field and the separate
 * physical-handover record. These tests prove the migration columns exist and
 * preserve decimal values, including negative discrepancies.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./pg-setup";
import { calculateReconciliation } from "@/lib/momo-reconciliation";

async function fixture() {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PG-OPS-${Date.now()}`,
      name: "PG Operational Tenant",
      status: "ACTIVE",
      momoEnabled: true,
      susuEnabled: false,
      onboardingStatus: "COMPLETED",
    },
  });
  const location = await prisma.location.create({
    data: { tenantId: tenant.id, name: "PG Airtime Shop", code: "PG-AIR" },
  });
  const worker = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pg-airtime-${Date.now()}@test.invalid`,
      fullName: "PG Airtime Agent",
      role: "worker",
      status: "active",
      passwordHash: "not-used",
      momoEnabled: true,
      locationId: location.id,
    },
  });
  return { tenant, location, worker };
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("PostgreSQL: Airtime Sold and handover", () => {
  it("stores airtime and handover values without changing the reconciliation formula", async () => {
    const { tenant, location, worker } = await fixture();
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date("2026-11-09T00:00:00.000Z"),
        openingCash: 500,
        openingMomoFloat: 1000,
        closingCash: 600,
        closingMomoFloat: 900,
        totalAirtimeSold: 100,
        commission: 20,
        debtsCollected: 50,
        totalExpenses: 30,
        calculatedDifference: 0,
        differenceStatus: "balanced|net-v2",
        status: "submitted",
        actualAmountReceived: 1040,
        handoverDifference: 0,
        handoverNote: "Counted with the agent present.",
        handoverConfirmedAt: new Date("2026-11-09T18:00:00.000Z"),
        handoverConfirmedBy: worker.id,
      },
    });

    const stored = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(Number(stored.totalAirtimeSold)).toBe(100);
    expect(Number(stored.actualAmountReceived)).toBe(1040);
    expect(Number(stored.handoverDifference)).toBe(0);
    expect(stored.handoverNote).toContain("agent present");
    expect(stored.handoverConfirmedAt).not.toBeNull();

    const result = calculateReconciliation({
      openingCash: Number(stored.openingCash),
      openingMomoFloat: Number(stored.openingMomoFloat),
      closingCash: Number(stored.closingCash),
      closingMomoFloat: Number(stored.closingMomoFloat),
      commission: Number(stored.commission),
      debtsCollected: Number(stored.debtsCollected),
      totalExpenses: Number(stored.totalExpenses),
    });
    // Opening 1500 + commission 20 + debts 50 - expenses 30 = 1540.
    expect(result.expectedClosing).toBe(1540);
    expect(result.actualClosing).toBe(1500);
    expect(result.difference).toBe(0);
    expect(result.netIncrease).toBe(40);
  });

  it("preserves airtime when another field is corrected", async () => {
    const { tenant, location, worker } = await fixture();
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date("2026-11-10T00:00:00.000Z"),
        totalAirtimeSold: 75,
        status: "reviewed",
      },
    });

    await prisma.dailyAccount.update({
      where: { id: account.id },
      data: { totalExpenses: 12, correctionReason: "Corrected expense" },
    });

    const stored = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(Number(stored.totalAirtimeSold)).toBe(75);
    expect(Number(stored.totalExpenses)).toBe(12);
  });

  it("stores a negative handover discrepancy exactly", async () => {
    const { tenant, location, worker } = await fixture();
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date("2026-11-11T00:00:00.000Z"),
        status: "submitted",
        actualAmountReceived: 1480,
        handoverDifference: -20.5,
        handoverNote: "Short by GH₵20.50; investigation opened.",
      },
    });
    const stored = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(Number(stored.handoverDifference)).toBe(-20.5);
    expect(stored.handoverNote).toContain("investigation opened");
  });
});
