/**
 * Deterministic anomaly monitoring (Priority 6).
 *
 * Pure rule tests plus a tenant-scoped scan/acknowledge/resolve flow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  ANOMALY_THRESHOLDS,
  evaluateAnomalies,
  type AnomalyInput,
} from "@/lib/anomaly-rules";

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
  acknowledgeAnomaly,
  getAnomalyBoard,
  resolveAnomaly,
  runAnomalyScan,
} from "@/lib/actions/anomaly.actions";

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

const NOW = new Date("2026-11-27T12:00:00Z");

function baseInput(overrides: Partial<AnomalyInput> = {}): AnomalyInput {
  return {
    from: "2026-11-01",
    to: "2026-11-27",
    now: NOW,
    locations: [{ id: "loc", name: "Main Branch" }],
    accounts: [],
    transactions: [],
    transfers: [],
    handovers: [],
    ...overrides,
  };
}

function account(
  id: string,
  overrides: Record<string, unknown> = {}
): AnomalyInput["accounts"][number] {
  return {
    id,
    locationId: "loc",
    locationName: "Main Branch",
    workerId: "worker",
    workerName: "Ama Worker",
    businessDate: new Date("2026-11-20T00:00:00Z"),
    status: "reviewed",
    submittedAt: new Date("2026-11-20T18:00:00Z"),
    reviewedAt: new Date("2026-11-21T09:00:00Z"),
    totalExpenses: 10,
    calculatedDifference: 0,
    ledgerMode: "aggregate",
    ...overrides,
  };
}

describe("deterministic rule set", () => {
  it("finds shortages and a repeated-shortage pattern with the measured evidence", () => {
    const findings = evaluateAnomalies(
      baseInput({
        accounts: [
          account("a1", { calculatedDifference: -80 }),
          account("a2", {
            businessDate: new Date("2026-11-21T00:00:00Z"),
            calculatedDifference: -60,
          }),
          account("a3", {
            businessDate: new Date("2026-11-22T00:00:00Z"),
            calculatedDifference: -700,
          }),
        ],
      })
    );

    const shortages = findings.filter((row) => row.ruleKey === "daily_shortage");
    expect(shortages).toHaveLength(3);
    expect(shortages.find((row) => row.entityId === "a3")?.severity).toBe("high");
    expect(shortages.find((row) => row.entityId === "a3")?.metricValue).toBe(700);
    expect(shortages.find((row) => row.entityId === "a1")?.thresholdValue).toBe(
      ANOMALY_THRESHOLDS.dailyDifference
    );

    const repeated = findings.find((row) => row.ruleKey === "repeated_shortage");
    expect(repeated).toBeTruthy();
    expect(repeated?.metricValue).toBe(3);
    expect(repeated?.severity).toBe("high");
    expect(repeated?.fingerprint).toContain("worker:2026-11");
    expect((repeated?.evidence.days as unknown[]).length).toBe(3);

    // Deterministic ordering: the same input produces byte-identical output.
    expect(
      evaluateAnomalies(
        baseInput({
          accounts: [
            account("a1", { calculatedDifference: -80 }),
            account("a2", {
              businessDate: new Date("2026-11-21T00:00:00Z"),
              calculatedDifference: -60,
            }),
            account("a3", {
              businessDate: new Date("2026-11-22T00:00:00Z"),
              calculatedDifference: -700,
            }),
          ],
        })
      )
    ).toEqual(findings);
  });

  it("flags an aggregate close that has transaction-level ledger activity", () => {
    const findings = evaluateAnomalies(
      baseInput({
        accounts: [account("a-mixed", { ledgerMode: "aggregate" })],
        transactions: [
          {
            id: "tx-mixed",
            type: "cash_in",
            amount: 50,
            status: "recorded",
            businessDate: new Date("2026-11-20T10:00:00Z"),
            locationId: "loc",
            locationName: "Main Branch",
            workerId: "worker",
            workerName: "Ama Worker",
            reference: "MIXED-1",
            isReversal: false,
          },
        ],
      })
    );

    const finding = findings.find((row) => row.ruleKey === "mixed_aggregate_ledger");
    expect(finding).toBeTruthy();
    expect(finding).toMatchObject({
      entityId: "a-mixed",
      severity: "medium",
      metricValue: 1,
      thresholdValue: null,
    });
    expect(finding?.summary).toContain("which source is authoritative");
    expect(finding?.evidence.transactionReferences).toEqual(["MIXED-1"]);

    const ledgerBacked = evaluateAnomalies(
      baseInput({
        accounts: [account("a-ledger", { ledgerMode: "ledger" })],
        transactions: [
          {
            id: "tx-ledger",
            type: "cash_in",
            amount: 50,
            status: "recorded",
            businessDate: new Date("2026-11-20T10:00:00Z"),
            locationId: "loc",
            locationName: "Main Branch",
            workerId: "worker",
            workerName: "Ama Worker",
            reference: "LEDGER-1",
            isReversal: false,
          },
        ],
      })
    );
    expect(
      ledgerBacked.find((row) => row.ruleKey === "mixed_aggregate_ledger")
    ).toBeUndefined();
  });

  it("finds large transactions, repeated reversals, stale transfers and handover issues", () => {
    const findings = evaluateAnomalies(
      baseInput({
        transactions: [
          {
            id: "t1",
            type: "cash_out",
            amount: 6000,
            status: "recorded",
            businessDate: new Date("2026-11-20T10:00:00Z"),
            locationId: "loc",
            locationName: "Main Branch",
            workerId: "worker",
            workerName: "Ama Worker",
            reference: "TXN-1",
            isReversal: false,
          },
          ...["r1", "r2", "r3"].map((id) => ({
            id,
            type: "cash_in",
            amount: 50,
            status: "reversal" as const,
            businessDate: new Date("2026-11-21T10:00:00Z"),
            locationId: "loc",
            locationName: "Main Branch",
            workerId: "worker",
            workerName: "Ama Worker",
            reference: `REV-${id}`,
            isReversal: true,
          })),
        ],
        transfers: [
          {
            id: "tr1",
            reference: "TR-1",
            status: "variance_investigation",
            amount: 500,
            variance: -20,
            sourceLocationId: "loc",
            destinationLocationId: "loc2",
            approvedAt: new Date("2026-11-20T09:00:00Z"),
            dispatchedAt: new Date("2026-11-20T10:00:00Z"),
            createdAt: new Date("2026-11-20T08:00:00Z"),
            updatedAt: new Date("2026-11-20T11:00:00Z"),
          },
          {
            id: "tr2",
            reference: "TR-2",
            status: "dispatched",
            amount: 300,
            variance: 0,
            sourceLocationId: "loc",
            destinationLocationId: "loc2",
            approvedAt: new Date("2026-11-20T09:00:00Z"),
            dispatchedAt: new Date("2026-11-20T10:00:00Z"),
            createdAt: new Date("2026-11-20T08:00:00Z"),
            updatedAt: new Date("2026-11-20T11:00:00Z"),
          },
        ],
        handovers: [
          {
            id: "h1",
            shiftId: "s1",
            status: "variance_open",
            outgoingUserId: "worker",
            outgoingUserName: "Ama Worker",
            cashVariance: -30,
            floatVariance: 0,
            createdAt: new Date("2026-11-20T18:00:00Z"),
            confirmedAt: new Date("2026-11-20T19:00:00Z"),
            businessDate: new Date("2026-11-20T00:00:00Z"),
            locationId: "loc",
            locationName: "Main Branch",
          },
          {
            id: "h2",
            shiftId: "s2",
            status: "awaiting_receipt",
            outgoingUserId: "worker",
            outgoingUserName: "Ama Worker",
            cashVariance: 0,
            floatVariance: 0,
            createdAt: new Date("2026-11-24T18:00:00Z"),
            confirmedAt: null,
            businessDate: new Date("2026-11-24T00:00:00Z"),
            locationId: "loc",
            locationName: "Main Branch",
          },
        ],
      })
    );

    expect(findings.find((row) => row.ruleKey === "large_transaction")).toMatchObject({
      entityId: "t1",
      severity: "medium",
      metricValue: 6000,
    });
    expect(findings.find((row) => row.ruleKey === "repeated_reversal")?.metricValue).toBe(3);
    expect(findings.find((row) => row.ruleKey === "transfer_variance")?.metricValue).toBe(20);
    expect(findings.find((row) => row.ruleKey === "stale_transfer")?.entityId).toBe("tr2");
    expect(findings.find((row) => row.ruleKey === "shift_variance")?.metricValue).toBe(30);
    expect(findings.find((row) => row.ruleKey === "unconfirmed_handover")?.entityId).toBe("h2");
  });

  it("finds an expense spike only when the branch has enough comparable days", () => {
    const baseline = [
      account("b1", { totalExpenses: 10 }),
      account("b2", {
        businessDate: new Date("2026-11-21T00:00:00Z"),
        totalExpenses: 12,
      }),
      account("b3", {
        businessDate: new Date("2026-11-22T00:00:00Z"),
        totalExpenses: 11,
      }),
    ];
    const spike = account("spike", {
      businessDate: new Date("2026-11-23T00:00:00Z"),
      totalExpenses: 300,
    });
    const findings = evaluateAnomalies(baseInput({ accounts: [...baseline, spike] }));
    expect(findings.find((row) => row.ruleKey === "expense_spike")).toMatchObject({
      entityId: "spike",
      metricValue: 300,
    });

    // With fewer than three comparison days, no spike claim is made.
    const weak = evaluateAnomalies(
      baseInput({
        accounts: [
          account("b1", { totalExpenses: 10 }),
          account("spike", {
            businessDate: new Date("2026-11-21T00:00:00Z"),
            totalExpenses: 300,
          }),
        ],
      })
    );
    expect(weak.find((row) => row.ruleKey === "expense_spike")).toBeUndefined();
  });

  it("does not invent findings for a clean period", () => {
    const findings = evaluateAnomalies(
      baseInput({
        accounts: [
          account("a1"),
          account("a2", { businessDate: new Date("2026-11-25T00:00:00Z") }),
          account("a3", { businessDate: new Date("2026-11-26T00:00:00Z") }),
        ],
        transactions: [],
        transfers: [],
        handovers: [],
      })
    );
    expect(findings).toEqual([]);
  });
});

describe("scan persistence and review", () => {
  let counter = 0;

  async function fixture() {
    counter += 1;
    const tenant = await createTestTenant({ momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Anomaly Branch", code: `ANOM-${counter}` },
    });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `anomaly-worker-${counter}@test.invalid`,
        fullName: "Ama Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        locationId: location.id,
      },
    });
    return { tenant, location, admin, worker };
  }

  function today(offset: number): string {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)
    )
      .toISOString()
      .slice(0, 10);
  }

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists a shortage once, then acknowledges and resolves it", async () => {
    const f = await fixture();
    await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        businessDate: new Date(`${today(1)}T00:00:00.000Z`),
        status: "submitted",
        submittedAt: new Date(Date.now() - 4 * 86_400_000),
        calculatedDifference: -120,
      },
    });

    await setAdminSession(f.admin);
    const first = await runAnomalyScan({ from: today(10), to: today(0) });
    expect(first.success).toBe(true);
    expect((first.data as { created: number }).created).toBeGreaterThanOrEqual(1);

    const second = await runAnomalyScan({ from: today(10), to: today(0) });
    expect((second.data as { created: number }).created).toBe(0);

    const stored = await prisma.operationalAnomaly.findMany({
      where: { tenantId: f.tenant.id },
    });
    expect(stored).toHaveLength((first.data as { created: number }).created);
    const shortage = stored.find((row) => row.ruleKey === "daily_shortage");
    expect(shortage?.status).toBe("open");
    expect(shortage?.severity).toBe("medium");
    expect(shortage?.metricValue?.toString()).toBe("120");

    const board = await getAnomalyBoard();
    expect(board.counts.open).toBeGreaterThanOrEqual(1);
    expect(board.anomalies.some((row) => row.ruleKey === "daily_shortage")).toBe(true);

    const ack = await acknowledgeAnomaly({ id: shortage!.id, note: "Checking with the agent." });
    expect(ack.success).toBe(true);
    const afterAck = await prisma.operationalAnomaly.findUniqueOrThrow({
      where: { id: shortage!.id },
    });
    expect(afterAck.status).toBe("acknowledged");
    expect(afterAck.acknowledgedById).toBe(f.admin.id);
    expect(afterAck.resolutionNote).toBe("Checking with the agent.");

    const shortNote = await resolveAnomaly({ id: shortage!.id, note: "ok" });
    expect(shortNote.success).toBe(false);

    const resolved = await resolveAnomaly({
      id: shortage!.id,
      note: "Recount found the missing cash in the safe; correction recorded.",
    });
    expect(resolved.success).toBe(true);
    const afterResolve = await prisma.operationalAnomaly.findUniqueOrThrow({
      where: { id: shortage!.id },
    });
    expect(afterResolve.status).toBe("resolved");
    expect(afterResolve.resolvedById).toBe(f.admin.id);

    const audit = await prisma.auditLog.findMany({
      where: { tenantId: f.tenant.id, entityType: "operationalAnomaly" },
    });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(["anomaly.acknowledged", "anomaly.resolved"])
    );
  });

  it("keeps findings and review actions inside the tenant", async () => {
    const f = await fixture();
    const other = await fixture();
    await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        businessDate: new Date(`${today(1)}T00:00:00.000Z`),
        status: "submitted",
        calculatedDifference: -90,
      },
    });

    await setAdminSession(f.admin);
    await runAnomalyScan({ from: today(10), to: today(0) });
    const finding = await prisma.operationalAnomaly.findFirstOrThrow({
      where: { tenantId: f.tenant.id, ruleKey: "daily_shortage" },
    });

    await setAdminSession(other.admin);
    const otherBoard = await getAnomalyBoard();
    expect(otherBoard.anomalies).toHaveLength(0);
    expect((await acknowledgeAnomaly({ id: finding.id })).success).toBe(false);

    await setAdminSession(f.admin);
    expect((await acknowledgeAnomaly({ id: finding.id })).success).toBe(true);
  });
});
