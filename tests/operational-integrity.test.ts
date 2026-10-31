/**
 * BIK Prestige Enterprise — Susu Operational Integrity Tests
 *
 * These tests exercise the REAL server actions (not mirror implementations):
 *   - getCollectorDashboardStats      (collector cash accountability)
 *   - getSusuDashboardStats           (admin totals + pending money handed in)
 *   - getAdminCollectorBreakdown      (per-collector cash breakdown)
 *   - recordContribution              (real contribution recording)
 *   - recordRemittance                (real hand-in recording)
 *   - registerCustomerByCollector     (collector customer registration)
 *   - searchStaff / searchCustomers   (case-insensitive smart search)
 *
 * Authentication is real too: JWTs are signed with the test JWT_SECRET and
 * placed in the module cookie jar (bik-admin-session / bik-collector-session),
 * which is the only mocked layer (next/headers, next/navigation, next/cache).
 *
 * Scenarios mandated by the pilot requirements:
 *   - Empty data: collector with zero collections still gets a full zeroed
 *     dashboard object (cards must render with GH₵0.00).
 *   - Sample data: Kofi 50 + 100 + 350 = 500; hand-ins 400 then 100.
 *   - Advance payment: GH₵350 for a GH₵50/day customer stays GH₵350.
 *   - Office payment isolation: office GH₵200 must not leak into a
 *     collector's Expected to Bring In.
 *   - Admin Pending Money Handed In: SUM of max(Difference, 0) per collector
 *     — no offsetting a shortage with another collector's overage.
 *   - Received By is a dynamic staff selection; Recorded By is session-derived
 *     and cannot be overridden from the browser.
 *   - Collector customer registration: server-side IDs, auto-assignment,
 *     card fee, admin visibility, audit trail.
 *   - Smart search is case-insensitive across name/email/phone.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
} from "./setup";

// ---------------------------------------------------------------------------
// Auth plumbing: real JWT + mocked cookie jar only
// ---------------------------------------------------------------------------

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => {
      mockCookieStore.set(name, value);
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

// Real server actions
import {
  getCollectorDashboardStats,
  getSusuDashboardStats,
  getAdminCollectorBreakdown,
} from "../src/lib/actions/susu-dashboard.actions";
import { recordContribution } from "../src/lib/actions/susu-contribution.actions";
import {
  recordRemittance,
  registerCustomerByCollector,
} from "../src/lib/actions/susu-collector.actions";
import { searchCustomers, searchStaff } from "../src/lib/actions/susu-customer.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function setAdminSession(userId: string) {
  mockCookieStore.set(
    "bik-admin-session",
    await signToken({
      userId,
      email: "admin@test.com",
      fullName: "Test Admin",
      role: "admin",
      modules: [],
      tokenVersion: 0,
    })
  );
  mockCookieStore.delete("bik-collector-session");
}

async function setCollectorSession(userId: string) {
  mockCookieStore.set(
    "bik-collector-session",
    await signToken({
      userId,
      email: "collector@test.com",
      fullName: "Test Collector",
      role: "collector",
      modules: ["susu"],
      tokenVersion: 0,
    })
  );
  mockCookieStore.delete("bik-admin-session");
}

async function tenantOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!u?.tenantId) throw new Error("fixture user has no tenant");
  return u.tenantId;
}

async function createCollectorUser(fullName: string, tenantId: string) {
  const user = await prisma.user.create({
    data: {
      email: `${fullName.replace(/\s+/g, ".").toLowerCase()}.${Date.now()}@bikprestige.com`,
      fullName,
      role: "collector",
      status: "active",
      passwordHash: "test-hash",
      susuEnabled: true,
      tenantId,
    },
  });
  const collector = await prisma.collector.create({
    data: { userId: user.id, status: "active", tenantId },
  });
  return { user, collector };
}

/**
 * A user whose PRIMARY role is "worker" but who has been granted the Susu
 * collector capability (susuEnabled + an active Collector record) — exactly
 * how the admin "Susu (collector)" toggle on /admin/workers/[id] provisions a
 * collector. This is the account shape that previously hit the false
 * "Only collectors can register customers" error.
 */
async function createSusuWorkerUser(fullName: string, tenantId: string) {
  const user = await prisma.user.create({
    data: {
      email: `${fullName.replace(/\s+/g, ".").toLowerCase()}.${Date.now()}@bikprestige.com`,
      fullName,
      role: "worker",
      status: "active",
      passwordHash: "test-hash",
      susuEnabled: true,
      momoEnabled: true,
      tenantId,
    },
  });
  const collector = await prisma.collector.create({
    data: { userId: user.id, status: "active", tenantId },
  });
  return { user, collector };
}

async function createWorkerUser(fullName: string, tenantId: string) {
  return prisma.user.create({
    data: {
      email: `${fullName.replace(/\s+/g, ".").toLowerCase()}.${Date.now()}@bikprestige.com`,
      fullName,
      role: "worker",
      status: "active",
      passwordHash: "test-hash",
      tenantId,
    },
  });
}

async function assignToCollector(
  collectorId: string,
  customerId: string,
  accountId: string
) {
  const collector = await prisma.collector.findUnique({
    where: { id: collectorId },
    select: { tenantId: true },
  });
  return prisma.collectorCustomerAssignment.create({
    data: { collectorId, customerId, accountId, active: true, tenantId: collector?.tenantId ?? null },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Operational Integrity — Collector Dashboard Cash Accountability", () => {
  let adminId: string;
  let collectorUser: { id: string };
  let collector: { id: string };

  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    const c = await createCollectorUser("Kofi Asamoah", admin.tenantId!);
    collectorUser = c.user;
    collector = c.collector;
  });

  it("empty data: zero collections still returns a full zeroed dashboard object", async () => {
    await setCollectorSession(collectorUser.id);

    const stats = await getCollectorDashboardStats(collectorUser.id);

    // MUST NOT be null — the dashboard cards render only when an object exists
    expect(stats).not.toBeNull();
    expect(stats!.todayContributions).toBe(0);
    expect(stats!.expectedToBringIn).toBe(0);
    expect(stats!.amountHandedInToday).toBe(0);
    expect(stats!.difference).toBe(0);
    expect(stats!.customersCollected).toBe(0);
    expect(stats!.customersRemaining).toBe(0);
  });

  it("sample data: 50 + 100 + 350 = 500; hand-ins 400 then 100 reconcile to zero", async () => {
    const { account, cycle } = await createTestCustomer(adminId, 50, "KOFI1");
    await assignToCollector(collector.id, account.customerId, account.id);

    await setCollectorSession(collectorUser.id);
    await recordContribution({
      accountId: account.id,
      amount: 50,
      channel: "collector",
    });
    await recordContribution({
      accountId: account.id,
      amount: 100,
      channel: "collector",
    });
    await recordContribution({
      accountId: account.id,
      amount: 350,
      channel: "collector",
    });

    let stats = await getCollectorDashboardStats(collectorUser.id);
    expect(stats!.todayContributions).toBe(500);
    expect(stats!.expectedToBringIn).toBe(500);
    expect(stats!.amountHandedInToday).toBe(0);
    expect(stats!.difference).toBe(500);

    // Hand in GH₵400
    await setAdminSession(adminId);
    await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 400,
    });

    await setCollectorSession(collectorUser.id);
    stats = await getCollectorDashboardStats(collectorUser.id);
    expect(stats!.todayContributions).toBe(500);
    expect(stats!.expectedToBringIn).toBe(500);
    expect(stats!.amountHandedInToday).toBe(400);
    expect(stats!.difference).toBe(100);

    // Hand in the remaining GH₵100
    await setAdminSession(adminId);
    await recordRemittance({
      collectorId: collector.id,
      remittedAmount: 100,
    });

    await setCollectorSession(collectorUser.id);
    stats = await getCollectorDashboardStats(collectorUser.id);
    expect(stats!.todayContributions).toBe(500);
    expect(stats!.expectedToBringIn).toBe(500);
    expect(stats!.amountHandedInToday).toBe(500);
    expect(stats!.difference).toBe(0);

    // The cycle allocations must exist (financial side-effect)
    const allocations = await prisma.contributionAllocation.count({
      where: { contribution: { cycleId: cycle.id } },
    });
    expect(allocations).toBe(10); // 50(1d) + 100(2d) + 350(7d)
  });

  it("advance payment: GH₵350 received for a GH₵50/day customer stays GH₵350", async () => {
    const { account } = await createTestCustomer(adminId, 50, "ADV1");
    await assignToCollector(collector.id, account.customerId, account.id);

    await setCollectorSession(collectorUser.id);
    const result = await recordContribution({
      accountId: account.id,
      amount: 350,
      channel: "collector",
    });
    expect(result.success).toBe(true);

    const stats = await getCollectorDashboardStats(collectorUser.id);
    expect(stats!.todayContributions).toBe(350); // NOT reduced to 50
    expect(stats!.expectedToBringIn).toBe(350);
  });

  it("office payment isolation: office GH₵200 does not affect collector Expected to Bring In", async () => {
    // Office payment of GH₵200 (customer A) + collector payment of GH₵300 (customer B)
    const officeCustomer = await createTestCustomer(adminId, 50, "OFF1");
    const collectorCustomer = await createTestCustomer(adminId, 50, "COL1");
    await assignToCollector(collector.id, collectorCustomer.account.customerId, collectorCustomer.account.id);

    // Office records GH₵200 for its own customer
    await setAdminSession(adminId);
    await recordContribution({
      accountId: officeCustomer.account.id,
      amount: 200,
      channel: "direct_office",
    });

    // Collector records GH₵300
    await setCollectorSession(collectorUser.id);
    await recordContribution({
      accountId: collectorCustomer.account.id,
      amount: 300,
      channel: "collector",
    });

    // Platform-wide total includes BOTH channels
    await setAdminSession(adminId);
    const adminStats = await getSusuDashboardStats();
    expect(adminStats.todayContributions).toBe(500);

    // Collector sees ONLY his own GH₵300
    await setCollectorSession(collectorUser.id);
    const stats = await getCollectorDashboardStats(collectorUser.id);
    expect(stats!.todayContributions).toBe(300);
    expect(stats!.expectedToBringIn).toBe(300);

    // Admin per-collector breakdown agrees
    await setAdminSession(adminId);
    const breakdown = await getAdminCollectorBreakdown();
    const kofi = breakdown.find((b) => b.collectorId === collector.id);
    expect(kofi!.todayContributions).toBe(300);
    expect(kofi!.expectedToBringIn).toBe(300);
  });

  it("admin Pending Money Handed In = SUM(max(Difference, 0)) — no offsetting", async () => {
    // Kofi: expected 500, handed 400 → shortage 100
    // Ama:  expected 300, handed 500 → overage 200
    const kofiCustomer = await createTestCustomer(adminId, 50, "PEN1");
    await assignToCollector(collector.id, kofiCustomer.account.customerId, kofiCustomer.account.id);

    const ama = await createCollectorUser("Ama Serwaa", await tenantOf(adminId));
    const amaCustomer = await createTestCustomer(adminId, 50, "PEN2");
    await assignToCollector(ama.collector.id, amaCustomer.account.customerId, amaCustomer.account.id);

    // Kofi collects 500
    await setCollectorSession(collectorUser.id);
    await recordContribution({ accountId: kofiCustomer.account.id, amount: 500, channel: "collector" });

    // Ama collects 300 and hands in 500 (overage)
    await setCollectorSession(ama.user.id);
    await recordContribution({ accountId: amaCustomer.account.id, amount: 300, channel: "collector" });
    await setAdminSession(adminId);
    await recordRemittance({ collectorId: ama.collector.id, remittedAmount: 500 });

    // Kofi hands in only 400
    await recordRemittance({ collectorId: collector.id, remittedAmount: 400 });

    const adminStats = await getSusuDashboardStats();
    // Shortage of 100 must NOT be cancelled by Ama's 200 overage
    expect(adminStats.pendingMoneyHandedIn).toBe(100);

    const breakdown = await getAdminCollectorBreakdown();
    const kofiRow = breakdown.find((b) => b.collectorId === collector.id)!;
    const amaRow = breakdown.find((b) => b.collectorId === ama.collector.id)!;
    expect(kofiRow.difference).toBe(100);
    expect(amaRow.difference).toBe(-200);
  });

  it("collector channel attribution comes from the session, never the browser", async () => {
    const otherCollector = await createCollectorUser("Other Collector", await tenantOf(adminId));
    const { account } = await createTestCustomer(adminId, 50, "ATTR1");
    await assignToCollector(collector.id, account.customerId, account.id);

    await setCollectorSession(collectorUser.id);
    // Attempt to attribute the contribution to ANOTHER collector
    const result = await recordContribution({
      accountId: account.id,
      amount: 100,
      channel: "collector",
      collectorId: otherCollector.collector.id, // must be ignored
    });
    expect(result.success).toBe(true);

    const contribution = await prisma.contribution.findFirst({
      where: { accountId: account.id },
    });
    expect(contribution!.collectorId).toBe(collector.id);
    expect(contribution!.recordedById).toBe(collectorUser.id);

    // The other collector must see nothing
    await setCollectorSession(otherCollector.user.id);
    const otherStats = await getCollectorDashboardStats(otherCollector.user.id);
    expect(otherStats!.todayContributions).toBe(0);
  });

  it("module-based collector (worker role + susu capability) can record collections", async () => {
    const { user, collector } = await createSusuWorkerUser("David Asamoah", await tenantOf(adminId));
    const { account } = await createTestCustomer(adminId, 50, "MOD1");
    await assignToCollector(collector.id, account.customerId, account.id);

    await setCollectorSession(user.id);
    // Injected collectorId must be ignored — attribution comes from the session
    const result = await recordContribution({
      accountId: account.id,
      amount: 350,
      channel: "collector",
      collectorId: collectorUser.id, // bogus — must be ignored
    });
    expect(result.success).toBe(true);

    const contribution = await prisma.contribution.findFirst({
      where: { accountId: account.id },
    });
    expect(contribution!.collectorId).toBe(collector.id);
    expect(contribution!.recordedById).toBe(user.id);

    // Dashboard resolves the same collector
    const stats = await getCollectorDashboardStats(user.id);
    expect(stats!.todayContributions).toBe(350);
    expect(stats!.expectedToBringIn).toBe(350);
  });

  it("leftover collector cookie never shadows the admin's Recorded By", async () => {
    // Browser holds BOTH an admin session and a stale collector session.
    const { user: david } = await createSusuWorkerUser("David Asamoah", await tenantOf(adminId));
    const ama = await createWorkerUser("Ama Serwaa", await tenantOf(adminId));
    const { account } = await createTestCustomer(adminId, 50, "SHAD1");

    await setAdminSession(adminId);
    // Simulate a stale collector cookie left in the same browser — the admin
    // session must still win. (Deliberately NOT using setCollectorSession,
    // which clears the admin cookie.)
    mockCookieStore.set(
      "bik-collector-session",
      await signToken({
        userId: david.id,
        email: "david@bikprestige.com",
        fullName: "David Asamoah",
        role: "worker",
        modules: ["momo", "susu"],
        tokenVersion: 0,
      })
    );

    const result = await recordContribution({
      accountId: account.id,
      amount: 100,
      channel: "direct_office",
      receivedById: ama.id,
    });
    expect(result.success).toBe(true);

    const contribution = await prisma.contribution.findFirst({
      where: { accountId: account.id },
    });
    // Received By = the staff who physically received; Recorded By = the admin
    expect(contribution!.receivedById).toBe(ama.id);
    expect(contribution!.recordedById).toBe(adminId);
    expect(contribution!.collectorId).toBeNull();
  });
});

describe("Operational Integrity — Received By / Recorded By", () => {
  let adminId: string;
  let collectorUser: { id: string };
  let collector: { id: string };

  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    const c = await createCollectorUser("Kofi Asamoah", admin.tenantId!);
    collectorUser = c.user;
    collector = c.collector;
  });

  it("direct office: Received By = selected staff, Recorded By = authenticated admin", async () => {
    const ama = await createWorkerUser("Ama Serwaa", await tenantOf(adminId));
    const { account } = await createTestCustomer(adminId, 50, "RB1");

    await setAdminSession(adminId);
    const result = await recordContribution({
      accountId: account.id,
      amount: 100,
      channel: "direct_office",
      receivedById: ama.id, // Ama physically receives the money
    });
    expect(result.success).toBe(true);

    const contribution = await prisma.contribution.findFirst({
      where: { accountId: account.id },
    });
    expect(contribution!.receivedById).toBe(ama.id); // Ama
    expect(contribution!.recordedById).toBe(adminId); // Saviour (session)
    expect(contribution!.collectorId).toBeNull(); // office channel has no collector
  });

  it("direct office: editable Recorded By name is stored, recordedById stays session-anchored", async () => {
    // The business types the actual recorder's name into Recorded By; the
    // audit anchor (recordedById) must remain the authenticated account and
    // can never be set from the browser.
    const { account } = await createTestCustomer(adminId, 50, "RB4");

    await setAdminSession(adminId);
    const result = await recordContribution({
      accountId: account.id,
      amount: 100,
      channel: "direct_office",
      recordedByName: "Ama Serwaa", // typed by the person entering the data
    });
    expect(result.success).toBe(true);

    const contribution = await prisma.contribution.findFirst({
      where: { accountId: account.id },
    });
    expect(contribution!.recordedByName).toBe("Ama Serwaa");
    expect(contribution!.recordedById).toBe(adminId); // session, not the typed name
  });

  it("collector channel: receivedById from the browser is ignored; session collector is recorded", async () => {
    const ama = await createWorkerUser("Ama Serwaa", await tenantOf(adminId));
    const { account } = await createTestCustomer(adminId, 50, "RB2");
    await assignToCollector(collector.id, account.customerId, account.id);

    await setCollectorSession(collectorUser.id);
    // A collector cannot set receivedById — office-only field
    const result = await recordContribution({
      accountId: account.id,
      amount: 100,
      channel: "collector",
      receivedById: ama.id,
    });
    expect(result.success).toBe(true);

    const contribution = await prisma.contribution.findFirst({
      where: { accountId: account.id },
    });
    expect(contribution!.receivedById).toBeNull();
    expect(contribution!.recordedById).toBe(collectorUser.id);
    expect(contribution!.collectorId).toBe(collector.id);
  });

  it("receivedById must reference a real active staff member", async () => {
    const { account } = await createTestCustomer(adminId, 50, "RB3");

    await setAdminSession(adminId);
    const result = await recordContribution({
      accountId: account.id,
      amount: 100,
      channel: "direct_office",
      receivedById: "does-not-exist",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("staff member not found");
  });
});

describe("Operational Integrity — Collector Customer Registration", () => {
  let adminId: string;
  let collectorUser: { id: string };
  let collector: { id: string };

  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    const c = await createCollectorUser("Kofi Asamoah", admin.tenantId!);
    collectorUser = c.user;
    collector = c.collector;
  });

  it("registers a customer with server-side IDs, auto-assignment, card fee, audit, and admin visibility", async () => {
    await setCollectorSession(collectorUser.id);

    const before = await prisma.customer.count();
    const result = await registerCustomerByCollector({
      fullName: "Efua Mensah",
      phone: "+233241234567",
      dailyContribution: 50,
      cardFee: 10,
    });
    expect(result.success).toBe(true);

    const data = result.data as {
      customer: { customerId: string; fullName: string };
      susuAccount: { accountId: string };
      collectorId: string;
    };
    expect(data.customer.fullName).toBe("Efua Mensah");
    expect(data.customer.customerId).toMatch(/^BIK-C-\d{6}$/);
    expect(data.susuAccount.accountId).toMatch(/^BIK-S-\d{6}$/);
    expect(data.collectorId).toBe(collector.id); // auto-assigned from session

    // Susu account + active cycle + card fee + assignment
    const customer = await prisma.customer.findUnique({
      where: { customerId: data.customer.customerId },
      include: {
        accounts: {
          include: { cycles: true, cardFees: true, assignments: true },
        },
      },
    });
    expect(customer!.accounts).toHaveLength(1);
    expect(customer!.accounts[0].cycles).toHaveLength(1);
    expect(customer!.accounts[0].cardFees).toHaveLength(1);
    expect(Number(customer!.accounts[0].cardFees[0].amount)).toBe(10);
    expect(customer!.accounts[0].assignments[0].collectorId).toBe(collector.id);
    expect(customer!.accounts[0].assignments[0].active).toBe(true);

    // Customer appears in the collector's route immediately
    const stats = await getCollectorDashboardStats(collectorUser.id);
    expect(stats!.customersRemaining).toBe(1);
    expect(stats!.toVisit[0].customerName).toBe("Efua Mensah");

    // Audit records the collector as creator
    const audit = await prisma.auditLog.findFirst({
      where: { action: "susu.customer_created_by_collector" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(collectorUser.id);

    // Admin sees the new customer
    await setAdminSession(adminId);
    const total = await prisma.customer.count();
    expect(total).toBe(before + 1);
  });

  it("rejects a non-collector session (admin) with a clear message", async () => {
    await setAdminSession(adminId);
    const result = await registerCustomerByCollector({
      fullName: "Nope",
      dailyContribution: 50,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Only Susu collectors can register customers.");
  });

  it("rejects an unauthenticated request with 'Please sign in again.'", async () => {
    mockCookieStore.clear();
    const result = await registerCustomerByCollector({
      fullName: "Nope",
      dailyContribution: 50,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Please sign in again.");
  });

  it("rejects a MoMo-only worker", async () => {
    const worker = await prisma.user.create({
      data: {
        email: `momo-only-${Date.now()}@bikprestige.com`,
        fullName: "MoMo Only",
        role: "worker",
        status: "active",
        passwordHash: "test-hash",
        momoEnabled: true,
        susuEnabled: false,
        tenantId: await tenantOf(adminId),
      },
    });
    mockCookieStore.set(
      "bik-worker-session",
      await signToken({
        userId: worker.id,
        email: worker.email,
        fullName: worker.fullName,
        role: "worker",
        modules: ["momo"],
        tokenVersion: 0,
      })
    );
    mockCookieStore.delete("bik-admin-session");
    mockCookieStore.delete("bik-collector-session");

    const result = await registerCustomerByCollector({
      fullName: "Nope",
      dailyContribution: 50,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Only Susu collectors can register customers.");
  });

  it("module-based collector (worker role + susu capability) can register a customer", async () => {
    // Same account shape as David Asamoah: primary role "worker", granted Susu
    // capability via susuEnabled + active Collector record.
    const { user, collector } = await createSusuWorkerUser("David Asamoah", await tenantOf(adminId));
    await setCollectorSession(user.id);

    const result = await registerCustomerByCollector({
      fullName: "Efua Mensah",
      phone: "+233241234567",
      dailyContribution: 50,
      cardFee: 10,
    });
    expect(result.success).toBe(true);

    const data = result.data as {
      customer: { customerId: string };
      susuAccount: { accountId: string };
      collectorId: string;
    };
    expect(data.customer.customerId).toMatch(/^BIK-C-\d{6}$/);
    expect(data.collectorId).toBe(collector.id); // auto-assigned from session
  });
});

describe("Operational Integrity — Case-Insensitive Smart Search", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
  });

  it("searchStaff matches kofi / Kofi / KOFI / KoFi identically", async () => {
    const admin = await createTestAdmin();
    await createCollectorUser("Kofi Asamoah", admin.tenantId!);
    await createWorkerUser("Ama Serwaa", admin.tenantId!);

    await setAdminSession(admin.id);

    const queries = ["kofi", "Kofi", "KOFI", "KoFi"];
    const results = await Promise.all(
      queries.map((q) => searchStaff(q))
    );

    const ids = results.map((r) => r.map((x) => x.id).sort().join(","));
    expect(ids[0]).not.toBe("");
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[0]);
    }
    expect(results[0].some((r) => r.label === "Kofi Asamoah")).toBe(true);
  });

  it("searchStaff matches email and phone case-insensitively", async () => {
    const admin = await createTestAdmin();
    const staff = await prisma.user.create({
      data: {
        email: "Yaa.Addo@BikPrestige.com",
        fullName: "Yaa Addo",
        phone: "+233 55 123 4567",
        role: "worker",
        status: "active",
        passwordHash: "test-hash",
        tenantId: admin.tenantId,
      },
    });

    await setAdminSession(admin.id);
    const byEmail = await searchStaff("YAA.ADDO");
    const byPhone = await searchStaff("55 123 4567");
    expect(byEmail.some((r) => r.id === staff.id)).toBe(true);
    expect(byPhone.some((r) => r.id === staff.id)).toBe(true);
  });

  it("searchCustomers matches kofi / Kofi / KOFI / KoFi identically", async () => {
    const admin = await createTestAdmin();
    const { customer } = await createTestCustomer(admin.id, 50, "SRCH1");
    await prisma.customer.update({
      where: { id: customer.id },
      data: { fullName: "Kofi Mensah" },
    });

    await setAdminSession(admin.id);
    const queries = ["kofi", "Kofi", "KOFI", "KoFi"];
    const results = await Promise.all(
      queries.map((q) => searchCustomers(q))
    );

    const ids = results.map((r) => r.map((x) => x.id).sort().join(","));
    expect(ids[0]).not.toBe("");
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[0]);
    }
  });
});