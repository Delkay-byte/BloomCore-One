/**
 * Approved MaaCash package presentation.
 *
 * Prices themselves are data: they live in the platform plan catalogue
 * (`ZeliPlan`) and are edited by Platform Super Admin. This module only holds
 * the commercial terms that the owner approved as policy, and the formatting
 * helpers shared by the public page and tests. No price is duplicated here.
 */

export const PRICING_PATH = "/pricing";

/** Approved standard monthly prices, used for catalogue seeding and checks. */
export const APPROVED_MONTHLY_PRICES = {
  starter: 99,
  business: 169,
  "multi-branch": 339,
} as const;

/** Approved annual prices (standard subscriptions, roughly 10% saving). */
export const APPROVED_ANNUAL_PRICES = {
  starter: 1070,
  business: 1825,
  "multi-branch": 3660,
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
