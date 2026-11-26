"use server";

import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  coverageIsActive,
  coveragePeriod,
  coverageSchema,
  decideFunding,
  formatPesewa,
  fundingSchema,
  netFundedPesewa,
  pesewaToCedi,
  sponsorSchema,
  sponsorshipSchema,
  toPesewa,
  SPONSOR_KIND_LABELS,
  type FundingKind,
  type SponsorKind,
} from "@/lib/sponsorship";

/**
 * Sponsored subscriptions: sponsor identity, funding ledger, coverage and report.
 *
 * A sponsorship is money one party commits for another party's subscription. The
 * ledger is append-only integer pesewa; the covered business keeps ownership of
 * its subscription; and every refusal names the control that stopped it. Nothing
 * here creates or changes a Zeli subscription itself: coverage is the record the
 * billing lifecycle reads.
 */

export interface SponsorView {
  id: string;
  name: string;
  kind: SponsorKind;
  kindLabel: string;
  status: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  subjectTenantId: string | null;
  annualCapPesewa: number | null;
  committedThisYearPesewa: number;
  outstandingPesewa: number;
}

export interface SponsorshipRowView {
  id: string;
  reference: string | null;
  memberId: string;
  memberCode: string;
  memberName: string;
  memberStatus: string;
  sponsorId: string | null;
  sponsorName: string;
  planCode: string | null;
  agreedPesewa: number;
  capPesewa: number | null;
  fundedPesewa: number;
  releasedPesewa: number;
  netPesewa: number;
  status: string;
  coverageEndsAt: string | null;
  subjectTenantId: string | null;
  funding: Array<{
    id: string;
    kind: FundingKind;
    amountPesewa: number;
    amountLabel: string;
    reference: string;
    fundedAt: string;
    note: string | null;
  }>;
}

export interface SponsorshipOverview {
  sponsors: SponsorView[];
  sponsorships: SponsorshipRowView[];
  /** Money funded but not yet assigned to a covered period. */
  unassignedPesewa: number;
  /** Instantaneous liability: funded money whose coverage has not elapsed. */
  coveredPesewa: number;
  canManage: boolean;
}

export interface SponsorshipResponse {
  success: boolean;
  error?: string;
  data?: SponsorshipOverview;
}

async function canManageSponsorship(tenantId: string, userId: string): Promise<boolean> {
  const roles = await db.associationRoleAssignment.findMany({
    where: { tenantId, userId, revokedAt: null },
    select: { role: true },
  });
  if (roles.length === 0) return true; // the business administrator keeps the register
  return roles.some((row) => ["association_admin", "zone_officer"].includes(row.role));
}

export async function getSponsorshipOverview(): Promise<SponsorshipResponse> {
  const ctx = await requireTenantAdmin();
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));

  const [sponsorRows, sponsorshipRows, coverages, canManage] = await Promise.all([
    db.sponsor.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { name: "asc" } }),
    db.associationSponsorship.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "asc" },
      include: {
        member: { select: { memberCode: true, businessName: true, status: true } },
        fundings: { orderBy: { fundedAt: "asc" } },
      },
    }),
    db.sponsorshipCoverage.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { periodEnd: "desc" },
    }),
    canManageSponsorship(ctx.tenantId, ctx.userId),
  ]);

  const totalFunded = sponsorshipRows.reduce(
    (sum, row) => sum + netFundedPesewa(row.fundings.map((funding) => ({
      kind: funding.kind === "release" ? "release" : "allocation",
      amountPesewa: funding.amountPesewa,
    }))),
    0
  );
  const coveredPesewa = coverages.filter((row) => coverageIsActive(row)).reduce(
    (sum, row) => sum + row.amountPesewa,
    0
  );

  return {
    success: true,
    data: {
      sponsors: sponsorRows.map((sponsor) => {
        const committed = sponsorshipRows
          .filter((row) => row.sponsorId === sponsor.id)
          .flatMap((row) => row.fundings)
          .filter((funding) => funding.fundedAt.getTime() >= yearStart.getTime())
          .reduce(
            (sum, funding) => (funding.kind === "release" ? sum - funding.amountPesewa : sum + funding.amountPesewa),
            0
          );
        return {
          id: sponsor.id,
          name: sponsor.name,
          kind: (sponsor.kind as SponsorKind) ?? "business",
          kindLabel: SPONSOR_KIND_LABELS[(sponsor.kind as SponsorKind) ?? "business"],
          status: sponsor.status,
          contactName: sponsor.contactName,
          email: sponsor.email,
          phone: sponsor.phone,
          taxId: sponsor.taxId,
          subjectTenantId: sponsor.subjectTenantId,
          annualCapPesewa: sponsor.annualCapPesewa,
          committedThisYearPesewa: Math.max(0, committed),
          outstandingPesewa: Math.max(0, (sponsor.annualCapPesewa ?? 0) - committed),
        };
      }),
      sponsorships: sponsorshipRows.map((row) => {
        const funded = row.fundings
          .filter((funding) => funding.kind !== "release")
          .reduce((sum, funding) => sum + funding.amountPesewa, 0);
        const released = row.fundings
          .filter((funding) => funding.kind === "release")
          .reduce((sum, funding) => sum + funding.amountPesewa, 0);
        const active = coverages
          .filter((coverage) => coverage.sponsorshipId === row.id && coverageIsActive(coverage))
          .sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime())[0];
        return {
          id: row.id,
          reference: row.reference,
          memberId: row.memberId,
          memberCode: row.member.memberCode,
          memberName: row.member.businessName,
          memberStatus: row.member.status,
          sponsorId: row.sponsorId,
          sponsorName: row.sponsorName,
          planCode: row.planCode,
          agreedPesewa: Math.round(Number(row.amount) * 100),
          capPesewa: row.fundedCapPesewa,
          fundedPesewa: funded,
          releasedPesewa: released,
          netPesewa: funded - released,
          status: row.status,
          coverageEndsAt: active?.periodEnd.toISOString() ?? null,
          subjectTenantId: row.subjectTenantId,
          funding: row.fundings.map((funding) => ({
            id: funding.id,
            kind: (funding.kind === "release" ? "release" : "allocation") as FundingKind,
            amountPesewa: funding.amountPesewa,
            amountLabel: formatPesewa(funding.amountPesewa),
            reference: funding.reference,
            fundedAt: funding.fundedAt.toISOString(),
            note: funding.note,
          })),
        };
      }),
      unassignedPesewa: Math.max(0, totalFunded - coveredPesewa),
      coveredPesewa,
      canManage,
    },
  };
}

/** Register a sponsor. The name is unique inside the business. */
export async function createSponsor(input: {
  name: string;
  kind: SponsorKind;
  contactName?: string;
  email?: string;
  phone?: string;
  taxId?: string;
  annualCapPesewa?: number | null;
  subjectTenantId?: string | null;
}): Promise<SponsorshipResponse> {
  const ctx = await requireTenantAdmin();
  if (!(await canManageSponsorship(ctx.tenantId, ctx.userId))) {
    return { success: false, error: "Your association role does not allow managing sponsors." };
  }
  const parsed = sponsorSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const duplicate = await db.sponsor.findFirst({
    where: { tenantId: ctx.tenantId, name: values.name },
    select: { id: true },
  });
  if (duplicate) return { success: false, error: "A sponsor with that name already exists." };

  if (values.subjectTenantId) {
    const tenant = await db.businessTenant.findFirst({
      where: { id: values.subjectTenantId },
      select: { id: true },
    });
    if (!tenant) return { success: false, error: "That sponsor business was not found." };
  }

  await db.$transaction(async (tx) => {
    const sponsor = await tx.sponsor.create({
      data: {
        tenantId: ctx.tenantId,
        name: values.name,
        kind: values.kind,
        contactName: values.contactName || null,
        email: values.email || null,
        phone: values.phone || null,
        taxId: values.taxId || null,
        annualCapPesewa: values.annualCapPesewa ?? null,
        subjectTenantId: values.subjectTenantId || null,
        createdById: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "sponsorship.sponsor_created",
      entityType: "sponsor",
      entityId: sponsor.id,
      details: { name: values.name, kind: values.kind, financialMutation: false },
    });
  });
  return getSponsorshipOverview();
}

/**
 * Record a sponsorship agreement.
 *
 * Controlled at creation: an inactive sponsor, a self-sponsorship, an ineligible
 * member and a duplicate active arrangement are all refused here rather than at
 * funding time.
 */
export async function createSponsorshipAgreement(input: {
  memberId: string;
  sponsorId: string;
  planCode?: string;
  amount: number;
  fundedCap?: number;
  subjectTenantId?: string | null;
  startDate?: string;
  endDate?: string;
  reference?: string;
  notes?: string;
}): Promise<SponsorshipResponse> {
  const ctx = await requireTenantAdmin();
  if (!(await canManageSponsorship(ctx.tenantId, ctx.userId))) {
    return { success: false, error: "Your association role does not allow managing sponsorships." };
  }
  const parsed = sponsorshipSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const agreed = toPesewa(values.amount);
  if (agreed.error) return { success: false, error: agreed.error };
  const cap = values.fundedCap ? toPesewa(values.fundedCap) : null;
  if (cap?.error) return { success: false, error: cap.error };
  if (cap && cap.pesewa > agreed.pesewa) {
    return {
      success: false,
      error: "The funding cap cannot be larger than the agreed sponsorship amount.",
    };
  }

  const [member, sponsor] = await Promise.all([
    db.associationMember.findFirst({
      where: { id: values.memberId, tenantId: ctx.tenantId },
      select: { id: true, status: true, businessName: true },
    }),
    db.sponsor.findFirst({
      where: { id: values.sponsorId, tenantId: ctx.tenantId },
      select: { id: true, name: true, status: true, subjectTenantId: true },
    }),
  ]);
  if (!member) return { success: false, error: "That member was not found." };
  if (!sponsor) return { success: false, error: "That sponsor was not found." };
  if (sponsor.status !== "active") {
    return { success: false, error: "That sponsor is inactive." };
  }
  if (member.status !== "active") {
    return {
      success: false,
      error: `That member is ${member.status}, so it cannot be sponsored.`,
    };
  }
  if (sponsor.subjectTenantId && values.subjectTenantId === sponsor.subjectTenantId) {
    return {
      success: false,
      error: "A sponsor cannot fund a subscription for its own business.",
    };
  }

  const duplicate = await db.associationSponsorship.findFirst({
    where: {
      tenantId: ctx.tenantId,
      memberId: values.memberId,
      sponsorId: values.sponsorId,
      status: { in: ["pledged", "active"] },
      ...(values.planCode ? { planCode: values.planCode } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    return {
      success: false,
      error: "This sponsor already has a live arrangement for that member and plan.",
    };
  }

  await db.$transaction(async (tx) => {
    const sponsorship = await tx.associationSponsorship.create({
      data: {
        tenantId: ctx.tenantId,
        memberId: values.memberId,
        sponsorId: values.sponsorId,
        sponsorName: sponsor.name,
        subjectTenantId: values.subjectTenantId || null,
        fundedCapPesewa: cap ? cap.pesewa : agreed.pesewa,
        planCode: values.planCode || null,
        amount: pesewaToCedi(agreed.pesewa),
        status: "pledged",
        startDate: values.startDate ? new Date(values.startDate) : null,
        endDate: values.endDate ? new Date(values.endDate) : null,
        reference: values.reference || null,
        notes: values.notes || null,
        createdById: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "sponsorship.agreement_created",
      entityType: "associationSponsorship",
      entityId: sponsorship.id,
      details: {
        sponsorId: values.sponsorId,
        memberId: values.memberId,
        agreedPesewa: agreed.pesewa,
        capPesewa: cap ? cap.pesewa : agreed.pesewa,
        financialMutation: false,
      },
    });
  });
  return getSponsorshipOverview();
}

/**
 * Record one funding movement.
 *
 * The ledger is append-only and every control is re-checked against the database
 * rather than trusted from the caller: sponsor status, self-sponsorship, member
 * eligibility, the sponsorship cap, the sponsor's yearly cap and, for a release,
 * that the money was actually funded.
 */
export async function recordSponsorshipFunding(input: {
  sponsorshipId: string;
  kind: FundingKind;
  amount: number;
  reference: string;
  fundedAt?: string;
  note?: string;
}): Promise<SponsorshipResponse> {
  const ctx = await requireTenantAdmin();
  if (!(await canManageSponsorship(ctx.tenantId, ctx.userId))) {
    return { success: false, error: "Your association role does not allow recording funding." };
  }
  const parsed = fundingSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const amount = toPesewa(values.amount);
  if (amount.error) return { success: false, error: amount.error };

  const sponsorship = await db.associationSponsorship.findFirst({
    where: { id: values.sponsorshipId, tenantId: ctx.tenantId },
    include: {
      member: { select: { status: true } },
      fundings: { select: { kind: true, amountPesewa: true, fundedAt: true } },
    },
  });
  if (!sponsorship) return { success: false, error: "That sponsorship was not found." };
  const sponsor = sponsorship.sponsorId
    ? await db.sponsor.findFirst({
        where: { id: sponsorship.sponsorId, tenantId: ctx.tenantId },
        select: { id: true, status: true, subjectTenantId: true, annualCapPesewa: true },
      })
    : null;
  if (!sponsor) {
    return {
      success: false,
      error: "Register the sponsor before recording money against this sponsorship.",
    };
  }

  const fundedSoFar = netFundedPesewa(
    sponsorship.fundings.map((row) => ({
      kind: row.kind === "release" ? "release" : "allocation",
      amountPesewa: row.amountPesewa,
    }))
  );
  const year = (values.fundedAt ? new Date(values.fundedAt) : new Date()).getUTCFullYear();
  const otherFundings = await db.sponsorshipFunding.findMany({
    where: {
      tenantId: ctx.tenantId,
      sponsorId: sponsor.id,
      fundedAt: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lt: new Date(Date.UTC(year + 1, 0, 1)),
      },
    },
    select: { kind: true, amountPesewa: true },
  });
  const fundedThisYear = netFundedPesewa(
    otherFundings.map((row) => ({
      kind: row.kind === "release" ? "release" : "allocation",
      amountPesewa: row.amountPesewa,
    }))
  );

  const decision = decideFunding({
    kind: values.kind,
    amountPesewa: amount.pesewa,
    sponsorStatus: sponsor.status,
    selfSponsorship: Boolean(
      sponsor.subjectTenantId && sponsorship.subjectTenantId === sponsor.subjectTenantId
    ),
    memberStatus: sponsorship.member.status,
    sponsorshipCapPesewa: sponsorship.fundedCapPesewa,
    alreadyFundedPesewa: fundedSoFar,
    sponsorAnnualCapPesewa: sponsor.annualCapPesewa,
    sponsorFundedThisYearPesewa: fundedThisYear,
  });
  if (!decision.allowed) {
    return { success: false, error: decision.explanation ?? "The funding was refused." };
  }

  const duplicateReference = await db.sponsorshipFunding.findFirst({
    where: { tenantId: ctx.tenantId, reference: values.reference },
    select: { id: true },
  });
  if (duplicateReference) {
    return { success: false, error: "That funding reference has already been used." };
  }

  await db.$transaction(async (tx) => {
    const funding = await tx.sponsorshipFunding.create({
      data: {
        tenantId: ctx.tenantId,
        sponsorshipId: sponsorship.id,
        sponsorId: sponsor.id,
        kind: values.kind,
        amountPesewa: amount.pesewa,
        fundedAt: values.fundedAt ? new Date(values.fundedAt) : new Date(),
        reference: values.reference,
        note: values.note || null,
        recordedById: ctx.userId,
      },
    });
    // A sponsorship becomes active the first time real money is recorded.
    if (values.kind === "allocation" && sponsorship.status === "pledged") {
      await tx.associationSponsorship.update({
        where: { id: sponsorship.id },
        data: { status: "active" },
      });
    }
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "sponsorship.funding_recorded",
      entityType: "sponsorshipFunding",
      entityId: funding.id,
      details: {
        sponsorshipId: sponsorship.id,
        sponsorId: sponsor.id,
        kind: values.kind,
        amountPesewa: amount.pesewa,
        reference: values.reference,
        financialMutation: false,
      },
    });
  });
  return getSponsorshipOverview();
}

/**
 * Assign funded money to a covered period.
 *
 * The covered business keeps ownership: this row is the only link between the
 * sponsor's money and that business, and the amount cannot exceed what is funded
 * but unassigned.
 */
export async function recordSponsorshipCoverage(input: {
  sponsorshipId: string;
  subjectTenantId: string;
  months: number;
  amount: number;
  note?: string;
}): Promise<SponsorshipResponse> {
  const ctx = await requireTenantAdmin();
  if (!(await canManageSponsorship(ctx.tenantId, ctx.userId))) {
    return { success: false, error: "Your association role does not allow recording coverage." };
  }
  const parsed = coverageSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const amount = toPesewa(values.amount);
  if (amount.error) return { success: false, error: amount.error };

  const sponsorship = await db.associationSponsorship.findFirst({
    where: { id: values.sponsorshipId, tenantId: ctx.tenantId },
    include: { fundings: { select: { kind: true, amountPesewa: true } } },
  });
  if (!sponsorship) return { success: false, error: "That sponsorship was not found." };
  if (sponsorship.sponsorId) {
    const sponsor = await db.sponsor.findFirst({
      where: { id: sponsorship.sponsorId, tenantId: ctx.tenantId },
      select: { subjectTenantId: true },
    });
    if (sponsor?.subjectTenantId && sponsor.subjectTenantId === values.subjectTenantId) {
      return {
        success: false,
        error: "A sponsor cannot cover its own business's subscription.",
      };
    }
  }

  const covered = await db.sponsorshipCoverage.findMany({
    where: { tenantId: ctx.tenantId, sponsorshipId: sponsorship.id },
    select: { amountPesewa: true },
  });
  const funded = netFundedPesewa(
    sponsorship.fundings.map((row) => ({
      kind: row.kind === "release" ? "release" : "allocation",
      amountPesewa: row.amountPesewa,
    }))
  );
  const assigned = covered.reduce((sum, row) => sum + row.amountPesewa, 0);
  if (amount.pesewa > funded - assigned) {
    return {
      success: false,
      error: `Only ${formatPesewa(Math.max(0, funded - assigned))} is funded and not yet assigned to a period.`,
    };
  }

  const tenant = await db.businessTenant.findFirst({
    where: { id: values.subjectTenantId },
    select: { id: true },
  });
  if (!tenant) return { success: false, error: "That covered business was not found." };

  const period = coveragePeriod(new Date(), values.months);
  await db.$transaction(async (tx) => {
    const coverage = await tx.sponsorshipCoverage.create({
      data: {
        tenantId: ctx.tenantId,
        sponsorshipId: sponsorship.id,
        subjectTenantId: values.subjectTenantId,
        periodStart: period.start,
        periodEnd: period.end,
        amountPesewa: amount.pesewa,
        note: values.note || null,
        recordedById: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "sponsorship.coverage_recorded",
      entityType: "sponsorshipCoverage",
      entityId: coverage.id,
      details: {
        sponsorshipId: sponsorship.id,
        subjectTenantId: values.subjectTenantId,
        amountPesewa: amount.pesewa,
        periodEnd: period.end.toISOString(),
        financialMutation: false,
      },
    });
  });
  return getSponsorshipOverview();
}

/**
 * Whether a business has sponsor-funded cover right now.
 *
 * This is the integration point for the billing lifecycle: it reports the cover
 * that exists, and never the sponsor's identity, so a covered business cannot
 * learn who paid unless the association tells it.
 */
export async function getSubscriptionSponsorshipCoverage(subjectTenantId: string): Promise<{
  covered: boolean;
  endsAt: string | null;
  amountPesewa: number;
}> {
  await requireTenantAdmin();
  const rows = await db.sponsorshipCoverage.findMany({
    where: { subjectTenantId, status: "active" },
    orderBy: { periodEnd: "desc" },
    take: 1,
  });
  const row = rows[0];
  if (!row || !coverageIsActive(row)) {
    return { covered: false, endsAt: null, amountPesewa: 0 };
  }
  return {
    covered: true,
    endsAt: row.periodEnd.toISOString(),
    amountPesewa: row.amountPesewa,
  };
}
