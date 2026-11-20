/**
 * Association-sponsored subscriptions.
 *
 * The previous state recorded an agreement and stopped there, which risked being
 * read as "this member is paid for". These rules make the money visible:
 *
 * - a sponsor is an identity, so eligibility and habits can be checked;
 * - funding is an append-only ledger of integer pesewa against an agreed cap;
 * - coverage records what the money pays for, and for which business;
 * - the covered business keeps ownership of its own subscription and data.
 *
 * A refund or credit-note policy is an association decision, so this module
 * records releases (money returned or withdrawn) but does not invent tax or
 * accounting treatment beyond the ledger.
 */

import { z } from "zod";
import { cediToMinor, minorToCedi } from "@/lib/branch-liquidity";

export const SPONSOR_KINDS = ["individual", "business", "association"] as const;
export type SponsorKind = (typeof SPONSOR_KINDS)[number];

export const SPONSOR_KIND_LABELS: Record<SponsorKind, string> = {
  individual: "Individual",
  business: "Business",
  association: "Association",
};

export const SPONSOR_STATUSES = ["active", "inactive"] as const;
export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];

export const FUNDING_KINDS = ["allocation", "release"] as const;
export type FundingKind = (typeof FUNDING_KINDS)[number];

export const MAX_FUNDING_PESEWA = 999_999_999;

export function isSponsorKind(value: string): value is SponsorKind {
  return (SPONSOR_KINDS as readonly string[]).includes(value);
}

export function isFundingKind(value: string): value is FundingKind {
  return (FUNDING_KINDS as readonly string[]).includes(value);
}

/** A cedi input to integer pesewa, refusing a fractional pesewa. */
export function toPesewa(amount: number): { pesewa: number; error?: string } {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { pesewa: 0, error: "Enter an amount greater than zero." };
  }
  const pesewa = cediToMinor(amount);
  if (Math.abs(pesewa - amount * 100) > 1e-6) {
    return { pesewa, error: "An amount cannot have more than two decimal places." };
  }
  if (pesewa > MAX_FUNDING_PESEWA) {
    return { pesewa, error: "That amount is larger than this register allows." };
  }
  return { pesewa };
}

export function pesewaToCedi(pesewa: number): number {
  return minorToCedi(Math.round(pesewa));
}

export function formatPesewa(pesewa: number): string {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    minimumFractionDigits: 2,
  }).format(pesewaToCedi(pesewa));
}

/**
 * A sponsor must not fund its own subscription.
 *
 * Sponsorship is one party paying for another; when the sponsor's own business is
 * the covered business, the arrangement is self-funding and is refused rather
 * than recorded as external support.
 */
export function isSelfSponsorship(
  sponsor: { subjectTenantId: string | null },
  coveredTenantId: string | null | undefined
): boolean {
  return Boolean(sponsor.subjectTenantId && coveredTenantId && sponsor.subjectTenantId === coveredTenantId);
}

export interface FundingEntry {
  kind: FundingKind;
  amountPesewa: number;
}

/** Net funding in integer pesewa: allocations less releases. */
export function netFundedPesewa(entries: FundingEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.kind === "release") return total - Math.max(0, entry.amountPesewa);
    return total + Math.max(0, entry.amountPesewa);
  }, 0);
}

export interface FundingDecision {
  allowed: boolean;
  reason?:
    | "sponsor_inactive"
    | "self_sponsorship"
    | "member_ineligible"
    | "over_sponsorship_cap"
    | "over_sponsor_annual_cap"
    | "release_exceeds_funding";
  explanation?: string;
}

/**
 * Decide whether one funding movement may be recorded.
 *
 * Fail closed: an inactive sponsor, a self-sponsorship, an ineligible member, an
 * amount that would exceed the agreed cap or the sponsor's annual cap, or a
 * release larger than what is held, are all refused with a reason a person can
 * act on.
 */
export function decideFunding(input: {
  kind: FundingKind;
  amountPesewa: number;
  sponsorStatus: string;
  selfSponsorship: boolean;
  memberStatus: string;
  sponsorshipCapPesewa: number | null;
  alreadyFundedPesewa: number;
  sponsorAnnualCapPesewa: number | null;
  sponsorFundedThisYearPesewa: number;
}): FundingDecision {
  if (input.amountPesewa <= 0) {
    return {
      allowed: false,
      reason: "over_sponsorship_cap",
      explanation: "Enter an amount greater than zero.",
    };
  }
  if (input.sponsorStatus !== "active") {
    return {
      allowed: false,
      reason: "sponsor_inactive",
      explanation: "This sponsor is inactive, so no money can be recorded against it.",
    };
  }
  if (input.selfSponsorship) {
    return {
      allowed: false,
      reason: "self_sponsorship",
      explanation:
        "A sponsor cannot fund a subscription for its own business. Record it as a direct subscription instead.",
    };
  }
  if (input.memberStatus !== "active") {
    return {
      allowed: false,
      reason: "member_ineligible",
      explanation: `This member is ${input.memberStatus}, so it cannot be sponsored right now.`,
    };
  }

  if (input.kind === "release") {
    if (input.amountPesewa > input.alreadyFundedPesewa) {
      return {
        allowed: false,
        reason: "release_exceeds_funding",
        explanation: `Only ${formatPesewa(input.alreadyFundedPesewa)} has been funded, so a larger release is not possible.`,
      };
    }
    return { allowed: true };
  }

  if (
    input.sponsorshipCapPesewa !== null &&
    input.alreadyFundedPesewa + input.amountPesewa > input.sponsorshipCapPesewa
  ) {
    return {
      allowed: false,
      reason: "over_sponsorship_cap",
      explanation: `This sponsorship allows ${formatPesewa(input.sponsorshipCapPesewa)} in total and ${formatPesewa(input.alreadyFundedPesewa)} is already funded.`,
    };
  }
  if (
    input.sponsorAnnualCapPesewa !== null &&
    input.sponsorFundedThisYearPesewa + input.amountPesewa > input.sponsorAnnualCapPesewa
  ) {
    return {
      allowed: false,
      reason: "over_sponsor_annual_cap",
      explanation: `This sponsor's yearly cap is ${formatPesewa(input.sponsorAnnualCapPesewa)} and ${formatPesewa(input.sponsorFundedThisYearPesewa)} is already committed this year.`,
    };
  }
  return { allowed: true };
}

/** Coverage is only live while it is active and inside its period. */
export function coverageIsActive(
  coverage: { status: string; periodStart: Date; periodEnd: Date },
  now = new Date()
): boolean {
  if (coverage.status !== "active") return false;
  return (
    coverage.periodStart.getTime() <= now.getTime() &&
    coverage.periodEnd.getTime() > now.getTime()
  );
}

/** A period of `months` starting at `start`, in UTC. */
export function coveragePeriod(start: Date, months: number): { start: Date; end: Date } {
  const from = new Date(start);
  const to = new Date(start);
  to.setUTCMonth(to.getUTCMonth() + Math.max(1, months));
  return { start: from, end: to };
}

export const sponsorSchema = z.object({
  name: z.string().trim().min(2, "Enter the sponsor's name.").max(140),
  kind: z.enum(SPONSOR_KINDS),
  contactName: z.string().trim().max(120).optional(),
  email: z.string().trim().email("Enter a valid email.").optional().or(z.literal("")),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[+\d\s()-]*$/, "Use digits and the usual phone punctuation.")
    .optional()
    .or(z.literal("")),
  taxId: z.string().trim().max(40).optional(),
  annualCapPesewa: z.number().int().min(0).nullable().optional(),
  subjectTenantId: z.string().trim().nullable().optional(),
});

export const sponsorshipSchema = z.object({
  memberId: z.string().min(1, "Choose the member being sponsored."),
  sponsorId: z.string().min(1, "Choose the sponsor."),
  planCode: z.string().trim().max(40).optional(),
  amount: z.number().finite().gt(0, "Enter the agreed amount."),
  fundedCap: z.number().finite().gt(0).optional(),
  subjectTenantId: z.string().trim().nullable().optional(),
  startDate: z.string().trim().optional(),
  endDate: z.string().trim().optional(),
  reference: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const fundingSchema = z.object({
  sponsorshipId: z.string().min(1),
  kind: z.enum(FUNDING_KINDS),
  amount: z.number().finite().gt(0, "Enter an amount greater than zero."),
  reference: z.string().trim().min(3, "Give the funding a reference.").max(60),
  fundedAt: z.string().trim().optional(),
  note: z.string().trim().max(300).optional(),
});

export const coverageSchema = z.object({
  sponsorshipId: z.string().min(1),
  subjectTenantId: z.string().trim().min(1, "Choose the covered business."),
  months: z.number().int().min(1, "Cover at least one month.").max(36),
  amount: z.number().finite().gt(0, "Enter the covered amount."),
  note: z.string().trim().max(300).optional(),
});

export const SPONSORSHIP_DISCLAIMER =
  "Sponsor money is recorded in a ledger. It pays for a member's subscription; it does not give the sponsor any ownership of that business or its data.";
