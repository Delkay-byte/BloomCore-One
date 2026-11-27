/**
 * MaaCash Susu Phase 2 — Collector Management and Field Operations.
 *
 * Covers: collector lifecycle, customer assignment/transfer, period-based
 * performance, follow-up lists, offline capture timestamp and sync attempt
 * tracing. Uses the shared SQLite unit database; each test starts from a clean
 * database.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import { createSessionRecord } from "@/lib/security/session-store";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestTenant,
} from "./setup";
import {
  changeCollectorLifecycleStatus,
  listCollectorsWithLifecycle,
  getCollectorLifecycle,
} from "@/lib/actions/susu-collector-lifecycle";
import {
  assignCustomerToCollector,
  transferCustomerAssignment,
  removeCustomerFromCollector,
  listAssignments,
  getAssignmentHistory,
} from "@/lib/actions/susu-assignment";
import {
  getCollectorPerformance,
  getCollectorFollowUpList,
} from "@/lib/actions/susu-collector-performance";
import { hashStepUpToken, stepUpContextHash, stepUpSessionBinding } from "@/lib/security/step-up";

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

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: {
  id: string;
  tenantId: string | null;
  email: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const tenantId = user.tenantId;
  if (!tenantId) throw new Error("test admin has no tenantId");
  const session = {
    userId: user.id,
    email: user.email,
    fullName: "Admin",
    role: "admin",
    modules: ["susu"],
    tokenVersion: 0,
    jti: `phase2-${now}-${Math.random().toString(16).slice(2)}`,
    iat: now,
  };
  await createSessionRecord({
    id: session.jti,
    subjectType: "user",
    subjectId: user.id,
    tenantId,
    expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT(session)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
  return session;
}

async function setCollectorSession(collectorUserId: string, tenantId: string) {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    userId: collectorUserId,
    email: "collector@test.local",
    fullName: "Collector",
    role: "collector",
    modules: ["susu"],
    tokenVersion: 0,
    jti: `phase2-coll-${now}-${Math.random().toString(16).slice(2)}`,
    iat: now,
  };
  await createSessionRecord({
    id: session.jti,
    subjectType: "user",
    subjectId: collectorUserId,
    tenantId,
    expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-collector-session",
    await new SignJWT(session)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
  return session;
}

async function seedCollectorLifecycleGrant(
  adminId: string,
  session: { jti: string; iat: number },
  targetId: string
) {
  const raw = `phase2-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await prisma.stepUpGrant.create({
    data: {
      tokenHash: hashStepUpToken(raw),
      subjectType: "user",
      subjectId: adminId,
      sessionId: stepUpSessionBinding({ jti: session.jti, iat: session.iat }, adminId),
      purpose: "collector.lifecycle",
      targetType: "collector",
      targetId,
      contextHash: stepUpContextHash({
        purpose: "collector.lifecycle",
        targetType: "collector",
        targetId,
        context: {},
      }),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
  return raw;
}

async function createCollector(adminId: string, status = "active") {
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  const tenantId = admin?.tenantId ?? null;
  const user = await prisma.user.create({
    data: {
      email: `collector-${Date.now()}-${Math.random().toString(36).slice(2)}@bikprestige.com`,
      fullName: "Test Collector",
      role: "collector",
      status,
      passwordHash: "x",
      susuEnabled: true,
      tenantId,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId, userId: user.id, status },
  });
  return { user, collector };
}

async function createAssignedCustomer(
  adminId: string,
  collectorId: string,
  dailyContribution = 50
) {
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  const tenantId = admin?.tenantId ?? null;
  const customer = await prisma.customer.create({
    data: {
      customerId: `BIK-C-${Date.now()}`,
      fullName: "Test Customer",
      status: "active",
      tenantId,
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      accountId: `BIK-S-${Date.now()}`,
      customerId: customer.id,
      dailyContribution,
      status: "active",
      cardCustody: "customer",
      tenantId,
    },
  });
  await prisma.susuCycle.create({
    data: {
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date(),
      endDate: new Date(Date.now() + 86400000 * 31),
      dailyContribution,
      status: "active",
      commissionCharged: false,
      tenantId,
    },
  });
  const assignment = await prisma.collectorCustomerAssignment.create({
    data: {
      tenantId,
      collectorId,
      customerId: customer.id,
      accountId: account.id,
      active: true,
      activeAccountKey: account.id,
    },
  });
  return { customer, account, assignment };
}

describe("Collector lifecycle", () => {
  let adminId: string;
  let adminSession: { jti: string; iat: number } | null = null;

  beforeEach(async () => {
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    adminSession = await setAdminSession(admin);
  });

  it("activates an inactive collector", async () => {
    const { collector } = await createCollector(adminId, "inactive");
    const raw = await seedCollectorLifecycleGrant(
      adminId,
      adminSession!,
      collector.id
    );
    const result = await changeCollectorLifecycleStatus({
      collectorId: collector.id,
      newStatus: "active",
      reason: "Returned from leave",
      stepUpToken: raw,
    });
    expect(result.success).toBe(true);

    const view = await getCollectorLifecycle(collector.id);
    expect(view?.status).toBe("active");
    expect(view?.statusChangedAt).not.toBeNull();
    expect(view?.statusChangedById).toBe(adminId);
  });

  it("deactivates an active collector", async () => {
    const { collector } = await createCollector(adminId, "active");
    const raw = await seedCollectorLifecycleGrant(
      adminId,
      adminSession!,
      collector.id
    );
    const result = await changeCollectorLifecycleStatus({
      collectorId: collector.id,
      newStatus: "inactive",
      reason: "Left the business",
      stepUpToken: raw,
    });
    expect(result.success).toBe(true);

    const view = await getCollectorLifecycle(collector.id);
    expect(view?.status).toBe("inactive");
  });

  it("suspends a collector with a reason", async () => {
    const { collector } = await createCollector(adminId, "active");
    const raw = await seedCollectorLifecycleGrant(
      adminId,
      adminSession!,
      collector.id
    );
    const result = await changeCollectorLifecycleStatus({
      collectorId: collector.id,
      newStatus: "suspended",
      reason: "Pending investigation into missing remittance",
      stepUpToken: raw,
    });
    expect(result.success).toBe(true);

    const view = await getCollectorLifecycle(collector.id);
    expect(view?.status).toBe("suspended");
    expect(view?.statusReason).toContain("investigation");
  });

  it("rejects suspension without a reason", async () => {
    const { collector } = await createCollector(adminId, "active");
    const raw = await seedCollectorLifecycleGrant(
      adminId,
      adminSession!,
      collector.id
    );
    const result = await changeCollectorLifecycleStatus({
      collectorId: collector.id,
      newStatus: "suspended",
      reason: "no",
      stepUpToken: raw,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("5 characters");
  });

  it("does not allow inactive to suspended directly", async () => {
    const { collector } = await createCollector(adminId, "inactive");
    const raw = await seedCollectorLifecycleGrant(
      adminId,
      adminSession!,
      collector.id
    );
    const result = await changeCollectorLifecycleStatus({
      collectorId: collector.id,
      newStatus: "suspended",
      reason: "some reason here",
      stepUpToken: raw,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot move");
  });

  it("lists collectors with lifecycle state", async () => {
    await createCollector(adminId, "active");
    await createCollector(adminId, "suspended");
    const list = await listCollectorsWithLifecycle();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const statuses = new Set(list.map((c) => c.status));
    expect(statuses.has("active")).toBe(true);
    expect(statuses.has("suspended")).toBe(true);
  });
});

describe("Customer assignment integrity", () => {
  let adminId: string;
  let collectorId: string;
  let accountId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    await setAdminSession(admin);
    const { collector } = await createCollector(adminId, "active");
    collectorId = collector.id;
    const { account } = await createAssignedCustomer(adminId, collectorId);
    accountId = account.id;
  });

  it("assigns a customer to a collector", async () => {
    const admin = await prisma.user.findUnique({ where: { id: adminId } });
    const tenantId = admin?.tenantId ?? null;
    const customer = await prisma.customer.create({
      data: {
        customerId: `BIK-C-${Date.now()}`,
        fullName: "Unassigned Customer",
        status: "active",
        tenantId,
      },
    });
    const account = await prisma.susuAccount.create({
      data: {
        accountId: `BIK-S-${Date.now()}`,
        customerId: customer.id,
        dailyContribution: 50,
        status: "active",
        cardCustody: "customer",
        tenantId,
      },
    });
    await prisma.susuCycle.create({
      data: {
        accountId: account.id,
        cycleNumber: 1,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 31),
        dailyContribution: 50,
        status: "active",
        commissionCharged: false,
        tenantId,
      },
    });
    const result = await assignCustomerToCollector({
      collectorId,
      customerId: customer.id,
      accountId: account.id,
    });
    expect(result.success).toBe(true);

    const assignments = await listAssignments({ accountId: account.id, activeOnly: true });
    expect(assignments.length).toBe(1);
    expect(assignments[0].collectorId).toBe(collectorId);
  });

  it("prevents assigning to an inactive collector", async () => {
    const { collector: inactive } = await createCollector(adminId, "inactive");
    const { account: acct } = await createAssignedCustomer(adminId, inactive.id);
    const result = await assignCustomerToCollector({
      collectorId: inactive.id,
      customerId: (await prisma.customer.findUnique({ where: { id: acct.customerId } }))!.id,
      accountId: acct.id,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot receive new assignments");
  });

  it("prevents a second active assignment for the same account", async () => {
    const { collector: other } = await createCollector(adminId, "active");
    const { account: acct } = await createAssignedCustomer(adminId, other.id);
    const result = await assignCustomerToCollector({
      collectorId,
      customerId: (await prisma.customer.findUnique({ where: { id: acct.customerId } }))!.id,
      accountId: acct.id,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("already");
  });

  it("transfers an account atomically between collectors", async () => {
    const { collector: newCollector } = await createCollector(adminId, "active");
    const { account: acct, customer } = await createAssignedCustomer(
      adminId,
      collectorId,
      50
    );
    // deactivate the old assignment first so `accountId` has one active assignment from collectorId
    await removeCustomerFromCollector({ assignmentId: (await listAssignments({ accountId: acct.id, activeOnly: true }))[0].id });

    // re-assign to collectorId
    await assignCustomerToCollector({
      collectorId,
      customerId: customer.id,
      accountId: acct.id,
    });

    const result = await transferCustomerAssignment({
      collectorId: newCollector.id,
      customerId: customer.id,
      accountId: acct.id,
      fromCollectorId: collectorId,
      reason: "Collector relocated to another zone",
    });
    expect(result.success).toBe(true);

    const current = await listAssignments({ accountId: acct.id, activeOnly: true });
    expect(current.length).toBe(1);
    expect(current[0].collectorId).toBe(newCollector.id);

    const history = await getAssignmentHistory(acct.id);
    expect(history).not.toBeNull();
    expect(history!.some((h) => h.kind === "transferred")).toBe(true);
    expect(history!.some((h) => h.previousCollectorId === collectorId)).toBe(true);
    expect(history!.some((h) => h.newCollectorId === newCollector.id)).toBe(true);
  });

  it("requires a transfer reason of at least 5 characters", async () => {
    const { collector: newCollector } = await createCollector(adminId, "active");
    const result = await transferCustomerAssignment({
      collectorId: newCollector.id,
      customerId: "x",
      accountId,
      fromCollectorId: collectorId,
      reason: "no",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("5 characters");
  });

  it("rejects a transfer not initiated against the current active collector", async () => {
    const admin = await prisma.user.findUnique({ where: { id: adminId } });
    const tenantId = admin?.tenantId ?? null;
    const customer = await prisma.customer.create({
      data: {
        customerId: `BIK-C-${Date.now()}`,
        fullName: "Transfer Test Customer",
        status: "active",
        tenantId,
      },
    });
    const account = await prisma.susuAccount.create({
      data: {
        accountId: `BIK-S-${Date.now()}`,
        customerId: customer.id,
        dailyContribution: 50,
        status: "active",
        cardCustody: "customer",
        tenantId,
      },
    });
    await prisma.susuCycle.create({
      data: {
        accountId: account.id,
        cycleNumber: 1,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000 * 31),
        dailyContribution: 50,
        status: "active",
        commissionCharged: false,
        tenantId,
      },
    });
    // Assign it to collectorId so there IS a current active assignment.
    await assignCustomerToCollector({ collectorId, customerId: customer.id, accountId: account.id });

    const { collector: other } = await createCollector(adminId, "active");
    // Initiate the transfer against a wrong collector that is not the current one.
    const { collector: wrong } = await createCollector(adminId, "active");
    const result = await transferCustomerAssignment({
      collectorId: other.id,
      customerId: customer.id,
      accountId: account.id,
      fromCollectorId: wrong.id,
      reason: "some reason here",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("current active collector");
  });

  it("preserves assignment history on removal", async () => {
    const { assignment } = await createAssignedCustomer(adminId, collectorId);
    const result = await removeCustomerFromCollector({
      assignmentId: assignment.id,
      reason: "Customer moved out of zone",
    });
    expect(result.success).toBe(true);

    const current = await listAssignments({ accountId: assignment.accountId, activeOnly: true });
    expect(current.length).toBe(0);

    const history = await getAssignmentHistory(assignment.accountId);
    expect(history).not.toBeNull();
    expect(history!.some((h) => h.kind === "unassigned")).toBe(true);
  });
});

describe("Period-based performance", () => {
  let adminId: string;
  let collectorId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    await setAdminSession(admin);
    const { collector } = await createCollector(adminId, "active");
    collectorId = collector.id;
  });

  it("computes daily totals excluding reversed contributions", async () => {
    const { account } = await createAssignedCustomer(adminId, collectorId, 50);
    const customerId = account.customerId;

    await prisma.contribution.create({
      data: {
        tenantId: (await prisma.user.findUnique({ where: { id: adminId } }))!.tenantId!,
        accountId: account.id,
        cycleId: (await prisma.susuCycle.findFirst({ where: { accountId: account.id } }))!.id,
        amount: 150,
        channel: "collector",
        collectorId,
        recordedById: adminId,
        referenceId: `CON-${Date.now()}-a`,
        collectionDate: new Date(),
        reversedAt: null,
      },
    });
    await prisma.contribution.create({
      data: {
        tenantId: (await prisma.user.findUnique({ where: { id: adminId } }))!.tenantId!,
        accountId: account.id,
        cycleId: (await prisma.susuCycle.findFirst({ where: { accountId: account.id } }))!.id,
        amount: 50,
        channel: "collector",
        collectorId,
        recordedById: adminId,
        referenceId: `CON-${Date.now()}-b`,
        collectionDate: new Date(),
        reversedAt: new Date(),
      },
    });

    const perf = await getCollectorPerformance({
      collectorId,
      period: "daily",
    });
    expect(perf.totalCollected).toBe(150);
    expect(perf.transactionCount).toBe(1);
    expect(perf.customersServed).toBe(1);
    expect(perf.reversedExcluded.count).toBe(1);
    expect(perf.reversedExcluded.amount).toBe(50);
    expect(perf.collectorActivityStatus).toBe("active");
    expect(Array.isArray(perf.trend)).toBe(true);
  });

  it("supports weekly, monthly and custom periods", async () => {
    for (const period of ["weekly", "monthly", "custom"] as const) {
      const perf = await getCollectorPerformance({
        collectorId,
        period,
        ...(period === "custom"
          ? { dateFrom: "2026-01-01", dateTo: "2026-01-31" }
          : {}),
      });
      expect(perf.period).toBe(period);
      expect(typeof perf.totalCollected).toBe("number");
      expect(perf.assignedCustomers).toBe(0);
    }
  });

  it("lists customers requiring follow-up", async () => {
    const { account, customer } = await createAssignedCustomer(adminId, collectorId, 50);
    const list = await getCollectorFollowUpList({
      collectorId,
      period: "daily",
    });
    expect(Array.isArray(list)).toBe(true);
    expect(list[0]?.customerId).toBe(customer.customerId);
    expect(list[0]?.daysOutstanding).toBeGreaterThan(0);
  });

  it("collector cannot view another collector's performance", async () => {
    const { collector: me, user: meUser } = await createCollector(adminId, "active");
    const { collector: other } = await createCollector(adminId, "active");
    const tenantId = (
      await prisma.user.findUnique({ where: { id: adminId } })
    )?.tenantId!;
    await setCollectorSession(meUser.id, tenantId);
    await expect(
      getCollectorPerformance({ collectorId: other.id, period: "daily" })
    ).rejects.toThrow();
  });
});

describe("Offline capture timestamp", () => {
  it("normalizes and stores an optional capturedAt", async () => {
    const { normalizeContributionPayload, canonicalContributionPayload } =
      await import("@/lib/offline/payload");

    const withTime = normalizeContributionPayload({
      accountId: "acc-1",
      amount: 100,
      channel: "collector",
      notes: null,
      collectorId: "col-1",
      // A recent capture time, inside the 30-day validation window.
      capturedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });

    const withoutTime = normalizeContributionPayload({
      accountId: "acc-1",
      amount: 100,
      channel: "collector",
      notes: null,
      collectorId: null,
    });
    expect(withTime.ok).toBe(true);
    if (withTime.ok) {
      const canon = canonicalContributionPayload(withTime.payload);
      expect(canon).toContain("capturedAt");
    }
    expect(withoutTime.ok).toBe(true);
    if (withoutTime.ok) {
      expect(withoutTime.payload.capturedAt).toBeNull();
    }

    const future = normalizeContributionPayload({
      accountId: "acc-1",
      amount: 100,
      channel: "collector",
      notes: null,
      collectorId: null,
      capturedAt: new Date(Date.now() + 86400000 * 40).toISOString(),
    });
    expect(future.ok).toBe(false);
  });
});
