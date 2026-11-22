/**
 * Approved MaaCash package presentation.
 *
 * Prices themselves are data: they live in the platform plan catalogue
 * (`ZeliPlan`) and are edited by Platform Super Admin. This module only holds
 * the commercial terms that the owner approved as policy, and the formatting
 * helpers shared by the public page and tests. No price is duplicated here.
 */

export const PRICING_PATH = "/pricing";

/**
 * Current standard monthly prices, in GHS.
 *
 * This object is the single written record of the price a **new** customer is
 * quoted. The database catalogue (`ZeliPlan`) remains the runtime source of truth
 * the pricing page and checkout read; these constants exist so a change cannot be
 * made in one place and forgotten in another, and so the migration that applies a
 * change has something authoritative to compare against.
 *
 * 2026-12 repricing (owner-authorised). Previous prices are kept in
 * `PREVIOUS_PRICES` for the renewal notice and the audit record:
 *
 *   Starter        99 -> 129    Business      169 -> 219    Multi-Branch  339 -> 429
 *   Starter/yr   1070 -> 1390   Business/yr  1825 -> 2365   Multi-Branch/yr 3660 -> 4630
 *
 * Reason: general Zeli conversation is now included in every paid package, and the
 * platform gained closed-loop evidence, offline MoMo, branch liquidity forecasting
 * and shared risk intelligence. The increase is not uniform: it is weighted towards
 * the tiers that gained the most operational surface.
 */
export const APPROVED_MONTHLY_PRICES = {
  starter: 129,
  business: 219,
  "multi-branch": 429,
} as const;

/** Annual prices, priced at a ~10% saving against twelve monthly payments. */
export const APPROVED_ANNUAL_PRICES = {
  starter: 1390,
  business: 2365,
  "multi-branch": 4630,
} as const;

/**
 * Prices a customer may still be paying under an earlier agreement.
 *
 * Never used to quote a new customer. They exist so the billing screen can show an
 * honest renewal notice ("your next renewal is GH₵X, previously GH₵Y") instead of
 * silently charging a different amount at renewal.
 */
export const PREVIOUS_PRICES = {
  starter: 99,
  business: 169,
  "multi-branch": 339,
  "starter-annual": 1070,
  "business-annual": 1825,
  "multi-branch-annual": 3660,
} as const;

/** When the current prices took effect, for the notice and the audit record. */
export const PRICE_CHANGE_EFFECTIVE = "2026-12-01";

/**
 * The AI Investigation add-on price. It is a premium capability: separately
 * purchasable, never bundled into a base package by default, and priced between
 * Starter and Business because it answers a different question ("was this real?")
 * rather than running the business day to day. It is deliberately not equal to any
 * founding-customer price, so the published figure cannot be mistaken for a
 * promotional rate.
 */
export const AI_INVESTIGATION_PRICE = {
  monthly: 159,
  allowance: 50,
  billingInterval: "month",
} as const;

export interface PublicPlan {
  code: string;
  name: string;
  description: string | null;
  billingInterval: string;
  price: number;
  currency: string;
  features: string[];
  usageAllowance: number | null;
  locationLimit: number | null;
  staffLimit: number | null;
  supportLevel: string | null;
}

export function formatGhs(value: number): string {
  return `GH₵${value.toLocaleString("en-GH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function isAnnualPlan(plan: PublicPlan): boolean {
  return plan.billingInterval.toLowerCase() === "year";
}

/** Split the public catalogue into the two sections the page renders. */
export function groupPlansForDisplay(plans: PublicPlan[]) {
  const monthly = plans.filter((plan) => !isAnnualPlan(plan));
  const annual = plans.filter(isAnnualPlan);
  return { monthly, annual };
}

/**
 * Annual saving against twelve monthly payments, as a whole percentage.
 * Returns null when the comparison is not meaningful.
 */
export function annualSavingPercent(
  monthlyPrice: number,
  annualPrice: number
): number | null {
  if (!Number.isFinite(monthlyPrice) || !Number.isFinite(annualPrice)) return null;
  const fullYear = monthlyPrice * 12;
  if (fullYear <= 0 || annualPrice <= 0 || annualPrice >= fullYear) return null;
  return Math.round(((fullYear - annualPrice) / fullYear) * 100);
}

/** Package labels offered in the enquiry form. */
export const ENQUIRY_PACKAGES = ["Starter", "Business", "Multi-Branch", "Not sure yet"] as const;

export interface RenewalNotice {
  currentAmount: number;
  renewalAmount: number;
  currency: string;
  effectiveAt: string | null;
}

/**
 * When the amount a customer is paying differs from the catalogue price, both must be
 * shown before a renewal. Returns null when they agree — there is nothing to announce.
 *
 * This never charges anything and never edits a subscription. It exists so a price
 * change cannot reach an existing customer as a surprise on their statement.
 */
export function renewalNoticeFor(input: {
  subscription: { amount: number; paidAt: Date | null; periodEnd: Date | null; currency: string } | null;
  nextAmount: number | null;
  planCurrency?: string | null;
}): RenewalNotice | null {
  const { subscription, nextAmount } = input;
  if (!subscription || !subscription.paidAt || nextAmount == null) return null;
  if (!Number.isFinite(subscription.amount) || subscription.amount <= 0) return null;
  if (Math.round(subscription.amount * 100) === Math.round(nextAmount * 100)) return null;
  return {
    currentAmount: subscription.amount,
    renewalAmount: nextAmount,
    currency: subscription.currency || input.planCurrency || "GHS",
    effectiveAt: subscription.periodEnd ? subscription.periodEnd.toISOString() : null,
  };
}
