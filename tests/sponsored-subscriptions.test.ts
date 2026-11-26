/**
 * Sponsored subscriptions.
 *
 * The audit's finding was that a sponsorship record could be mistaken for paid
 * cover. These tests prove the opposite: money is a ledger of integer pesewa, the
 * controls refuse abuse, and the covered business keeps ownership of its own
 * subscription.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
  requireTenantAdminSusu: async () => ctxHolder.current,
  requireTenantCustomer: async () => ctxHolder.current,
  getTenantContext: async () => ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.current,
}));

import {
  createSponsor,
  createSponsorshipAgreement,
  getSponsorshipOverview,
  getSubscriptionSponsorshipCoverage,
  recordSponsorshipCoverage,
  recordSponsorshipFunding,
} from "@/lib/actions/sponsorship.actions";
import {
  coverageIsActive,
  coveragePeriod,
  decideFunding,
  isSelfSponsorship,
  netFundedPesewa,
  toPesewa,
} from "@/lib/sponsorship";

let tenantId: string;
let adminId: string;
let associationId: string;
let memberId: string;
let coveredTenantId: string;
let sponsorId: string;
let sponsorshipId: string;

async function asAdmin() {
  ctxHolder.current = {
    tenantId,
    tenantName: "Sponsor Tenant",
    tenantCode: "ST",
    userId: adminId,
    role: "admin",
    modules: ["admin"],
  };
}

beforeEach(async () => {
  await cleanDatabase();
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `SP-${Math.random().toString(36).slice(2, 8)}`,
      name: "Sponsor Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  const covered = await prisma.businessTenant.create({
    data: {
      code: `SPC-${Math.random().toString(36).slice(2, 8)}`,
      name: "Covered Business",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  coveredTenantId = covered.id;
  const admin = await prisma.user.create({
    data: {
      tenantId,
      email: `sp-admin-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: "Sponsor Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  const association = await prisma.association.create({
    data: { tenantId, code: "MOMAG", name: "MoMAG", createdById: adminId },
  });
  associationId = association.id;
  const member = await prisma.associationMember.create({
    data: {
      tenantId,
      associationId,
      memberCode: "M-1",
      businessName: "Covered Business",
      contactName: "Ama",
      status: "active",
      createdById: adminId,
    },
  });
  memberId = member.id;
  await asAdmin();

  const sponsor = await createSponsor({
    name: "Zenith Foundation",
    kind: "business",
    annualCapPesewa: 500_000,
  });
  expect(sponsor.success, sponsor.error).toBe(true);
  sponsorId = sponsor.data!.sponsors[0].id;

  const agreement = await createSponsorshipAgreement({
    memberId,
    sponsorId,
    planCode: "PRO",
    amount: 1_200,
    subjectTenantId: coveredTenantId,
  });
  expect(agreement.success, agreement.error).toBe(true);
  sponsorshipId = agreement.data!.sponsorships[0].id;
});

describe("sponsor identity", () => {
  it("refuses a duplicate sponsor name", async () => {
    const again = await createSponsor({ name: "Zenith Foundation", kind: "business" });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/already exists/i);
  });

  it("shows what a sponsor has committed this year against its cap", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 300,
      reference: "FUND-1",
    });
    const view = await getSponsorshipOverview();
    const sponsor = view.data!.sponsors[0];
    expect(sponsor.committedThisYearPesewa).toBe(30_000);
    expect(sponsor.outstandingPesewa).toBe(500_000 - 30_000);
  });
});

describe("agreement controls", () => {
  it("refuses a self-sponsorship", async () => {
    const self = await createSponsor({
      name: "Covered Business Direct",
      kind: "business",
      subjectTenantId: coveredTenantId,
    });
    const selfId = self.data!.sponsors.find(
      (sponsor) => sponsor.name === "Covered Business Direct"
    )!.id;
    const result = await createSponsorshipAgreement({
      memberId,
      sponsorId: selfId,
      amount: 100,
      subjectTenantId: coveredTenantId,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot fund a subscription for its own business/i);
  });

  it("refuses an inactive member and an inactive sponsor", async () => {
    await prisma.associationMember.update({
      where: { id: memberId },
      data: { status: "suspended" },
    });
    const inactiveMember = await createSponsorshipAgreement({
      memberId,
      sponsorId,
      amount: 100,
    });
    expect(inactiveMember.success).toBe(false);
    expect(inactiveMember.error).toMatch(/suspended/i);

    await prisma.associationMember.update({
      where: { id: memberId },
      data: { status: "active" },
    });
    await prisma.sponsor.update({ where: { id: sponsorId }, data: { status: "inactive" } });
    const inactiveSponsor = await createSponsorshipAgreement({
      memberId,
      sponsorId,
      amount: 100,
    });
    expect(inactiveSponsor.success).toBe(false);
    expect(inactiveSponsor.error).toMatch(/inactive/i);
  });

  it("refuses a duplicate live arrangement for the same member and plan", async () => {
    const duplicate = await createSponsorshipAgreement({
      memberId,
      sponsorId,
      planCode: "PRO",
      amount: 600,
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toMatch(/already has a live arrangement/i);
  });

  it("refuses a cap larger than the agreed amount", async () => {
    const result = await createSponsorshipAgreement({
      memberId,
      sponsorId,
      amount: 100,
      fundedCap: 200,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot be larger than the agreed/i);
  });
});

describe("funding ledger", () => {
  it("records an allocation, activates the sponsorship and totals in pesewa", async () => {
    const recorded = await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 400,
      reference: "FUND-2",
    });
    expect(recorded.success, recorded.error).toBe(true);
    const row = recorded.data!.sponsorships[0];
    expect(row.fundedPesewa).toBe(40_000);
    expect(row.netPesewa).toBe(40_000);
    expect(row.status).toBe("active");
    expect(row.funding[0].amountLabel).toContain("400.00");
  });

  it("refuses funding beyond the sponsorship cap", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 1_000,
      reference: "FUND-3",
    });
    const over = await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 300,
      reference: "FUND-4",
    });
    expect(over.success).toBe(false);
    expect(over.error).toMatch(/allows .* in total/i);
  });

  it("refuses funding beyond the sponsor's yearly cap", async () => {
    const second = await createSponsorshipAgreement({
      memberId: (
        await prisma.associationMember.create({
          data: {
            tenantId,
            associationId,
            memberCode: "M-2",
            businessName: "Second Member",
            contactName: "Kofi",
            status: "active",
            createdById: adminId,
          },
        })
      ).id,
      sponsorId,
      planCode: "BASIC",
      amount: 5_000,
    });
    const secondId = second.data!.sponsorships.find((row) => row.planCode === "BASIC")!.id;
    await recordSponsorshipFunding({
      sponsorshipId: secondId,
      kind: "allocation",
      amount: 4_900,
      reference: "FUND-5",
    });
    const over = await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 200,
      reference: "FUND-6",
    });
    expect(over.success).toBe(false);
    expect(over.error).toMatch(/yearly cap/i);
  });

  it("refuses a release larger than what has been funded", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 100,
      reference: "FUND-7",
    });
    const tooMuch = await recordSponsorshipFunding({
      sponsorshipId,
      kind: "release",
      amount: 200,
      reference: "FUND-8",
    });
    expect(tooMuch.success).toBe(false);
    expect(tooMuch.error).toMatch(/has been funded/i);

    const released = await recordSponsorshipFunding({
      sponsorshipId,
      kind: "release",
      amount: 40,
      reference: "FUND-9",
    });
    expect(released.success, released.error).toBe(true);
    const row = released.data!.sponsorships[0];
    expect(row.fundedPesewa).toBe(10_000);
    expect(row.releasedPesewa).toBe(4_000);
    expect(row.netPesewa).toBe(6_000);
  });

  it("refuses a reused funding reference", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 50,
      reference: "FUND-10",
    });
    const reuse = await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 50,
      reference: "FUND-10",
    });
    expect(reuse.success).toBe(false);
    expect(reuse.error).toMatch(/already been used/i);
  });

  it("refuses a fractional pesewa", async () => {
    const result = await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 10.555,
      reference: "FUND-11",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/two decimal places/i);
  });
});

describe("coverage", () => {
  it("assigns funded money to a covered period for the business", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 500,
      reference: "FUND-12",
    });
    const coverage = await recordSponsorshipCoverage({
      sponsorshipId,
      subjectTenantId: coveredTenantId,
      months: 6,
      amount: 300,
    });
    expect(coverage.success, coverage.error).toBe(true);
    expect(coverage.data!.coveredPesewa).toBe(30_000);
    expect(coverage.data!.unassignedPesewa).toBe(20_000);
    expect(coverage.data!.sponsorships[0].coverageEndsAt).toBeTruthy();
  });

  it("refuses covering more than is funded and unassigned", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 100,
      reference: "FUND-13",
    });
    const tooMuch = await recordSponsorshipCoverage({
      sponsorshipId,
      subjectTenantId: coveredTenantId,
      months: 3,
      amount: 400,
    });
    expect(tooMuch.success).toBe(false);
    expect(tooMuch.error).toMatch(/not yet assigned/i);
  });

  it("reports cover to the billing lifecycle without naming the sponsor", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 200,
      reference: "FUND-14",
    });
    await recordSponsorshipCoverage({
      sponsorshipId,
      subjectTenantId: coveredTenantId,
      months: 3,
      amount: 150,
    });
    const cover = await getSubscriptionSponsorshipCoverage(coveredTenantId);
    expect(cover.covered).toBe(true);
    expect(cover.amountPesewa).toBe(15_000);
    expect(JSON.stringify(cover)).not.toMatch(/Zenith/);
  });

  it("reports no cover for a business nothing was assigned to", async () => {
    const other = await prisma.businessTenant.create({
      data: { code: "SP-UNCOVERED", name: "Uncovered", status: "ACTIVE", susuEnabled: true },
    });
    const cover = await getSubscriptionSponsorshipCoverage(other.id);
    expect(cover.covered).toBe(false);
    expect(cover.endsAt).toBeNull();
  });
});

describe("money helpers", () => {
  it("sums a ledger with releases subtracted", () => {
    expect(
      netFundedPesewa([
        { kind: "allocation", amountPesewa: 1000 },
        { kind: "release", amountPesewa: 250 },
        { kind: "allocation", amountPesewa: 100 },
      ])
    ).toBe(850);
  });

  it("converts cedi to pesewa without drift and refuses a fractional pesewa", () => {
    expect(toPesewa(10.1).pesewa).toBe(1010);
    expect(toPesewa(0).error).toMatch(/greater than zero/i);
    expect(toPesewa(1.005).error).toMatch(/two decimal places/i);
  });

  it("treats coverage as live only inside its period", () => {
    const period = coveragePeriod(new Date("2026-01-01T00:00:00Z"), 3);
    expect(period.end.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(
      coverageIsActive(
        { status: "active", periodStart: period.start, periodEnd: period.end },
        new Date("2026-02-01T00:00:00Z")
      )
    ).toBe(true);
    expect(
      coverageIsActive(
        { status: "active", periodStart: period.start, periodEnd: period.end },
        new Date("2026-05-01T00:00:00Z")
      )
    ).toBe(false);
    expect(
      coverageIsActive(
        { status: "ended", periodStart: period.start, periodEnd: period.end },
        new Date("2026-02-01T00:00:00Z")
      )
    ).toBe(false);
  });

  it("detects a self-sponsorship from the sponsor's own business", () => {
    expect(isSelfSponsorship({ subjectTenantId: "t1" }, "t1")).toBe(true);
    expect(isSelfSponsorship({ subjectTenantId: "t1" }, "t2")).toBe(false);
    expect(isSelfSponsorship({ subjectTenantId: null }, "t1")).toBe(false);
  });

  it("explains each refusal with a machine reason", () => {
    const base = {
      kind: "allocation" as const,
      amountPesewa: 100,
      sponsorStatus: "active",
      selfSponsorship: false,
      memberStatus: "active",
      sponsorshipCapPesewa: 1_000,
      alreadyFundedPesewa: 0,
      sponsorAnnualCapPesewa: null,
      sponsorFundedThisYearPesewa: 0,
    };
    expect(decideFunding(base).allowed).toBe(true);
    expect(decideFunding({ ...base, sponsorStatus: "inactive" }).reason).toBe(
      "sponsor_inactive"
    );
    expect(decideFunding({ ...base, selfSponsorship: true }).reason).toBe("self_sponsorship");
    expect(decideFunding({ ...base, memberStatus: "withdrawn" }).reason).toBe(
      "member_ineligible"
    );
    expect(
      decideFunding({ ...base, alreadyFundedPesewa: 950, amountPesewa: 100 }).reason
    ).toBe("over_sponsorship_cap");
    expect(
      decideFunding({
        ...base,
        sponsorAnnualCapPesewa: 500,
        sponsorFundedThisYearPesewa: 450,
        amountPesewa: 100,
      }).reason
    ).toBe("over_sponsor_annual_cap");
    expect(
      decideFunding({ ...base, kind: "release", alreadyFundedPesewa: 50, amountPesewa: 100 })
        .reason
    ).toBe("release_exceeds_funding");
  });
});

describe("isolation", () => {
  it("does not show another business's sponsors or sponsorships", async () => {
    const otherTenant = await prisma.businessTenant.create({
      data: { code: "SP-OTHER", name: "Other", status: "ACTIVE", susuEnabled: true },
    });
    const otherAdmin = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        email: `sp-other-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Other Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    await prisma.sponsor.create({
      data: {
        tenantId: otherTenant.id,
        name: "Hidden Sponsor",
        kind: "business",
        createdById: otherAdmin.id,
      },
    });

    const view = await getSponsorshipOverview();
    expect(view.data!.sponsors.map((sponsor) => sponsor.name)).not.toContain("Hidden Sponsor");
    expect(view.data!.sponsors.map((sponsor) => sponsor.name)).toContain("Zenith Foundation");
  });

  it("audits every money-related change as non-financial", async () => {
    await recordSponsorshipFunding({
      sponsorshipId,
      kind: "allocation",
      amount: 100,
      reference: "FUND-15",
    });
    const rows = await prisma.auditLog.findMany({
      where: { tenantId, action: { startsWith: "sponsorship." } },
    });
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "sponsorship.sponsor_created",
        "sponsorship.agreement_created",
        "sponsorship.funding_recorded",
      ])
    );
    for (const row of rows) {
      expect(JSON.parse(String(row.details)).financialMutation).toBe(false);
    }
  });
});
