/**
 * MaaCash Susu Phase 3 - remittance lifecycle (dedicated coverage).
 *
 * Verifies the chain Contribution -> declaration -> RemittanceContribution ->
 * custody/receipt -> independent finance verification -> outstanding balance ->
 * discrepancies -> resolution/reversal, including the required partial
 * remittance example: expected GH₵5,000 -> 3,000 -> 2,000 -> 1,500 -> 500 -> 500 -> 0.
 *
 * Runs against the disposable SQLite unit database; concurrency races are
 * covered in tests/pg-susu-phase-3.test.ts where the advisory lock is real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { createSessionRecord } from "@/lib/security/session-store";
import { prisma, cleanDatabase } from "./setup";
import {
  acknowledgeRemittanceReceipt,
  declareRemittance,
  getCollectorRemittancePosition,
  getRemittanceById,
  resolveRemittanceDiscrepancy,
  reverseRemittanceDeclaration,
  verifyRemittance,
} from "@/lib/actions/susu-remittance.actions";

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

type SessionUser = { id: string; tenantId: string | null; email: string };

async function setSession(
  cookie: string,
  user: SessionUser,
  role: "admin" | "collector"
) {
  const now = Math.floor(Date.now() / 1000);
  if (!user.tenantId) throw new Error("test user has no tenant");
  const jti = `p3-${role}-${now}-${Math.random().toString(16).slice(2)}`;
  const session = {
    userId: user.id,
    email: user.email,
    fullName: role === "admin" ? "Admin" : "Collector",
    role,
    modules: ["susu"],
    tokenVersion: 0,
    jti,
    iat: now,
  };
  await createSessionRecord({
    id: jti,
    subjectType: "user",
    subjectId: user.id,
    tenantId: user.tenantId,
    expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    cookie,
    await new SignJWT(session)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
  return session;
}

const asAdmin = (user: SessionUser) => setSession("bik-admin-session", user, "admin");
const asCollector = (user: SessionUser) =>
  setSession("bik-collector-session", user, "collector");

type RemittanceRow = {
  id: string;
  expectedAmount: unknown;
  remittedAmount: unknown;
  outstandingAmount: unknown;
  status: string;
  receivedAt: Date | null;
  custodyConfirmedAt: Date | null;
  receiverId: string | null;
  receivingBranchId: string | null;
  declaredById: string | null;
  receivedById: string | null;
  verifiedAt: Date | null;
  reconciliationStatus: string;
};

const money = (value: unknown) => Math.round(Number(value) * 100) / 100;

let seq = 0;

async function createAdmin(tenantId: string, label: string) {
  return prisma.user.create({
    data: {
      tenantId,
      email: `p3-${label}-${randomBytes(4).toString("hex")}@test.local`,
      fullName: label,
      role: "admin",
      status: "active",
      passwordHash: "not-used",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
}

async function fixture() {
  seq += 1;
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `P3-${seq}-${randomBytes(3).toString("hex").toUpperCase()}`,
      name: `Phase 3 Tenant ${seq}`,
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });

  const branchA = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Accra", code: `ACC-${seq}`, status: "active" },
  });
  const branchB = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Kumasi", code: `KUM-${seq}`, status: "active" },
  });

  const admin = await createAdmin(tenant.id, "Admin");
  await prisma.businessTenant.update({
    where: { id: tenant.id },
    data: { primaryAdminUserId: admin.id },
  });

  const collectorUser = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `p3-collector-${seq}@test.local`,
      fullName: "Phase 3 Collector",
      role: "collector",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
    },
  });
  const collector = await prisma.collector.create({
    data: {
      tenantId: tenant.id,
      userId: collectorUser.id,
      branchId: branchA.id,
      status: "active",
    },
  });

  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `P3-C-${seq}-${randomBytes(2).toString("hex")}`,
      fullName: "Phase 3 Customer",
      phone: `+2332000${String(seq).padStart(4, "0")}`,
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `P3-S-${seq}-${randomBytes(2).toString("hex")}`,
      customerId: customer.id,
      dailyContribution: 50,
      status: "active",
      cardCustody: "customer",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date(2026, 0, 1),
      endDate: new Date(2026, 0, 31),
      dailyContribution: 50,
      status: "active",
      commissionCharged: false,
    },
  });

  return { tenant, branchA, branchB, admin, collectorUser, collector, customer, account, cycle };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function addContributions(f: Fixture, amounts: number[], opts: { reversed?: boolean } = {}) {
  const rows = [];
  for (const amount of amounts) {
    rows.push(
      await prisma.contribution.create({
        data: {
          tenantId: f.tenant.id,
          branchId: f.branchA.id,
          accountId: f.account.id,
          cycleId: f.cycle.id,
          amount,
          collectionDate: new Date(2026, 0, 15),
          channel: "collector",
          collectorId: f.collector.id,
          recordedById: f.admin.id,
          referenceId: `P3-CON-${randomBytes(8).toString("hex")}`,
          reversedAt: opts.reversed ? new Date() : null,
        },
      })
    );
  }
  return rows;
}

async function declared(result: { success: boolean; data?: unknown }) {
  expect(result.success).toBe(true);
  return result.data as RemittanceRow;
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("Phase 3 - contribution eligibility and declaration", () => {
  it("computes expected cash from unsettled, non-reversed contributions only", async () => {
    const f = await fixture();
    await addContributions(f, [1000, 1000, 1000, 1000, 1000]);
    await addContributions(f, [750], { reversed: true });
    await asAdmin(f.admin);

    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 3000 })
    );
    expect(money(row.expectedAmount)).toBe(5000);
    expect(money(row.outstandingAmount)).toBe(2000);
    expect(row.status).toBe("submitted");
  });

  it("supports the required partial remittance sequence down to zero", async () => {
    const f = await fixture();
    await addContributions(f, [1000, 1000, 1000, 1000, 1000]);
    await asAdmin(f.admin);

    const first = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 3000 })
    );
    expect(money(first.expectedAmount)).toBe(5000);
    expect(money(first.outstandingAmount)).toBe(2000);

    let position = await getCollectorRemittancePosition(f.collector.id);
    expect(position?.outstanding).toBe(2000);
    expect(position?.contributed).toBe(5000);
    expect(position?.settled).toBe(3000);

    const second = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1500 })
    );
    expect(money(second.expectedAmount)).toBe(2000);
    expect(money(second.outstandingAmount)).toBe(500);

    const third = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 500 })
    );
    expect(money(third.expectedAmount)).toBe(500);
    expect(money(third.outstandingAmount)).toBe(0);

    position = await getCollectorRemittancePosition(f.collector.id);
    expect(position?.outstanding).toBe(0);
    expect(position?.settled).toBe(5000);

    // Every contribution is fully settled exactly once, even though the last
    // one was split across two declarations.
    const links = await prisma.remittanceContribution.findMany({
      where: { tenantId: f.tenant.id },
      select: { contributionId: true, amount: true },
    });
    const perContribution = new Map<string, number>();
    for (const link of links) {
      perContribution.set(
        link.contributionId,
        money((perContribution.get(link.contributionId) ?? 0) + Number(link.amount))
      );
    }
    expect([...perContribution.values()].every((value) => value === 1000)).toBe(true);
    expect(money(links.reduce((sum, link) => sum + Number(link.amount), 0))).toBe(5000);
  });

  it("does not create or mutate a customer contribution when a remittance is declared", async () => {
    const f = await fixture();
    await addContributions(f, [500]);
    const before = await prisma.contribution.findMany({
      where: { tenantId: f.tenant.id },
      orderBy: { id: "asc" },
      select: { id: true, amount: true },
    });
    await asAdmin(f.admin);
    await declared(await declareRemittance({ collectorId: f.collector.id, declaredAmount: 500 }));

    const after = await prisma.contribution.findMany({
      where: { tenantId: f.tenant.id },
      orderBy: { id: "asc" },
      select: { id: true, amount: true },
    });
    expect(after).toEqual(before);
  });

  it("refuses a declaration from a suspended collector", async () => {
    const f = await fixture();
    await addContributions(f, [400]);
    await prisma.collector.update({
      where: { id: f.collector.id },
      data: { status: "suspended", statusReason: "Investigation" },
    });
    await asCollector(f.collectorUser);

    const result = await declareRemittance({ declaredAmount: 400 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/suspended|inactive/i);
    expect(await prisma.collectorRemittance.count()).toBe(0);
  });

  it("rejects an over-remittance for review instead of settling it silently", async () => {
    const f = await fixture();
    await addContributions(f, [1000]);
    await asAdmin(f.admin);
    await declared(await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000 }));

    const over = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 250 })
    );
    expect(money(over.expectedAmount)).toBe(0);
    expect(money(over.outstandingAmount)).toBe(0);
    expect(over.status).toBe("submitted");

    const discrepancy = await prisma.remittanceDiscrepancy.findFirst({
      where: { remittanceId: over.id, type: "over_remittance" },
    });
    expect(discrepancy?.status).toBe("open");
    expect(money(discrepancy?.variance)).toBe(250);

    // The extra cash never becomes a second settlement of the same contribution.
    const position = await getCollectorRemittancePosition(f.collector.id);
    expect(position?.outstanding).toBe(0);
    const allocated = await prisma.remittanceContribution.aggregate({
      where: { tenantId: f.tenant.id },
      _sum: { amount: true },
    });
    expect(money(allocated._sum.amount)).toBe(1000);
  });

  it("is idempotent for a repeated declaration request and rejects key reuse", async () => {
    const f = await fixture();
    await addContributions(f, [800]);
    await asAdmin(f.admin);

    const key = `p3-key-${randomBytes(4).toString("hex")}`;
    const first = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 800, idempotencyKey: key })
    );
    const second = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 800, idempotencyKey: key })
    );
    expect(second.id).toBe(first.id);
    expect(await prisma.collectorRemittance.count()).toBe(1);

    const conflict = await declareRemittance({
      collectorId: f.collector.id,
      declaredAmount: 700,
      idempotencyKey: key,
    });
    expect(conflict.success).toBe(false);
    expect(conflict.error).toMatch(/different remittance details/i);
  });
});

describe("Phase 3 - custody, receipt and independent finance verification", () => {
  it("keeps custody acknowledgement separate from finance verification", async () => {
    const f = await fixture();
    await addContributions(f, [1000]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000 })
    );

    const receipt = await acknowledgeRemittanceReceipt({
      remittanceId: row.id,
      receivedAmount: 1000,
      note: "Cash counted at the branch",
    });
    expect(receipt.success).toBe(true);

    const stored = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("received");
    expect(stored.custodyConfirmedAt).not.toBeNull();
    expect(stored.receiverId).toBe(f.admin.id);
    expect(stored.receivingBranchId).toBe(f.branchA.id);
    // The person who received the cash is not an independent verification.
    expect(stored.verifiedAt).toBeNull();
    expect(stored.verifiedById).toBeNull();
    expect(stored.reconciliationStatus).toBe("pending");
  });

  it("refuses a second receipt acknowledgement", async () => {
    const f = await fixture();
    await addContributions(f, [600]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 600 })
    );
    expect((await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 600 })).success).toBe(true);

    const second = await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 500 });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already been acknowledged/i);
  });

  it("records a receipt shortfall as an open discrepancy and leaves it outstanding", async () => {
    const f = await fixture();
    await addContributions(f, [1000]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 900 });

    const stored = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("received");
    expect(money(stored.outstandingAmount)).toBe(100);
    expect(stored.verifiedAt).toBeNull();

    const discrepancy = await prisma.remittanceDiscrepancy.findFirst({
      where: { remittanceId: row.id, type: "receipt_shortfall" },
    });
    expect(discrepancy?.status).toBe("open");
    expect(money(discrepancy?.variance)).toBe(100);

    const position = await getCollectorRemittancePosition(f.collector.id);
    expect(position?.settled).toBe(900);
    expect(position?.outstanding).toBe(100);
  });

  it("requires confirmed custody before finance verification", async () => {
    const f = await fixture();
    await addContributions(f, [500]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 500 })
    );

    const verifier = await createAdmin(f.tenant.id, "Verifier");
    await asAdmin(verifier);
    const result = await verifyRemittance({ remittanceId: row.id, verifiedAmount: 500 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/custody/i);
  });

  it("lets an independent finance verifier verify a received remittance", async () => {
    const f = await fixture();
    await addContributions(f, [1200]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1200 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 1200 });

    const verifier = await createAdmin(f.tenant.id, "Finance Verifier");
    await prisma.branchMembership.create({
      data: { tenantId: f.tenant.id, userId: verifier.id, locationId: f.branchA.id, role: "finance", status: "active" },
    });
    await asAdmin(verifier);

    const result = await verifyRemittance({ remittanceId: row.id, verifiedAmount: 1200, note: "Counted and agreed" });
    expect(result.success).toBe(true);

    const stored = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("verified");
    expect(stored.verifiedById).toBe(verifier.id);
    expect(stored.verifiedAt).not.toBeNull();
    expect(stored.reconciliationStatus).toBe("reconciled");
  });

  it("denies self-verification by the declaring or receiving administrator", async () => {
    const f = await fixture();
    await addContributions(f, [700]);
    await asAdmin(f.admin);
    const declaredByAdmin = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 700 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: declaredByAdmin.id, receivedAmount: 700 });

    // The administrator who declared AND received it may not verify it.
    const self = await verifyRemittance({ remittanceId: declaredByAdmin.id, verifiedAmount: 700 });
    expect(self.success).toBe(false);
    expect(self.error).toMatch(/separation of duties/i);

    // A different receiver is still not allowed to verify the cash they took in.
    await prisma.collectorRemittance.update({
      where: { id: declaredByAdmin.id },
      data: { receivedAt: null, custodyConfirmedAt: null, receivedById: null, receiverId: null, status: "submitted" },
    });
    const receiver = await createAdmin(f.tenant.id, "Receiver");
    await asAdmin(receiver);
    expect(
      (await acknowledgeRemittanceReceipt({ remittanceId: declaredByAdmin.id, receivedAmount: 700 })).success
    ).toBe(true);

    const byReceiver = await verifyRemittance({ remittanceId: declaredByAdmin.id, verifiedAmount: 700 });
    expect(byReceiver.success).toBe(false);
    expect(byReceiver.error).toMatch(/separation of duties/i);

    // An unrelated company-wide administrator can verify it.
    const independent = await createAdmin(f.tenant.id, "Independent Verifier");
    await asAdmin(independent);
    expect((await verifyRemittance({ remittanceId: declaredByAdmin.id, verifiedAmount: 700 })).success).toBe(true);
  });

  it("records a verification mismatch as disputed and never as reconciled", async () => {
    const f = await fixture();
    await addContributions(f, [1000]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 1000 });

    const verifier = await createAdmin(f.tenant.id, "Verifier Two");
    await asAdmin(verifier);
    const result = await verifyRemittance({ remittanceId: row.id, verifiedAmount: 950, note: "Bank count differs" });
    expect(result.success).toBe(true);

    const stored = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("disputed");
    expect(stored.reconciliationStatus).toBe("disputed");
    expect(money(stored.disputedAmount)).toBe(50);
    const discrepancy = await prisma.remittanceDiscrepancy.findFirst({
      where: { remittanceId: row.id, type: "verification_variance" },
    });
    expect(discrepancy?.status).toBe("open");
  });

  it("reverses a declaration without deleting its contribution evidence", async () => {
    const f = await fixture();
    await addContributions(f, [1000]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000 })
    );
    expect(await prisma.remittanceContribution.count({ where: { remittanceId: row.id } })).toBe(1);

    const reason = "Recorded against the wrong collector";
    const result = await reverseRemittanceDeclaration({ remittanceId: row.id, reason });
    expect(result.success).toBe(true);

    const stored = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("reversed");
    expect(stored.reversalReason).toContain(reason);
    expect(await prisma.remittanceContribution.count({ where: { remittanceId: row.id } })).toBe(1);

    const position = await getCollectorRemittancePosition(f.collector.id);
    expect(position?.outstanding).toBe(1000);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: f.tenant.id, action: "susu.remittance_declaration_reversed", entityId: row.id },
    });
    expect(audit).not.toBeNull();
  });
});

describe("Phase 3 - discrepancies and tenant/branch isolation", () => {
  it("keeps a remittance disputed until every open discrepancy is resolved", async () => {
    const f = await fixture();
    await addContributions(f, [1000]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 900 });

    const verifier = await createAdmin(f.tenant.id, "Verifier Three");
    await asAdmin(verifier);
    await verifyRemittance({ remittanceId: row.id, verifiedAmount: 900 });

    const open = await prisma.remittanceDiscrepancy.findMany({
      where: { remittanceId: row.id, status: "open" },
      orderBy: { createdAt: "asc" },
    });
    expect(open.length).toBeGreaterThanOrEqual(2);

    const first = await resolveRemittanceDiscrepancy({
      discrepancyId: open[0].id,
      resolutionNotes: "Collector acknowledged the shortfall in writing",
    });
    expect(first.success).toBe(true);
    expect(
      (await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: row.id } })).reconciliationStatus
    ).toBe("disputed");

    for (const discrepancy of open.slice(1)) {
      const resolved = await resolveRemittanceDiscrepancy({
        discrepancyId: discrepancy.id,
        resolutionNotes: "Escalated and closed by finance",
      });
      expect(resolved.success).toBe(true);
    }
    expect(
      (await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: row.id } })).reconciliationStatus
    ).toBe("reconciled");
  });

  it("refuses a discrepancy resolution with no explanation", async () => {
    const f = await fixture();
    await addContributions(f, [500]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 500 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 450 });
    const discrepancy = await prisma.remittanceDiscrepancy.findFirstOrThrow({
      where: { remittanceId: row.id, status: "open" },
    });

    const result = await resolveRemittanceDiscrepancy({ discrepancyId: discrepancy.id, resolutionNotes: " " });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/explanation/i);
  });

  it("does not let a branch manager act as finance verifier", async () => {
    const f = await fixture();
    await addContributions(f, [900]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 900 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 900 });

    const manager = await createAdmin(f.tenant.id, "Branch Manager");
    await prisma.branchMembership.create({
      data: { tenantId: f.tenant.id, userId: manager.id, locationId: f.branchA.id, role: "branch_manager", status: "active" },
    });
    await asAdmin(manager);

    const result = await verifyRemittance({ remittanceId: row.id, verifiedAmount: 900 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not an authorised finance verifier/i);
  });

  it("prevents a branch manager from receiving cash at another branch", async () => {
    const f = await fixture();
    await addContributions(f, [300]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 300 })
    );

    const manager = await createAdmin(f.tenant.id, "Branch B Manager");
    await prisma.branchMembership.create({
      data: { tenantId: f.tenant.id, userId: manager.id, locationId: f.branchB.id, role: "branch_manager", status: "active" },
    });
    await asAdmin(manager);

    const result = await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 300 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authorised to receive cash/i);
  });

  it("does not expose another tenant's remittance to a verifier or a lookup", async () => {
    const f = await fixture();
    await addContributions(f, [400]);
    await asAdmin(f.admin);
    const row = await declared(
      await declareRemittance({ collectorId: f.collector.id, declaredAmount: 400 })
    );
    await acknowledgeRemittanceReceipt({ remittanceId: row.id, receivedAmount: 400 });

    const other = await fixture();
    await asAdmin(other.admin);

    const verify = await verifyRemittance({ remittanceId: row.id, verifiedAmount: 400 });
    expect(verify.success).toBe(false);
    expect(verify.error).toMatch(/not found/i);
    expect(await getRemittanceById(row.id)).toBeNull();
  });
});
