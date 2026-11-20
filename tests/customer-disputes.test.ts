/**
 * Customer disputes (Priority 7).
 *
 * Pure transition/schema rules plus the customer and administrator flow against
 * the real SQLite test database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  canTransitionDispute,
  generateDisputeReference,
  openDisputeSchema,
  outcomeStatus,
  resolveDisputeSchema,
} from "@/lib/customer-disputes";

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
  cancelCustomerDispute,
  getAdminDispute,
  getAdminDisputes,
  getCustomerDispute,
  getCustomerDisputeSubject,
  getCustomerDisputes,
  openCustomerDispute,
  requestDisputeInformation,
  resolveCustomerDispute,
  respondToCustomerDispute,
  startDisputeReview,
} from "@/lib/actions/customer-dispute.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setSession(
  module: "admin" | "customer",
  user: { id: string; email?: string | null }
) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    module === "admin" ? "bik-admin-session" : "bik-customer-session",
    await new SignJWT({
      userId: user.id,
      email: user.email ?? `${user.id}@test.local`,
      fullName: "Test",
      role: module === "admin" ? "admin" : "customer",
      modules: [module === "admin" ? "momo" : "customer"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

describe("dispute rules", () => {
  it("allows only the documented review transitions", () => {
    expect(canTransitionDispute("open", "under_review")).toBe(true);
    expect(canTransitionDispute("open", "cancelled")).toBe(true);
    expect(canTransitionDispute("open", "resolved_upheld")).toBe(false);
    expect(canTransitionDispute("under_review", "awaiting_customer")).toBe(true);
    expect(canTransitionDispute("awaiting_customer", "under_review")).toBe(true);
    expect(canTransitionDispute("resolved_upheld", "open")).toBe(false);
    expect(canTransitionDispute("cancelled", "under_review")).toBe(false);
    expect(outcomeStatus("upheld")).toBe("resolved_upheld");
    expect(outcomeStatus("declined")).toBe("resolved_declined");
  });

  it("validates the customer explanation and the resolution note", () => {
    expect(
      openDisputeSchema.safeParse({
        subjectType: "contribution",
        subjectId: "c1",
        category: "not_received",
        details: "short",
      }).success
    ).toBe(false);
    expect(
      openDisputeSchema.safeParse({
        subjectType: "contribution",
        subjectId: "c1",
        category: "not_received",
        details: "I paid GH₵50 at the office but it is not on my statement.",
      }).success
    ).toBe(true);
    expect(
      resolveDisputeSchema.safeParse({
        disputeId: "d1",
        outcome: "upheld",
        note: "short",
      }).success
    ).toBe(false);
  });

  it("generates a stable, readable reference", () => {
    expect(generateDisputeReference(new Date("2026-11-28T10:00:00Z"), "AB12CD")).toBe(
      "DSP-20261128-AB12CD"
    );
  });
});

let counter = 0;

async function fixture() {
  counter += 1;
  const tenant = await createTestTenant({ momo: true, susu: true });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: true });
  const makeCustomer = async (tag: string) => {
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerId: `DSP-C-${counter}-${tag}`,
        fullName: `Customer ${tag}`,
        phone: `+2330000${counter}${tag}`,
        status: "active",
        portalEnabled: true,
      },
    });
    const account = await prisma.susuAccount.create({
      data: {
        tenantId: tenant.id,
        accountId: `DSP-S-${counter}-${tag}`,
        customerId: customer.id,
        dailyContribution: 10,
        status: "active",
      },
    });
    const cycle = await prisma.susuCycle.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleNumber: 1,
        startDate: new Date("2026-11-01T00:00:00Z"),
        endDate: new Date("2026-11-30T00:00:00Z"),
        dailyContribution: 10,
        status: "active",
      },
    });
    const contribution = await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        amount: 50,
        collectionDate: new Date("2026-11-20T10:00:00Z"),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: `DSP-REFC-${counter}-${tag}`,
      },
    });
    const withdrawal = await prisma.withdrawal.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        cycleId: cycle.id,
        requestedAmount: 30,
        commissionAmount: 0,
        netAmount: 30,
        remainingBalance: 20,
        status: "completed",
        authorizedById: admin.id,
        referenceId: `DSP-REFW-${counter}-${tag}`,
      },
    });
    return { customer, account, cycle, contribution, withdrawal };
  };

  const customerA = await makeCustomer("A");
  const customerB = await makeCustomer("B");
  return { tenant, admin, customerA, customerB };
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("customer dispute lifecycle", () => {
  it("opens one dispute, reviews it two-sided, and records an outcome", async () => {
    const f = await fixture();
    await setSession("customer", f.customerA.customer);

    const subject = await getCustomerDisputeSubject(
      "contribution",
      f.customerA.contribution.id
    );
    expect(subject).toMatchObject({
      type: "contribution",
      reference: f.customerA.contribution.referenceId,
      amount: 50,
      existingDispute: null,
    });

    const opened = await openCustomerDispute({
      subjectType: "contribution",
      subjectId: f.customerA.contribution.id,
      category: "not_received",
      details: "I paid GH₵50 at the office but it does not appear on my statement.",
      evidenceReference: "Office slip OS-1042",
    });
    expect(opened.success).toBe(true);
    const disputeId = (opened.data as { disputeId: string }).disputeId;

    const duplicate = await openCustomerDispute({
      subjectType: "contribution",
      subjectId: f.customerA.contribution.id,
      category: "not_received",
      details: "Trying to open the same dispute a second time.",
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toContain("already exists");

    const stored = await prisma.customerDispute.findUniqueOrThrow({
      where: { id: disputeId },
      include: { events: true },
    });
    expect(stored).toMatchObject({
      subjectType: "contribution",
      subjectReference: f.customerA.contribution.referenceId,
      status: "open",
      category: "not_received",
      openedByType: "customer",
      cycleNumber: 1,
      customerEvidence: "Office slip OS-1042",
    });
    expect(Number(stored.subjectAmount)).toBe(50);
    expect(stored.events.map((event) => event.action)).toEqual(["opened"]);

    await setSession("admin", f.admin);
    const board = await getAdminDisputes();
    expect(board.counts.open).toBe(1);
    expect(board.disputes[0]).toMatchObject({
      reference: stored.reference,
      customerName: "Customer A",
    });

    expect((await startDisputeReview(disputeId)).success).toBe(true);
    expect(
      (
        await requestDisputeInformation({
          disputeId,
          note: "Please bring the office receipt or the collector's name.",
        })
      ).success
    ).toBe(true);

    await setSession("customer", f.customerA.customer);
    const afterRequest = await getCustomerDispute(disputeId);
    expect(afterRequest?.status).toBe("awaiting_customer");
    expect(
      (
        await respondToCustomerDispute({
          disputeId,
          note: "The collector was Kofi and I paid at 9am.",
        })
      ).success
    ).toBe(true);

    await setSession("admin", f.admin);
    const tooShort = await resolveCustomerDispute({
      disputeId,
      outcome: "upheld",
      note: "ok",
    });
    expect(tooShort.success).toBe(false);

    // An upheld outcome must name a correction that actually exists, so a made-up
    // reference is refused before the dispute can be closed.
    const invented = await resolveCustomerDispute({
      disputeId,
      outcome: "upheld",
      note: "Receipt was located and the contribution confirmed; closing now.",
      outcomeReference: "REV-C-TEST-1",
    });
    expect(invented.success).toBe(false);
    expect(invented.error).toMatch(/no reversal matches/i);

    const missing = await resolveCustomerDispute({
      disputeId,
      outcome: "upheld",
      note: "Receipt was located and the contribution confirmed; closing now.",
    });
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/record the correction reference/i);

    // The correction itself is a separate financial record, made through the
    // normal control; this test writes the reversal row it would produce.
    await prisma.contribution.create({
      data: {
        tenantId: f.tenant.id,
        accountId: f.customerA.contribution.accountId,
        cycleId: f.customerA.contribution.cycleId,
        amount: -50,
        collectionDate: new Date("2026-11-21T10:00:00Z"),
        channel: "direct_office",
        recordedById: f.admin.id,
        referenceId: "REV-C-TEST-1",
        reversalOfId: f.customerA.contribution.id,
      },
    });

    const resolved = await resolveCustomerDispute({
      disputeId,
      outcome: "upheld",
      note: "Receipt was located and the contribution confirmed; correction reference recorded.",
      outcomeReference: "REV-C-TEST-1",
      resolutionEvidence: "Contribution counterfoil OS-1042",
    });
    expect(resolved.success, resolved.error).toBe(true);

    await setSession("customer", f.customerA.customer);
    const after = await getCustomerDispute(disputeId);
    expect(after?.status).toBe("resolved_upheld");
    expect(after?.outcomeReference).toBe("REV-C-TEST-1");
    expect(after?.resolutionEvidence).toBe("Contribution counterfoil OS-1042");
    expect(after?.cycleNumber).toBe(1);
    expect(after?.customerEvidence).toBe("Office slip OS-1042");
    expect(after?.events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "opened",
        "review_started",
        "information_requested",
        "customer_responded",
        "resolved_upheld",
      ])
    );

    const audit = await prisma.auditLog.findMany({
      where: { tenantId: f.tenant.id, entityType: "customerDispute" },
    });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "customer_dispute.opened",
        "customer_dispute.review_started",
        "customer_dispute.resolved",
      ])
    );
  });

  it("keeps disputes scoped to the owning customer and tenant", async () => {
    const f = await fixture();
    await setSession("customer", f.customerA.customer);
    const opened = await openCustomerDispute({
      subjectType: "withdrawal",
      subjectId: f.customerA.withdrawal.id,
      category: "wrong_amount",
      details: "I received less than the amount shown on the receipt.",
    });
    const disputeId = (opened.data as { disputeId: string }).disputeId;

    await setSession("customer", f.customerB.customer);
    expect(await getCustomerDispute(disputeId)).toBeNull();
    expect(await getCustomerDisputeSubject("withdrawal", f.customerA.withdrawal.id)).toBeNull();
    expect((await getCustomerDisputes()).length).toBe(0);
    expect(
      (
        await openCustomerDispute({
          subjectType: "withdrawal",
          subjectId: f.customerA.withdrawal.id,
          category: "wrong_amount",
          details: "Trying to dispute another customer's withdrawal.",
        })
      ).success
    ).toBe(false);

    const otherTenant = await createTestTenant({ momo: true, susu: true });
    const otherAdmin = await createTestAdmin({
      tenantId: otherTenant.id,
      momo: true,
      susu: true,
    });
    await setSession("admin", otherAdmin);
    expect(await getAdminDispute(disputeId)).toBeNull();
    expect((await getAdminDisputes()).disputes).toHaveLength(0);
    expect(
      (
        await resolveCustomerDispute({
          disputeId,
          outcome: "declined",
          note: "Cross-tenant attempt should not be able to resolve.",
        })
      ).success
    ).toBe(false);
  });

  it("lets the customer cancel only before review starts", async () => {
    const f = await fixture();
    await setSession("customer", f.customerA.customer);
    const opened = await openCustomerDispute({
      subjectType: "contribution",
      subjectId: f.customerA.contribution.id,
      category: "other",
      details: "I want to check this entry with the office first.",
    });
    const disputeId = (opened.data as { disputeId: string }).disputeId;

    expect((await cancelCustomerDispute(disputeId)).success).toBe(true);
    expect((await getCustomerDispute(disputeId))?.status).toBe("cancelled");
    expect((await cancelCustomerDispute(disputeId)).success).toBe(false);

    await setSession("admin", f.admin);
    expect(
      (
        await resolveCustomerDispute({
          disputeId,
          outcome: "declined",
          note: "A cancelled dispute cannot be resolved.",
        })
      ).success
    ).toBe(false);
  });
});
