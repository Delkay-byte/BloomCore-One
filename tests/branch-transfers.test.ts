/**
 * Internal cash/float and branch-transfer acceptance tests (Priority 2).
 *
 * Real server actions, real SQLite test database. The only mocked layers are
 * next/headers, next/navigation and next/cache.
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
  approveBranchTransfer,
  cancelBranchTransfer,
  completeBranchTransfer,
  createBranchTransfer,
  declareBranchBalance,
  dispatchBranchTransfer,
  getBranchTransferBoard,
  getBranchTransferDetail,
  receiveBranchTransfer,
  rejectBranchTransfer,
  resolveBranchTransfer,
} from "@/lib/actions/branch-transfer.actions";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import { loadLocationPositions, loadBranchPositionBoard } from "@/lib/branch-transfers-service";
import {
  assetPosition,
  canTransition,
  computeVariance,
  requiresStepUpForApproval,
  transferAdjustmentFor,
} from "@/lib/branch-transfers";

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
  source: { id: string; name: string };
  destination: { id: string; name: string };
  sourceWorker: { id: string; email: string };
  destinationWorker: { id: string; email: string };
  adminOne: { id: string; email: string };
  adminTwo: { id: string; email: string };
}

let counter = 0;

async function fixture(): Promise<Fixture> {
  counter += 1;
  const tenant = await createTestTenant({ momo: true, susu: false });
  const source = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Main Branch", code: `SRC-${counter}` },
  });
  const destination = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Second Branch", code: `DST-${counter}` },
  });
  const passwordHash = await bcrypt.hash("Test1234!", 4);
  const makeWorker = (name: string, locationId: string) =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `${name}-${counter}@test.invalid`,
        fullName: name,
        role: "worker",
        status: "active",
        passwordHash,
        momoEnabled: true,
        locationId,
        passwordPolicyVersion: 1,
      },
    });
  const sourceWorker = await makeWorker("Source Worker", source.id);
  const destinationWorker = await makeWorker("Destination Worker", destination.id);
  const adminOne = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
  const adminTwo = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
  return { tenant, source, destination, sourceWorker, destinationWorker, adminOne, adminTwo };
}

function transferInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceLocationId: "",
    destinationLocationId: "",
    assetType: "cash",
    amount: 300,
    purpose: "Float top-up",
    idempotencyKey: `trf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

async function declare(f: Fixture, locationId: string, assetType: string, amount: number) {
  await setSession("admin", f.adminOne);
  const result = await declareBranchBalance({
    locationId,
    assetType,
    declaredBalance: amount,
    note: "Synthetic declaration",
  });
  expect(result.success).toBe(true);
}

async function requestedTransfer(f: Fixture, amount = 300) {
  await setSession("momo", f.sourceWorker);
  const created = await createBranchTransfer(
    transferInput({
      sourceLocationId: f.source.id,
      destinationLocationId: f.destination.id,
      amount,
    })
  );
  expect(created.success).toBe(true);
  return (created.data as { transferId: string }).transferId;
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("transfer position rules", () => {
  const base = new Date("2026-11-25T08:00:00.000Z");
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "t1",
    assetType: "cash",
    amount: 100,
    actualAmountReceived: null as number | null,
    status: "requested",
    sourceLocationId: "src",
    destinationLocationId: "dst",
    createdAt: base,
    dispatchedAt: null as Date | null,
    receivedAt: null as Date | null,
    ...overrides,
  });

  it("reserves a requested transfer at the source and releases it when cancelled", () => {
    expect(
      transferAdjustmentFor({ rows: [row()], locationId: "src", assetType: "cash", declaredAt: null })
    ).toEqual({ outbound: 100, inbound: 0, net: -100 });
    expect(
      transferAdjustmentFor({
        rows: [row({ status: "cancelled" })],
        locationId: "src",
        assetType: "cash",
        declaredAt: null,
      }).net
    ).toBe(0);
  });

  it("moves the declared value from source to destination only once received", () => {
    const dispatched = row({ status: "dispatched", dispatchedAt: base });
    expect(
      transferAdjustmentFor({ rows: [dispatched], locationId: "dst", assetType: "cash", declaredAt: null }).net
    ).toBe(0);
    const received = row({
      status: "received",
      dispatchedAt: base,
      receivedAt: new Date(base.getTime() + 3600_000),
      actualAmountReceived: 95,
    });
    expect(
      transferAdjustmentFor({ rows: [received], locationId: "src", assetType: "cash", declaredAt: null }).net
    ).toBe(-100);
    expect(
      transferAdjustmentFor({ rows: [received], locationId: "dst", assetType: "cash", declaredAt: null }).net
    ).toBe(95);
  });

  it("does not apply movements that happened before a new declaration", () => {
    const older = row({
      status: "completed",
      dispatchedAt: new Date(base.getTime() - 3600_000),
      receivedAt: new Date(base.getTime() - 1800_000),
    });
    expect(
      transferAdjustmentFor({ rows: [older], locationId: "src", assetType: "cash", declaredAt: base }).net
    ).toBe(0);
  });

  it("labels a position by the source of its figures", () => {
    expect(
      assetPosition({ assetType: "cash", locationId: "src", declared: null, rows: [] }).source
    ).toBe("no_declared_balance");
    expect(
      assetPosition({
        assetType: "cash",
        locationId: "src",
        declared: { balance: 500, declaredAt: base, declaredById: "u1" },
        rows: [],
      }).source
    ).toBe("manual_declaration");
    expect(
      assetPosition({
        assetType: "cash",
        locationId: "src",
        declared: { balance: 500, declaredAt: base, declaredById: "u1" },
        rows: [row({ createdAt: new Date(base.getTime() + 1000) })],
      })
    ).toMatchObject({ effective: 400, source: "declaration_plus_transfers" });
  });

  it("computes variance and enforces the lifecycle", () => {
    expect(computeVariance(300, 280)).toBe(-20);
    expect(computeVariance(300, 300)).toBe(0);
    expect(canTransition("requested", "approved")).toBe(true);
    expect(canTransition("completed", "approved")).toBe(false);
    expect(requiresStepUpForApproval(99_999)).toBe(false);
    expect(requiresStepUpForApproval(100_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Declarations and tenant isolation
// ---------------------------------------------------------------------------

describe("declared balances", () => {
  it("declares a balance and exposes plainly labelled internal positions", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 1000);

    await setSession("admin", f.adminOne);
    const board = await getBranchTransferBoard();
    const source = board.board.locations.find((row) => row.locationId === f.source.id);
    const cash = source?.assets.find((asset) => asset.assetType === "cash");
    expect(cash).toMatchObject({
      declared: 1000,
      effective: 1000,
      source: "manual_declaration",
    });
    expect(board.board.missingDeclarations).toBeGreaterThan(0);
    expect(board.board.effectiveCashTotal).toBe(1000);
  });

  it("refuses to declare a balance for another tenant's location", async () => {
    const f = await fixture();
    const other = await fixture();
    await setSession("admin", other.adminOne);
    const result = await declareBranchBalance({
      locationId: f.source.id,
      assetType: "cash",
      declaredBalance: 500,
    });
    expect(result.success).toBe(false);
    expect(
      await prisma.branchAssetBalance.count({ where: { locationId: f.source.id } })
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle, separation of duties and availability
// ---------------------------------------------------------------------------

describe("branch transfer lifecycle", () => {
  it("runs requested → approved → dispatched → received → completed and preserves totals", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 1000);
    await declare(f, f.destination.id, "cash", 200);

    const transferId = await requestedTransfer(f, 300);

    // Reservation is visible before approval.
    await setSession("admin", f.adminOne);
    const board = await getBranchTransferBoard();
    const pendingSource = board.board.locations.find((row) => row.locationId === f.source.id);
    expect(pendingSource?.assets.find((asset) => asset.assetType === "cash")?.effective).toBe(700);
    expect(board.counts.awaitingApproval).toBe(1);

    // A different administrator from the requester may approve.
    await setSession("admin", f.adminTwo);
    expect((await approveBranchTransfer({ id: transferId })).success).toBe(true);

    await setSession("momo", f.sourceWorker);
    expect((await dispatchBranchTransfer(transferId)).success).toBe(true);

    await setSession("momo", f.destinationWorker);
    const received = await receiveBranchTransfer({
      id: transferId,
      actualAmountReceived: 300,
      note: "Counted at the counter",
    });
    expect(received.success).toBe(true);
    expect((received.data as { variance: number }).variance).toBe(0);
    expect((await completeBranchTransfer(transferId)).success).toBe(true);

    const sourcePositions = await loadLocationPositions(f.tenant.id, f.source.id);
    const destinationPositions = await loadLocationPositions(f.tenant.id, f.destination.id);
    expect(sourcePositions.find((asset) => asset.assetType === "cash")?.effective).toBe(700);
    expect(destinationPositions.find((asset) => asset.assetType === "cash")?.effective).toBe(500);

    const total = await loadBranchPositionBoard(f.tenant.id);
    expect(total.effectiveCashTotal).toBe(1200);

    const detail = await getBranchTransferDetail(transferId);
    expect(detail?.status).toBe("completed");
    expect(detail?.events.map((event) => event.action)).toEqual([
      "requested",
      "approved",
      "dispatched",
      "received",
      "completed",
    ]);
    expect(detail?.approvedByName).toBe("Test Admin");
  });

  it("refuses self-approval when the requester is also an administrator", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 1000);
    await setSession("admin", f.adminOne);
    const created = await createBranchTransfer(
      transferInput({
        sourceLocationId: f.source.id,
        destinationLocationId: f.destination.id,
        amount: 200,
      })
    );
    expect(created.success).toBe(true);
    const transferId = (created.data as { transferId: string }).transferId;

    const selfApproval = await approveBranchTransfer({ id: transferId });
    expect(selfApproval.success).toBe(false);
    expect(selfApproval.error).toContain("different administrator");

    await setSession("admin", f.adminTwo);
    expect((await approveBranchTransfer({ id: transferId })).success).toBe(true);
  });

  it("refuses to request more than the available declared balance", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 500);
    await setSession("momo", f.sourceWorker);

    const first = await createBranchTransfer(
      transferInput({
        sourceLocationId: f.source.id,
        destinationLocationId: f.destination.id,
        amount: 400,
      })
    );
    expect(first.success).toBe(true);

    // Only 100 remains after the first request reserves 400.
    const second = await createBranchTransfer(
      transferInput({
        sourceLocationId: f.source.id,
        destinationLocationId: f.destination.id,
        amount: 200,
        idempotencyKey: "second-attempt",
      })
    );
    expect(second.success).toBe(false);
    expect(second.error).toContain("not enough");
  });

  it("refuses a transfer when the source has no declaration", async () => {
    const f = await fixture();
    await setSession("momo", f.sourceWorker);
    const result = await createBranchTransfer(
      transferInput({
        sourceLocationId: f.source.id,
        destinationLocationId: f.destination.id,
        amount: 50,
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Declare");
  });

  it("releases the reservation when a request is rejected or cancelled", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 500);
    const rejectedId = await requestedTransfer(f, 200);

    await setSession("admin", f.adminTwo);
    const rejected = await rejectBranchTransfer({
      id: rejectedId,
      reason: "Approved float plan does not include this move.",
    });
    expect(rejected.success).toBe(true);

    const cancelledId = await requestedTransfer(f, 300);
    await setSession("momo", f.sourceWorker);
    expect(
      (await cancelBranchTransfer({ id: cancelledId, reason: "No longer needed today." })).success
    ).toBe(true);

    const positions = await loadLocationPositions(f.tenant.id, f.source.id);
    expect(positions.find((asset) => asset.assetType === "cash")?.effective).toBe(500);
  });

  it("keeps only one of two concurrent full-balance requests", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 1000);
    await setSession("momo", f.sourceWorker);

    const results = await Promise.all([
      createBranchTransfer(
        transferInput({
          sourceLocationId: f.source.id,
          destinationLocationId: f.destination.id,
          amount: 1000,
          idempotencyKey: "concurrent-a",
        })
      ),
      createBranchTransfer(
        transferInput({
          sourceLocationId: f.source.id,
          destinationLocationId: f.destination.id,
          amount: 1000,
          idempotencyKey: "concurrent-b",
        })
      ),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(
      await prisma.branchTransfer.count({
        where: {
          tenantId: f.tenant.id,
          status: { in: ["requested", "approved", "dispatched", "received", "completed"] },
        },
      })
    ).toBe(1);
  });

  it("enforces location roles for dispatch and receipt", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 1000);
    const transferId = await requestedTransfer(f, 100);
    await setSession("admin", f.adminTwo);
    expect((await approveBranchTransfer({ id: transferId })).success).toBe(true);

    // Destination worker cannot dispatch from the source.
    await setSession("momo", f.destinationWorker);
    const wrongDispatch = await dispatchBranchTransfer(transferId);
    expect(wrongDispatch.success).toBe(false);

    await setSession("momo", f.sourceWorker);
    expect((await dispatchBranchTransfer(transferId)).success).toBe(true);

    // Source worker cannot confirm receipt at the destination.
    const wrongReceipt = await receiveBranchTransfer({
      id: transferId,
      actualAmountReceived: 100,
    });
    expect(wrongReceipt.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Variance and high-value approval
// ---------------------------------------------------------------------------

describe("variance, step-up and isolation", () => {
  it("preserves a receipt variance and requires an administrator resolution", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 1000);
    const transferId = await requestedTransfer(f, 400);
    await setSession("admin", f.adminTwo);
    await approveBranchTransfer({ id: transferId });
    await setSession("momo", f.sourceWorker);
    await dispatchBranchTransfer(transferId);

    await setSession("momo", f.destinationWorker);
    const unrecorded = await receiveBranchTransfer({
      id: transferId,
      actualAmountReceived: 380,
      note: "",
    });
    expect(unrecorded.success).toBe(false);
    expect(unrecorded.error).toContain("Explain");

    const received = await receiveBranchTransfer({
      id: transferId,
      actualAmountReceived: 380,
      note: "GH₵20 missing when the bag was counted.",
    });
    expect(received.success).toBe(true);
    expect(received.data).toMatchObject({ variance: -20, status: "variance_investigation" });

    // A variance cannot be completed by the receiver.
    expect((await completeBranchTransfer(transferId)).success).toBe(false);

    const notification = await prisma.tenantNotification.findFirst({
      where: { tenantId: f.tenant.id, dedupeKey: `branch_transfer_variance:${transferId}` },
    });
    expect(notification).not.toBeNull();

    await setSession("admin", f.adminOne);
    const denied = await resolveBranchTransfer({
      id: transferId,
      resolution: "completed",
      note: "Owner accepted the GH₵20 shortage after recount.",
    });
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("Reauthentication");

    const grant = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "finance.branch_transfer.resolve",
      targetType: "branchTransfer",
      targetId: transferId,
      context: { amountMinor: 40000 },
    });
    expect(grant.success).toBe(true);
    const resolved = await resolveBranchTransfer({
      id: transferId,
      resolution: "completed",
      note: "Owner accepted the GH₵20 shortage after recount.",
      stepUpToken: (grant.data as { stepUpToken: string }).stepUpToken,
    });
    expect(resolved.success).toBe(true);

    const detail = await getBranchTransferDetail(transferId);
    expect(detail?.status).toBe("completed");
    expect(detail?.variance).toBe(-20);
    expect(detail?.actualAmountReceived).toBe(380);
    expect(detail?.resolutionNote).toContain("GH₵20");
  });

  it("requires step-up for a high-value approval and refuses without it", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 5000);
    const transferId = await requestedTransfer(f, 1500);

    await setSession("admin", f.adminTwo);
    const denied = await approveBranchTransfer({ id: transferId });
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("Reauthentication");

    const grant = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "finance.branch_transfer.approve",
      targetType: "branchTransfer",
      targetId: transferId,
      context: { amountMinor: 150000 },
    });
    expect(grant.success).toBe(true);
    const approved = await approveBranchTransfer({
      id: transferId,
      stepUpToken: (grant.data as { stepUpToken: string }).stepUpToken,
    });
    expect(approved.success).toBe(true);
  });

  it("isolates transfers across tenants", async () => {
    const f = await fixture();
    const other = await fixture();
    await declare(f, f.source.id, "cash", 1000);
    const transferId = await requestedTransfer(f, 100);

    await setSession("admin", other.adminOne);
    expect(await getBranchTransferDetail(transferId)).toBeNull();
    const approve = await approveBranchTransfer({ id: transferId });
    expect(approve.success).toBe(false);
    const board = await getBranchTransferBoard();
    expect(board.transfers).toHaveLength(0);
  });

  it("is idempotent for a repeated create request", async () => {
    const f = await fixture();
    await declare(f, f.source.id, "cash", 1000);
    await setSession("momo", f.sourceWorker);
    const payload = transferInput({
      sourceLocationId: f.source.id,
      destinationLocationId: f.destination.id,
      amount: 100,
      idempotencyKey: "same-transfer-key",
    });
    const first = await createBranchTransfer(payload);
    const replay = await createBranchTransfer(payload);
    expect(first.success).toBe(true);
    expect(replay.success).toBe(true);
    expect((replay.data as { duplicate?: boolean }).duplicate).toBe(true);
    expect(
      await prisma.branchTransfer.count({ where: { tenantId: f.tenant.id } })
    ).toBe(1);
  });
});
