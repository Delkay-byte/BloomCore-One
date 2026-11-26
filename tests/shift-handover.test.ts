/**
 * Employee shift and two-sided handover acceptance tests (Priority 3).
 *
 * Real server actions against the SQLite test database. Only next/headers,
 * next/navigation and next/cache are mocked.
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
  cancelShift,
  closeShift,
  confirmShiftHandover,
  createShift,
  getAdminShiftBoard,
  getDailyAccountShiftSummary,
  getShiftDetail,
  getWorkerShiftBoard,
  openShift,
  resolveShiftHandover,
} from "@/lib/actions/shift.actions";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import {
  computeHandoverVariance,
  decideShiftOpeningCarry,
  shiftOpeningIsMaterial,
} from "@/lib/shifts";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setSession(module: "admin" | "momo", user: { id: string; email: string }) {
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

interface Fixture {
  tenant: { id: string; code: string };
  location: { id: string; name: string };
  otherLocation: { id: string; name: string };
  outgoing: { id: string; email: string; fullName: string };
  incoming: { id: string; email: string; fullName: string };
  outsider: { id: string; email: string; fullName: string };
  admin: { id: string; email: string };
}

let counter = 0;

async function fixture(): Promise<Fixture> {
  counter += 1;
  const tenant = await createTestTenant({ momo: true, susu: false });
  const location = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Main Branch", code: `SHF-${counter}` },
  });
  const otherLocation = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Other Branch", code: `OTH-${counter}` },
  });
  const passwordHash = await bcrypt.hash("Test1234!", 4);
  const makeWorker = (name: string, assignedLocationId: string, emailTag: string) =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `${emailTag}-${counter}@test.invalid`,
        fullName: name,
        role: "worker",
        status: "active",
        passwordHash,
        momoEnabled: true,
        locationId: assignedLocationId,
        passwordPolicyVersion: 1,
      },
    });
  const outgoing = await makeWorker("Ama Outgoing", location.id, "outgoing");
  const incoming = await makeWorker("Kofi Incoming", location.id, "incoming");
  const outsider = await makeWorker("Esi Other", otherLocation.id, "outsider");
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
  return { tenant, location, otherLocation, outgoing, incoming, outsider, admin };
}

const DATE = "2026-11-26";

function createInput(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    locationId: f.location.id,
    businessDate: DATE,
    name: "morning",
    assignedUserId: f.outgoing.id,
    openingCash: 100,
    openingMomoFloat: 500,
    ...overrides,
  };
}

async function createAndOpen(f: Fixture, overrides: Record<string, unknown> = {}) {
  await setSession("momo", f.outgoing);
  const created = await createShift(createInput(f, overrides) as never);
  expect(created.success).toBe(true);
  const shiftId = (created.data as { shiftId: string }).shiftId;
  const opened = await openShift(shiftId);
  expect(opened.success).toBe(true);
  return shiftId;
}

async function submitHandover(f: Fixture, shiftId: string) {
  await setSession("momo", f.outgoing);
  const closed = await closeShift({
    shiftId,
    closingCash: 140,
    closingMomoFloat: 610,
    handoverToUserId: f.incoming.id,
    outstandingOperations: "Two pending cash-outs",
    outgoingNotes: "Till counted with the receiver present",
    outgoingEvidence: "Till slip TS-1042",
  });
  expect(closed.success).toBe(true);
  return (closed.data as { handoverId: string }).handoverId;
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("shift handover policy", () => {
  it("classifies the two sides and only carries a fully closed previous shift", () => {
    const variance = computeHandoverVariance({
      outgoingCash: 140,
      outgoingFloat: 610,
      incomingCash: 120,
      incomingFloat: 610,
    });
    expect(variance).toEqual({
      cashVariance: -20,
      floatVariance: 0,
      totalVariance: -20,
      balanced: false,
    });

    expect(
      decideShiftOpeningCarry({
        id: "s1",
        label: "Morning",
        status: "closed",
        closingCash: 140,
        closingMomoFloat: 610,
        openVariance: false,
      })
    ).toMatchObject({ available: true, openingCash: 140, openingMomoFloat: 610 });

    expect(
      decideShiftOpeningCarry({
        id: "s1",
        label: "Morning",
        status: "awaiting_handover",
        closingCash: 140,
        closingMomoFloat: 610,
        openVariance: true,
      })
    ).toMatchObject({ available: false, reason: "prior_not_closed" });

    expect(shiftOpeningIsMaterial({ cash: 140, float: 610 }, { cash: 140, float: 610 })).toBe(
      false
    );
    expect(shiftOpeningIsMaterial({ cash: 141, float: 610 }, { cash: 140, float: 610 })).toBe(
      true
    );
  });
});

describe("shift lifecycle and two-sided handover", () => {
  it("keeps both sides of the count and closes only when both agree", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);
    const handoverId = await submitHandover(f, shiftId);

    // The outgoing employee cannot confirm their own handover.
    await setSession("momo", f.outgoing);
    const selfConfirm = await confirmShiftHandover({
      handoverId,
      incomingCash: 140,
      incomingMomoFloat: 610,
      operationsAccepted: true,
    });
    expect(selfConfirm.success).toBe(false);
    expect(selfConfirm.error).toContain("receiver");

    // An administrator who is not the named receiver cannot complete it either.
    await setSession("admin", f.admin);
    const adminConfirm = await confirmShiftHandover({
      handoverId,
      incomingCash: 140,
      incomingMomoFloat: 610,
      operationsAccepted: true,
    });
    expect(adminConfirm.success).toBe(false);

    // The receiver records their own count.
    await setSession("momo", f.incoming);
    const confirmed = await confirmShiftHandover({
      handoverId,
      incomingCash: 140,
      incomingMomoFloat: 610,
      operationsAccepted: true,
      incomingEvidence: "Count sheet CS-77 signed by the receiver",
    });
    expect(confirmed.success).toBe(true);
    expect(confirmed.data).toMatchObject({ status: "confirmed", cashVariance: 0 });

    const detail = await getShiftDetail(shiftId);
    expect(detail?.shift.status).toBe("closed");
    const handover = detail?.shift.handovers[0];
    expect(handover?.outgoingCash).toBe(140);
    expect(handover?.incomingCash).toBe(140);
    expect(handover?.outgoingUserName).toBe("Ama Outgoing");
    expect(handover?.incomingUserName).toBe("Kofi Incoming");
    expect(handover?.outgoingEvidence).toBe("Till slip TS-1042");
    expect(handover?.incomingEvidence).toBe(
      "Count sheet CS-77 signed by the receiver"
    );

    // A second confirmation cannot change the preserved figures.
    const again = await confirmShiftHandover({
      handoverId,
      incomingCash: 1,
      incomingMomoFloat: 1,
      operationsAccepted: true,
    });
    expect(again.success).toBe(false);
    const unchanged = await getShiftDetail(shiftId);
    expect(unchanged?.shift.handovers[0]?.incomingCash).toBe(140);
  });

  it("carries the previous close into the next shift only after both sides agree", async () => {
    const f = await fixture();
    const morningId = await createAndOpen(f);
    const handoverId = await submitHandover(f, morningId);

    // Attempting to start the next shift before confirmation does not carry.
    await setSession("momo", f.outgoing);
    const early = await createShift(
      createInput(f, {
        name: "afternoon",
        openingCash: 0,
        openingMomoFloat: 0,
      }) as never
    );
    expect(early.success).toBe(true);
    const earlyId = (early.data as { shiftId: string }).shiftId;
    const earlyDetail = await getShiftDetail(earlyId);
    expect(earlyDetail?.shift.openingSource).toBe("manual");
    expect(earlyDetail?.shift.openingCash).toBe(0);

    await setSession("momo", f.incoming);
    await confirmShiftHandover({
      handoverId,
      incomingCash: 140,
      incomingMomoFloat: 610,
      operationsAccepted: true,
    });

    // Remove the unused draft so the immediate predecessor is the closed morning.
    await prisma.shift.delete({ where: { id: earlyId } });

    await setSession("momo", f.outgoing);
    const evening = await createShift(
      createInput(f, {
        name: "evening",
        openingCash: 0,
        openingMomoFloat: 0,
      }) as never
    );
    expect(evening.success).toBe(true);
    const eveningDetail = await getShiftDetail(
      (evening.data as { shiftId: string }).shiftId
    );
    expect(eveningDetail?.shift.openingSource).toBe("carried");
    expect(eveningDetail?.shift.openingCash).toBe(140);
    expect(eveningDetail?.shift.openingMomoFloat).toBe(610);
  });

  it("preserves a shortage as an open variance until an administrator resolves it with step-up", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);
    const handoverId = await submitHandover(f, shiftId);

    await setSession("momo", f.incoming);
    const short = await confirmShiftHandover({
      handoverId,
      incomingCash: 120,
      incomingMomoFloat: 610,
      operationsAccepted: true,
      incomingNotes: "Counted twice; GH₵20 is missing.",
    });
    expect(short.success).toBe(true);
    expect(short.data).toMatchObject({ status: "variance_open", cashVariance: -20 });

    const detail = await getShiftDetail(shiftId);
    expect(detail?.shift.status).toBe("variance_open");
    expect(detail?.shift.handovers[0]).toMatchObject({
      outgoingCash: 140,
      incomingCash: 120,
      cashVariance: -20,
      status: "variance_open",
    });

    const handover = await prisma.shiftHandover.findUniqueOrThrow({
      where: { id: handoverId },
    });
    const amountMinor =
      Math.round(Number(handover.cashVariance ?? 0) * 100) +
      Math.round(Number(handover.floatVariance ?? 0) * 100);

    await setSession("admin", f.admin);
    const noStepUp = await resolveShiftHandover({
      handoverId,
      resolutionNote: "Owner investigated and accepted the shortage.",
    });
    expect(noStepUp.success).toBe(false);

    const grant = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "finance.shift_handover.resolve",
      targetType: "shiftHandover",
      targetId: handoverId,
      context: { amountMinor },
    });
    expect(grant.success).toBe(true);
    const resolved = await resolveShiftHandover({
      handoverId,
      resolutionNote: "Owner investigated and accepted the shortage.",
      stepUpToken: (grant.data as { stepUpToken: string }).stepUpToken,
    });
    expect(resolved.success).toBe(true);

    const after = await getShiftDetail(shiftId);
    expect(after?.shift.status).toBe("closed");
    expect(after?.shift.handovers[0]?.status).toBe("resolved");
    expect(after?.shift.handovers[0]?.resolutionNote).toContain("accepted");
  });

  it("refuses a variance confirmation without an explanation", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);
    const handoverId = await submitHandover(f, shiftId);

    await setSession("momo", f.incoming);
    const result = await confirmShiftHandover({
      handoverId,
      incomingCash: 130,
      incomingMomoFloat: 610,
      operationsAccepted: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Explain");
  });

  it("refuses an administrator submitting the outgoing count for an employee", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);

    await setSession("admin", f.admin);
    const close = await closeShift({
      shiftId,
      closingCash: 140,
      closingMomoFloat: 610,
      handoverToUserId: f.incoming.id,
    });
    expect(close.success).toBe(false);
    expect(close.error).toContain("assigned to this shift");
  });

  it("refuses one employee as both sides and refuses a receiver from another branch", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);

    await setSession("momo", f.outgoing);
    const samePerson = await closeShift({
      shiftId,
      closingCash: 140,
      closingMomoFloat: 610,
      handoverToUserId: f.outgoing.id,
    });
    expect(samePerson.success).toBe(false);
    expect(samePerson.error).toContain("different employee");

    const otherBranch = await closeShift({
      shiftId,
      closingCash: 140,
      closingMomoFloat: 610,
      handoverToUserId: f.outsider.id,
    });
    expect(otherBranch.success).toBe(false);
    expect(otherBranch.error).toContain("location");
  });

  it("requires a manual opening difference to be explained", async () => {
    const f = await fixture();
    const morningId = await createAndOpen(f);
    const handoverId = await submitHandover(f, morningId);
    await setSession("momo", f.incoming);
    await confirmShiftHandover({
      handoverId,
      incomingCash: 140,
      incomingMomoFloat: 610,
      operationsAccepted: true,
    });

    await setSession("momo", f.outgoing);
    const unexplained = await createShift(
      createInput(f, {
        name: "afternoon",
        openingCash: 140,
        openingMomoFloat: 500,
      }) as never
    );
    expect(unexplained.success).toBe(false);
    expect(unexplained.error).toContain("Explain");

    const explained = await createShift(
      createInput(f, {
        name: "afternoon",
        openingCash: 140,
        openingMomoFloat: 500,
        openingAdjustmentReason: "Float moved to the branch safe at close.",
      }) as never
    );
    expect(explained.success).toBe(true);
    const detail = await getShiftDetail((explained.data as { shiftId: string }).shiftId);
    expect(detail?.shift.openingSource).toBe("manual_adjusted");
  });
});

describe("tenant, role and duplicate protection", () => {
  it("isolates shifts by tenant", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);
    const handoverId = await submitHandover(f, shiftId);

    const otherTenant = await createTestTenant({ momo: true, susu: false });
    const otherAdmin = await createTestAdmin({
      tenantId: otherTenant.id,
      momo: true,
      susu: false,
    });
    await setSession("admin", otherAdmin);
    expect(await getShiftDetail(shiftId)).toBeNull();
    const confirm = await confirmShiftHandover({
      handoverId,
      incomingCash: 140,
      incomingMomoFloat: 610,
      operationsAccepted: true,
    });
    expect(confirm.success).toBe(false);
    const close = await closeShift({
      shiftId,
      closingCash: 1,
      closingMomoFloat: 1,
      handoverToUserId: otherAdmin.id,
    });
    expect(close.success).toBe(false);
  });

  it("accepts a tenant-defined custom shift label", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f, {
      name: "custom",
      label: "School run",
      scheduledStart: "2026-11-26T06:00:00.000Z",
      scheduledEnd: "2026-11-26T09:00:00.000Z",
    });
    const detail = await getShiftDetail(shiftId);
    expect(detail?.shift.name).toBe("custom");
    expect(detail?.shift.label).toBe("School run");
  });

  it("refuses duplicate shift names at the same branch and day", async () => {
    const f = await fixture();
    await createAndOpen(f);
    const duplicate = await createShift(createInput(f) as never);
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toContain("already exists");
  });

  it("keeps workers from acting on another employee's shift", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);

    await setSession("momo", f.incoming);
    const close = await closeShift({
      shiftId,
      closingCash: 140,
      closingMomoFloat: 610,
      handoverToUserId: f.outgoing.id,
    });
    expect(close.success).toBe(false);
    expect(close.error).toContain("access");
  });

  it("allows only draft shifts to open and only open shifts to close", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);
    expect((await openShift(shiftId)).success).toBe(false);

    const cancelled = await cancelShift({ shiftId, reason: "Branch closed early" });
    expect(cancelled.success).toBe(true);
    expect((await openShift(shiftId)).success).toBe(false);
  });
});

describe("daily account aggregation and oversight", () => {
  it("aggregates shift accountability without adding shift balances into the day", async () => {
    const f = await fixture();
    const morningId = await createAndOpen(f);
    const handoverId = await submitHandover(f, morningId);
    await setSession("momo", f.incoming);
    await confirmShiftHandover({
      handoverId,
      incomingCash: 120,
      incomingMomoFloat: 610,
      operationsAccepted: true,
      incomingNotes: "GH₵20 shortage found on recount.",
    });

    const account = await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.outgoing.id,
        businessDate: new Date(`${DATE}T00:00:00.000Z`),
        openingCash: 100,
        openingMomoFloat: 500,
        closingCash: 140,
        closingMomoFloat: 610,
      },
    });
    await prisma.shift.update({
      where: { id: morningId },
      data: { dailyAccountId: account.id },
    });

    await setSession("admin", f.admin);
    const summary = await getDailyAccountShiftSummary(account.id);
    expect(summary.shiftCount).toBe(1);
    expect(summary.totalCashVariance).toBe(-20);
    expect(summary.note).toContain("never added");
    expect(summary).not.toHaveProperty("totalCash");
    expect(summary.shifts[0]).toMatchObject({
      id: morningId,
      assignedUserName: "Ama Outgoing",
      cashVariance: -20,
    });

    const board = await getAdminShiftBoard();
    expect(board.totals.shifts).toBe(1);
    expect(board.totals.varianceOpen).toBe(1);
    expect(board.stats.find((row) => row.userId === f.outgoing.id)).toMatchObject({
      shiftCount: 1,
      varianceCount: 1,
      totalCashVariance: -20,
    });
  });

  it("shows the receiving employee their pending confirmation only", async () => {
    const f = await fixture();
    const shiftId = await createAndOpen(f);
    await submitHandover(f, shiftId);

    await setSession("momo", f.incoming);
    const board = await getWorkerShiftBoard();
    expect(board.userId).toBe(f.incoming.id);
    expect(board.awaitingMyConfirmation).toHaveLength(1);
    expect(board.awaitingMyConfirmation[0]?.outgoingUserName).toBe("Ama Outgoing");

    await setSession("momo", f.outsider);
    const otherBoard = await getWorkerShiftBoard();
    expect(otherBoard.awaitingMyConfirmation).toHaveLength(0);
    expect(otherBoard.shifts).toHaveLength(0);
  });
});
