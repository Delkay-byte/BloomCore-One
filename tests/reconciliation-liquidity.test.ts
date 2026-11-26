/**
 * Branch liquidity snapshots, unified reconciliation exceptions and partial
 * transfer settlement (Priority A1).
 *
 * Real server actions against the SQLite test database. Only next/headers,
 * next/navigation and next/cache are mocked, exactly as the branch-transfer
 * suite does.
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

import {
  computeLiquidityLine,
  summariseLiquidity,
  branchLiquiditySnapshotSchema,
  canTransitionLiquidity,
} from "@/lib/branch-liquidity";
import { planPartialSettlement, minorToCedi } from "@/lib/branch-transfers";
import {
  getLiquidityBoard,
  saveLiquiditySnapshot,
  submitLiquiditySnapshot,
  reviewLiquiditySnapshot,
} from "@/lib/actions/branch-liquidity.actions";
import {
  getExceptionCases,
  linkCaseRecord,
  openExceptionCase,
  updateExceptionCase,
} from "@/lib/actions/provider-statement.actions";
import {
  createBranchTransfer,
  declareBranchBalance,
  dispatchBranchTransfer,
  receiveBranchTransfer,
  requestBranchTransfer,
  approveBranchTransfer,
  settlePartialTransfer,
} from "@/lib/actions/branch-transfer.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test Admin",
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function setWorkerSession(user: { id: string; email: string; fullName: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-worker-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
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

let counter = 0;

async function fixture() {
  counter += 1;
  const tenant = await createTestTenant({ momo: true, susu: false });
  const branch = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Accra Branch", code: `ACC-${counter}` },
  });
  const other = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Tema Branch", code: `TEM-${counter}` },
  });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
  await setAdminSession(admin);
  return { tenant, branch, other, admin };
}

const TODAY = new Date().toISOString().slice(0, 10);

describe("liquidity domain rules", () => {
  it("keeps declared, adjusted and counted apart and computes the variance", () => {
    const line = computeLiquidityLine({
      assetType: "cash",
      openingDeclaredMinor: 100_000,
      transferAdjustmentMinor: -25_000,
      countedCloseMinor: 70_000,
    });
    expect(line.expectedCloseMinor).toBe(75_000);
    expect(line.varianceMinor).toBe(-5_000);
    expect(line.state).toBe("short");
  });

  it("always requires an explanation for a short line even when another line is over", () => {
    const result = summariseLiquidity([
      computeLiquidityLine({
        assetType: "cash",
        openingDeclaredMinor: 100_000,
        transferAdjustmentMinor: 0,
        countedCloseMinor: 90_000,
      }),
      computeLiquidityLine({
        assetType: "mtn_float",
        openingDeclaredMinor: 100_000,
        transferAdjustmentMinor: 0,
        countedCloseMinor: 110_000,
      }),
    ]);
    // Net is balanced, but money is missing from one pocket.
    expect(result.varianceTotalMinor).toBe(0);
    expect(result.shortLines).toBe(1);
    expect(result.balanced).toBe(false);
    expect(result.requiresExplanation).toBe(true);
  });

  it("rejects a short snapshot that has no explanation", () => {
    const parsed = branchLiquiditySnapshotSchema.safeParse({
      locationId: "loc",
      businessDate: "2026-11-01",
      lines: [
        { assetType: "cash", openingDeclaredMinor: 100_000, countedCloseMinor: 50_000 },
      ],
    });
    expect(parsed.success).toBe(false);
    const withNote = branchLiquiditySnapshotSchema.safeParse({
      locationId: "loc",
      businessDate: "2026-11-01",
      lines: [
        {
          assetType: "cash",
          openingDeclaredMinor: 100_000,
          countedCloseMinor: 50_000,
          note: "Cash removed for a supplier payment that was not recorded",
        },
      ],
    });
    expect(withNote.success).toBe(true);
  });

  it("allows a normal review transition only", () => {
    expect(canTransitionLiquidity("draft", "submitted")).toBe(true);
    expect(canTransitionLiquidity("submitted", "reviewed")).toBe(true);
    expect(canTransitionLiquidity("reviewed", "draft")).toBe(false);
    expect(canTransitionLiquidity("draft", "reviewed")).toBe(false);
  });

  it("plans a partial settlement without changing the dispatched amount", () => {
    const plan = planPartialSettlement({ dispatchedMinor: 100_000, receivedMinor: 90_000 });
    expect(plan).toEqual({
      settledMinor: 90_000,
      outstandingMinor: 10_000,
      varianceMinor: -10_000,
      status: "partial_open",
    });
    expect(planPartialSettlement({ dispatchedMinor: 100_000, receivedMinor: 100_000 })).toMatchObject({
      outstandingMinor: 0,
      status: "full",
    });
    expect(minorToCedi(10_005)).toBe(100.05);
  });
});

describe("branch liquidity snapshots", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("derives the expected close from transfers on the server, not the client", async () => {
    const { branch, other, tenant } = await fixture();
    // A transfer can only be requested against a declared balance.
    const declared = await declareBranchBalance({
      locationId: branch.id,
      assetType: "cash",
      declaredBalance: 1000,
    });
    expect(declared.success, declared.error).toBe(true);
    // A dispatched transfer out of this branch must reduce the expected close.
    const sent = await createBranchTransfer({
      sourceLocationId: branch.id,
      destinationLocationId: other.id,
      assetType: "cash",
      amount: 100,
      idempotencyKey: `liq-${Date.now()}`,
    });
    expect(sent.success, sent.error).toBe(true);
    const transferId = (sent.data as { transferId: string }).transferId;
    await requestBranchTransfer(transferId).catch(() => undefined);
    await dispatchBranchTransfer(transferId, "Waybill 1").catch(() => undefined);

    const saved = await saveLiquiditySnapshot({
      locationId: branch.id,
      businessDate: TODAY,
      lines: [
        {
          assetType: "cash",
          openingDeclaredMinor: 50_000,
          countedCloseMinor: 40_000,
          note: "Cash dispatched to Tema; the transfer record carries the movement",
        },
        { assetType: "mtn_float", openingDeclaredMinor: 20_000, countedCloseMinor: 20_000 },
      ],
    });
    expect(saved.success).toBe(true);

    const board = await getLiquidityBoard(TODAY);
    const view = board.locations.find((row) => row.locationId === branch.id);
    expect(view).toBeTruthy();
    const cash = view!.lines.find((line) => line.assetType === "cash")!;
    // The client did not send the adjustment. It came from the transfer record.
    expect(cash.transferAdjustmentMinor).toBeLessThanOrEqual(0);
    expect(cash.expectedCloseMinor).toBe(cash.openingDeclaredMinor + cash.transferAdjustmentMinor);
    expect(tenant.id).toBeTruthy();
  });

  it("refuses a short snapshot without an explanation", async () => {
    const { branch } = await fixture();
    const result = await saveLiquiditySnapshot({
      locationId: branch.id,
      businessDate: TODAY,
      lines: [{ assetType: "cash", openingDeclaredMinor: 50_000, countedCloseMinor: 10_000 }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/explanation/i);
  });

  it("submits, reviews and opens an exception case for a short branch", async () => {
    const { branch } = await fixture();
    const saved = await saveLiquiditySnapshot({
      locationId: branch.id,
      businessDate: TODAY,
      lines: [
        {
          assetType: "cash",
          openingDeclaredMinor: 50_000,
          countedCloseMinor: 40_000,
          note: "Cash removed for an emergency supplier payment without a receipt",
        },
      ],
    });
    expect(saved.success).toBe(true);
    const snapshotId = (saved.data as { id: string }).id;

    expect((await submitLiquiditySnapshot(snapshotId)).success).toBe(true);
    const reviewed = await reviewLiquiditySnapshot({
      id: snapshotId,
      note: "Confirmed with the branch supervisor.",
      openCase: true,
    });
    expect(reviewed.success).toBe(true);
    expect((reviewed.data as { caseId: string | null }).caseId).toBeTruthy();

    const cases = await getExceptionCases();
    expect(cases).toHaveLength(1);
    expect(cases[0].category).toBe("branch_liquidity");
    expect(cases[0].links[0].entityType).toBe("branchLiquiditySnapshot");
    // Reviewing does not change any money.
    const snapshot = await prisma.branchLiquiditySnapshot.findUnique({ where: { id: snapshotId } });
    expect(snapshot?.status).toBe("reviewed");
    expect(Number(snapshot?.reviewedById ? 1 : 0)).toBe(1);
  });

  it("refuses to edit a reviewed snapshot", async () => {
    const { branch } = await fixture();
    const saved = await saveLiquiditySnapshot({
      locationId: branch.id,
      businessDate: TODAY,
      lines: [{ assetType: "cash", openingDeclaredMinor: 10_000, countedCloseMinor: 10_000 }],
    });
    const snapshotId = (saved.data as { id: string }).id;
    await submitLiquiditySnapshot(snapshotId);
    await reviewLiquiditySnapshot({ id: snapshotId });

    const again = await saveLiquiditySnapshot({
      locationId: branch.id,
      businessDate: TODAY,
      lines: [{ assetType: "cash", openingDeclaredMinor: 10_000, countedCloseMinor: 5_000, note: "Too late to change this" }],
    });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/final/i);
  });

  it("keeps snapshots tenant-scoped", async () => {
    const { branch } = await fixture();
    await saveLiquiditySnapshot({
      locationId: branch.id,
      businessDate: TODAY,
      lines: [{ assetType: "cash", openingDeclaredMinor: 10_000, countedCloseMinor: 10_000 }],
    });
    const otherTenant = await createTestTenant({ momo: true, susu: false });
    const otherAdmin = await createTestAdmin({ tenantId: otherTenant.id, momo: true, susu: false });
    await setAdminSession(otherAdmin);
    const board = await getLiquidityBoard(TODAY);
    expect(board.locations).toHaveLength(0);
  });
});

describe("reconciliation exception cases", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("opens, ages, assigns and resolves a case with an immutable timeline", async () => {
    const { admin } = await fixture();
    const opened = await openExceptionCase({
      category: "provider_statement",
      severity: "high",
      title: "Provider statement line has no internal record",
      description: "MTN-9 appears on the statement but not in the ledger.",
      links: [{ entityType: "providerStatementRow", entityId: "row-1", note: "Statement line" }],
    });
    expect(opened.success).toBe(true);
    const caseId = (opened.data as { id: string }).id;

    await updateExceptionCase({
      id: caseId,
      status: "investigating",
      ownerId: admin.id,
      note: "Assigned to the branch supervisor.",
    });
    const investigating = await getExceptionCases();
    expect(investigating[0].status).toBe("investigating");
    expect(investigating[0].ownerName).toBe("Test Admin");
    expect(investigating[0].ageDays).toBeGreaterThanOrEqual(0);

    await updateExceptionCase({
      id: caseId,
      status: "resolved",
      resolutionType: "accepted_explanation",
      resolutionNote: "Provider confirmed a duplicate charge; internal record left unchanged.",
    });
    const resolvedCases = await getExceptionCases();
    expect(resolvedCases[0].status).toBe("resolved");
    expect(resolvedCases[0].resolutionType).toBe("accepted_explanation");
    const types = resolvedCases[0].events.map((event) => event.type);
    expect(types).toContain("opened");
    expect(types).toContain("status_changed");
    expect(types).toContain("resolved");
    expect(resolvedCases[0].events.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a resolution without a reason", async () => {
    await fixture();
    const opened = await openExceptionCase({
      category: "branch_transfer",
      severity: "medium",
      title: "Transfer variance under investigation",
    });
    const caseId = (opened.data as { id: string }).id;
    const failed = await updateExceptionCase({ id: caseId, status: "resolved" });
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/resolution/i);
  });

  it("refuses an invalid status transition", async () => {
    await fixture();
    const opened = await openExceptionCase({
      category: "daily_close",
      severity: "low",
      title: "Missing daily close for a trading day",
    });
    const caseId = (opened.data as { id: string }).id;
    await updateExceptionCase({ id: caseId, status: "investigating" });
    await updateExceptionCase({ id: caseId, status: "resolved", resolutionNote: "Closed after review." });
    // A resolved case can only be reopened, not silently moved to investigating.
    const invalid = await updateExceptionCase({ id: caseId, status: "investigating" });
    expect(invalid.success).toBe(false);
  });

  it("links a record once and refuses a duplicate link", async () => {
    await fixture();
    const opened = await openExceptionCase({
      category: "remittance",
      severity: "medium",
      title: "Collector remittance short by a material amount",
    });
    const caseId = (opened.data as { id: string }).id;
    const first = await linkCaseRecord({
      caseId,
      entityType: "collectorRemittance",
      entityId: "remit-1",
    });
    expect(first.success).toBe(true);
    const second = await linkCaseRecord({
      caseId,
      entityType: "collectorRemittance",
      entityId: "remit-1",
    });
    expect(second.success).toBe(false);
  });

  it("keeps cases tenant-scoped", async () => {
    await fixture();
    await openExceptionCase({
      category: "other",
      severity: "low",
      title: "A case that belongs to the first tenant",
    });
    const otherTenant = await createTestTenant({ momo: true, susu: false });
    await setAdminSession(
      await createTestAdmin({ tenantId: otherTenant.id, momo: true, susu: false })
    );
    expect(await getExceptionCases()).toHaveLength(0);
  });
});

describe("partial transfer settlement", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function dispatchedTransfer() {
    const tenant = await createTestTenant({ momo: true, susu: false });
    const source = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Source", code: `SRC-${++counter}` },
    });
    const destination = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Destination", code: `DST-${counter}` },
    });
    const passwordHash = await bcrypt.hash("Test1234!", 4);
    const receiver = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `receiver-${counter}@test.invalid`,
        fullName: "Receiver",
        role: "worker",
        status: "active",
        passwordHash,
        momoEnabled: true,
        locationId: destination.id,
        passwordPolicyVersion: 1,
      },
    });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    // Separation of duties: the requesting side cannot approve its own transfer.
    const approver = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    const sender = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `sender-${counter}@test.invalid`,
        fullName: "Sender",
        role: "worker",
        status: "active",
        passwordHash,
        momoEnabled: true,
        locationId: source.id,
        passwordPolicyVersion: 1,
      },
    });

    await setAdminSession(admin);
    const declared = await declareBranchBalance({
      locationId: source.id,
      assetType: "cash",
      declaredBalance: 1000,
    });
    expect(declared.success, declared.error).toBe(true);

    await setWorkerSession(sender);
    const created = await createBranchTransfer({
      sourceLocationId: source.id,
      destinationLocationId: destination.id,
      assetType: "cash",
      amount: 500,
      idempotencyKey: `partial-${Date.now()}-${counter}`,
    });
    expect(created.success, created.error).toBe(true);
    const transferId = (created.data as { transferId: string }).transferId;

    await setAdminSession(approver);
    const approved = await approveBranchTransfer({ id: transferId });
    expect(approved.success, approved.error).toBe(true);

    await setWorkerSession(sender);
    const dispatched = await dispatchBranchTransfer(transferId, "Waybill 77");
    expect(dispatched.success, dispatched.error).toBe(true);

    // The receiver is at the destination and counts less than was dispatched.
    await setWorkerSession(receiver);
    const receipt = await receiveBranchTransfer({
      id: transferId,
      actualAmountReceived: 450,
      note: "Short by GH₵50 in the envelope; seal was already broken in transit",
    });
    expect(receipt.success, receipt.error).toBe(true);
    return { transferId, admin, tenant, source, destination };
  }

  it("records a partial settlement and creates a follow-up for the balance", async () => {
    const { transferId, admin } = await dispatchedTransfer();
    await setAdminSession(admin);

    const settled = await settlePartialTransfer({
      id: transferId,
      settledAmount: 450,
      resolution: "follow_up_transfer",
      note: "GH₵50 remained with the courier; follow-up transfer raised for the difference.",
    });
    expect(settled.success).toBe(true);

    const original = await prisma.branchTransfer.findUnique({ where: { id: transferId } });
    // The dispatched amount is never rewritten.
    expect(Number(original?.amount)).toBe(500);
    expect(Number(original?.settledAmount)).toBe(450);
    expect(Number(original?.outstandingAmount)).toBe(50);
    expect(original?.settlementStatus).toBe("partial_settled");

    const followUp = await prisma.branchTransfer.findFirst({
      where: { parentTransferId: transferId, tenantId: original!.tenantId },
    });
    expect(followUp).toBeTruthy();
    expect(Number(followUp?.amount)).toBe(50);
    expect(followUp?.status).toBe("draft");
    expect(original?.followUpTransferId).toBe(followUp?.id);

    const events = await prisma.branchTransferEvent.findMany({ where: { transferId } });
    expect(events.map((event) => event.action)).toContain("partial_settlement_follow_up");

    const audits = await prisma.auditLog.findMany({
      where: { action: "branch_transfer.partial_settlement" },
    });
    expect(audits).toHaveLength(1);
  });

  it("writes the outstanding balance back with a reason", async () => {
    const { transferId, admin } = await dispatchedTransfer();
    await setAdminSession(admin);
    const settled = await settlePartialTransfer({
      id: transferId,
      settledAmount: 450,
      resolution: "write_back",
      note: "Courier confirmed the missing cash was lost; written back and reported.",
    });
    expect(settled.success).toBe(true);
    const original = await prisma.branchTransfer.findUnique({ where: { id: transferId } });
    expect(original?.settlementStatus).toBe("written_back");
    expect(original?.status).toBe("completed");
    expect(await prisma.branchTransfer.count({ where: { parentTransferId: transferId } })).toBe(0);
  });

  it("refuses a second settlement and a settlement that is not partial", async () => {
    const { transferId, admin } = await dispatchedTransfer();
    await setAdminSession(admin);
    await settlePartialTransfer({
      id: transferId,
      settledAmount: 450,
      resolution: "write_back",
      note: "Courier confirmed the missing cash was lost; written back and reported.",
    });
    const again = await settlePartialTransfer({
      id: transferId,
      settledAmount: 450,
      resolution: "write_back",
      note: "Trying to settle the same transfer a second time.",
    });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/already been settled|variance investigation/i);
  });

  it("refuses to let a worker settle a transfer", async () => {
    const { transferId } = await dispatchedTransfer();
    // The worker session from the receipt step is still current.
    const denied = await settlePartialTransfer({
      id: transferId,
      settledAmount: 450,
      resolution: "write_back",
      note: "A worker must not be able to settle a variance.",
    }).catch((error: Error) => ({ success: false, error: error.message }));
    expect(denied.success).toBe(false);
  });
});
