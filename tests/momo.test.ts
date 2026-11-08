/**
 * BIK Prestige Enterprise — MoMo Business Logic Tests
 *
 * Covers:
 * - Reconciliation calculation
 * - Daily account workflow (draft → submitted → reviewed)
 * - Location management
 * - Worker authorization
 */

import { describe, it, expect, beforeEach } from "vitest";
import { prisma, cleanDatabase, createTestAdmin } from "./setup";
import { calculateReconciliation } from "@/lib/momo-reconciliation";
import bcrypt from "bcryptjs";

let adminId: string;
let locationCounter = 0;

beforeEach(async () => {
  await cleanDatabase();
  const admin = await createTestAdmin();
  adminId = admin.id;
  locationCounter = 0;
});

// ============================================================
// RECONCILIATION CALCULATION
// ============================================================

describe("Reconciliation", () => {
  it("balances combined accountability when movements only shift money between pockets", () => {
    // Opening 1000 float + 500 cash = 1500.
    // Deposit 2000 and cash out 1500 move money between the pockets.
    // Commission 50 raises accountability; expenses 35 lower it.
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 500,
      customerDeposit: 2000,
      cashOut: 1500,
      airtimeSold: 0,
      commission: 50,
      totalExpenses: 35,
      closingMomoFloat: 550,
      closingCash: 965,
    });
    expect(result.expectedClosing).toBe(1515);
    expect(result.actualClosing).toBe(1515);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
  });

  it("detects a combined accountability shortage", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 500,
      openingCash: 300,
      additionalCashReceived: 0,
      additionalMomoFloat: 0,
      customerDeposit: 2000,
      cashOut: 1500,
      airtimeSold: 0,
      commission: 0,
      totalExpenses: 0,
      closingMomoFloat: 0,
      closingCash: 700,
    });
    expect(result.expectedClosing).toBe(800);
    expect(result.actualClosing).toBe(700);
    expect(result.difference).toBe(-100);
    expect(result.status).toBe("shortage");
  });

  it("is not affected by deposits, withdrawals or airtime sales", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 300,
      customerDeposit: 800,
      cashOut: 200,
      airtimeSold: 100,
      commission: 0,
      totalExpenses: 0,
      closingMomoFloat: 1000 - 800 + 200 - 100,
      closingCash: 300 + 800 - 200 + 100,
    });
    expect(result.difference).toBe(0);
  });

  it("counts commission once and expenses once", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 500,
      openingCash: 300,
      commission: 50,
      totalExpenses: 35,
      closingMomoFloat: 550,
      closingCash: 265,
    });
    expect(result.expectedClosing).toBe(815);
    expect(result.actualClosing).toBe(815);
    expect(result.difference).toBe(0);
  });
});

// ============================================================
// DAILY ACCOUNT WORKFLOW
// ============================================================

describe("Daily account workflow", () => {
  async function createLocation() {
    locationCounter++;
    return prisma.location.create({
      data: {
        name: `Test Location ${locationCounter}`,
        code: `TST-${String(locationCounter).padStart(3, "0")}`,
        status: "active",
      },
    });
  }

  async function createWorker(locationId: string) {
    const passwordHash = await bcrypt.hash("Worker123", 12);
    return prisma.user.create({
      data: {
        email: `worker-${Date.now()}@bikprestige.com`,
        fullName: "Test Worker",
        role: "worker",
        status: "active",
        passwordHash,
        locationId,
      },
    });
  }

  it("creates a daily account in draft status", async () => {
    const location = await createLocation();
    const worker = await createWorker(location.id);

    const account = await prisma.dailyAccount.create({
      data: {
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date(),
        status: "draft",
      },
    });

    expect(account.status).toBe("draft");
    expect(account.locationId).toBe(location.id);
    expect(account.workerId).toBe(worker.id);
  });

  it("enforces unique constraint on location + date", async () => {
    const location = await createLocation();
    const worker = await createWorker(location.id);
    const businessDate = new Date();

    await prisma.dailyAccount.create({
      data: {
        locationId: location.id,
        workerId: worker.id,
        businessDate,
        status: "draft",
      },
    });

    await expect(
      prisma.dailyAccount.create({
        data: {
          locationId: location.id,
          workerId: worker.id,
          businessDate,
          status: "draft",
        },
      })
    ).rejects.toThrow();
  });

  it("transitions draft → submitted → reviewed", async () => {
    const location = await createLocation();
    const worker = await createWorker(location.id);

    const account = await prisma.dailyAccount.create({
      data: {
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date(),
        status: "draft",
      },
    });

    expect(account.status).toBe("draft");

    // Submit
    const submitted = await prisma.dailyAccount.update({
      where: { id: account.id },
      data: { status: "submitted", submittedAt: new Date() },
    });
    expect(submitted.status).toBe("submitted");

    // Review
    const reviewed = await prisma.dailyAccount.update({
      where: { id: account.id },
      data: { status: "reviewed", reviewedAt: new Date(), reviewedBy: adminId },
    });
    expect(reviewed.status).toBe("reviewed");
  });

  it("records expenses against daily account", async () => {
    const location = await createLocation();
    const worker = await createWorker(location.id);

    const account = await prisma.dailyAccount.create({
      data: {
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date(),
        status: "draft",
      },
    });

    await prisma.expense.createMany({
      data: [
        { dailyAccountId: account.id, description: "Transport", amount: 15 },
        { dailyAccountId: account.id, description: "Airtime", amount: 10 },
      ],
    });

    const expenses = await prisma.expense.findMany({ where: { dailyAccountId: account.id } });
    expect(expenses).toHaveLength(2);
    expect(expenses.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(25);
  });

  it("cascade deletes expenses when account is deleted", async () => {
    const location = await createLocation();
    const worker = await createWorker(location.id);

    const account = await prisma.dailyAccount.create({
      data: {
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date(),
        status: "draft",
      },
    });

    await prisma.expense.create({
      data: { dailyAccountId: account.id, description: "Transport", amount: 15 },
    });

    await prisma.dailyAccount.delete({ where: { id: account.id } });

    const expenses = await prisma.expense.findMany({ where: { dailyAccountId: account.id } });
    expect(expenses).toHaveLength(0);
  });
});

// ============================================================
// LOCATION MANAGEMENT
// ============================================================

describe("Location management", () => {
  it("creates a location with unique code", async () => {
    const location = await prisma.location.create({
      data: {
        name: "BIK Prestige - Accra",
        code: "ACC-001",
        status: "active",
      },
    });

    expect(location.code).toBe("ACC-001");
    expect(location.status).toBe("active");
  });

  it("prevents duplicate location codes", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    const tenantId = admin.tenantId!;
    await prisma.location.create({
      data: { name: "Location 1", code: "DUP-001", status: "active", tenantId },
    });

    await expect(
      prisma.location.create({
        data: { name: "Location 2", code: "DUP-001", status: "active", tenantId },
      })
    ).rejects.toThrow();
  });

  it("tracks location status changes", async () => {
    const location = await prisma.location.create({
      data: { name: "Test", code: "TST-002", status: "active" },
    });

    const updated = await prisma.location.update({
      where: { id: location.id },
      data: { status: "inactive" },
    });

    expect(updated.status).toBe("inactive");
  });
});

// ============================================================
// WORKER AUTHORIZATION
// ============================================================

describe("Worker authorization", () => {
  it("worker is assigned to a specific location", async () => {
    const location = await prisma.location.create({
      data: { name: "Test Loc", code: "WL-001", status: "active" },
    });

    const passwordHash = await bcrypt.hash("Worker123", 12);
    const worker = await prisma.user.create({
      data: {
        email: "worker-auth@test.com",
        fullName: "Worker Auth",
        role: "worker",
        status: "active",
        passwordHash,
        locationId: location.id,
      },
    });

    expect(worker.locationId).toBe(location.id);
  });

  it("multiple workers can be assigned to same location", async () => {
    const location = await prisma.location.create({
      data: { name: "Test Loc 2", code: "WL-002", status: "active" },
    });

    const passwordHash = await bcrypt.hash("Worker123", 12);
    const w1 = await prisma.user.create({
      data: { email: "w1@test.com", fullName: "W1", role: "worker", passwordHash, locationId: location.id },
    });
    const w2 = await prisma.user.create({
      data: { email: "w2@test.com", fullName: "W2", role: "worker", passwordHash, locationId: location.id },
    });

    const workers = await prisma.user.findMany({ where: { locationId: location.id, role: "worker" } });
    expect(workers).toHaveLength(2);
  });
});
