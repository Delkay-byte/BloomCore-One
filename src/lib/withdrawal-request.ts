/**
 * Customer withdrawal requests.
 *
 * A request is a review record, never a posting. The customer states an amount
 * and a reason; the office decides; approving it runs the same withdrawal action
 * the staff screen uses. Money is integer pesewa throughout so no rounding can
 * happen between what the customer asked for and what the ledger records.
 */

import { z } from "zod";
import { cediToMinor, minorToCedi } from "@/lib/branch-liquidity";

export const WITHDRAWAL_REQUEST_STATUSES = [
  "requested",
  "approved",
  "paid",
  "rejected",
  "cancelled",
  "needs_review",
  "awaiting_payment",
  "disputed",
  "reversed",
] as const;

export type WithdrawalRequestStatus = (typeof WITHDRAWAL_REQUEST_STATUSES)[number];

/** Statuses that still hold money against the customer's balance. */
export const OPEN_WITHDRAWAL_REQUEST_STATUSES: WithdrawalRequestStatus[] = [
  "requested",
  "approved",
  "needs_review",
  "awaiting_payment",
];

export const MIN_REASON_LENGTH = 10;
export const MAX_WITHDRAWAL_PESEWA = 99_999_999; // GH¢999,999.99

export const withdrawalRequestSchema = z.object({
  accountId: z.string().trim().min(1, "Choose the account to withdraw from."),
  /** Cedi amount as typed by the customer; converted once, on the server. */
  amount: z
    .number({ message: "Enter the amount you want to withdraw." })
    .finite("Enter a valid amount.")
    .gt(0, "Enter an amount greater than zero."),
  reason: z
    .string()
    .trim()
    .min(
      MIN_REASON_LENGTH,
      `Explain in at least ${MIN_REASON_LENGTH} characters why you are withdrawing.`
    )
    .max(500, "Keep the reason under 500 characters."),
});

export type WithdrawalRequestInput = z.infer<typeof withdrawalRequestSchema>;

export const WITHDRAWAL_DECISION_SCHEMA = z.object({
  note: z
    .string()
    .trim()
    .min(
      MIN_REASON_LENGTH,
      `Explain the decision in at least ${MIN_REASON_LENGTH} characters.`
    )
    .max(500, "Keep the note under 500 characters."),
});
export type WithdrawalDecisionInput = z.infer<typeof WITHDRAWAL_DECISION_SCHEMA>;

/** Convert a typed cedi amount to pesewa, rejecting any fractional pesewa. */
export function toPesewa(amount: number): { pesewa: number; error?: string } {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { pesewa: 0, error: "Enter an amount greater than zero." };
  }
  const pesewa = cediToMinor(amount);
  if (Math.abs(pesewa - amount * 100) > 1e-6) {
    return { pesewa, error: "An amount cannot have more than two decimal places." };
  }
  if (pesewa > MAX_WITHDRAWAL_PESEWA) {
    return { pesewa, error: "That amount is larger than this account allows." };
  }
  return { pesewa };
}

/** Convert any stored money value (Decimal or number) to integer pesewa. */
export function moneyToPesewa(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return cediToMinor(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? cediToMinor(parsed) : 0;
  }
  if (typeof value === "object" && "toNumber" in (value as Record<string, unknown>)) {
    const numeric = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(numeric) ? cediToMinor(numeric) : 0;
  }
  if (typeof value === "object" && "toString" in (value as Record<string, unknown>)) {
    const parsed = Number((value as { toString: () => string }).toString());
    return Number.isFinite(parsed) ? cediToMinor(parsed) : 0;
  }
  return 0;
}

export interface CycleMoney {
  contributions: unknown[];
  withdrawals: unknown[];
  commissions: unknown[];
}

/**
 * What the customer could withdraw from this cycle today.
 *
 * The same rule the staff screen uses: contributions minus withdrawals minus
 * commissions. Computed in integer pesewa, and never negative.
 */
export function cycleAvailablePesewa(cycle: CycleMoney): number {
  const contributed = cycle.contributions.reduce<number>(
    (total, row) => total + moneyToPesewa((row as { amount?: unknown }).amount),
    0
  );
  // A withdrawal stores what was requested; the net paid amount is lower
  // whenever a commission applies, and the commission is subtracted separately.
  const withdrawn = cycle.withdrawals.reduce<number>(
    (total, row) =>
      total + moneyToPesewa((row as { requestedAmount?: unknown }).requestedAmount),
    0
  );
  const commission = cycle.commissions.reduce<number>(
    (total, row) => total + moneyToPesewa((row as { amount?: unknown }).amount),
    0
  );
  return Math.max(0, contributed - withdrawn - commission);
}

export function reservedPesewa(requests: Array<{ amountPesewa: number }>): number {
  return requests.reduce((total, row) => total + Math.max(0, row.amountPesewa), 0);
}

export function formatPesewa(pesewa: number): string {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    minimumFractionDigits: 2,
  }).format(minorToCedi(pesewa));
}

export const WITHDRAWAL_STATUS_LABELS: Record<WithdrawalRequestStatus, string> = {
  requested: "Waiting for the office",
  approved: "Approved, being paid",
  paid: "Paid",
  rejected: "Declined",
  cancelled: "Cancelled by you",
  needs_review: "Needs a person to review",
  awaiting_payment: "Approved, awaiting payment",
  disputed: "Disputed",
  reversed: "Reversed",
};

/** A request the customer may still cancel themselves. */
export function customerCanCancel(status: string): boolean {
  return status === "requested";
}

export const WITHDRAWAL_REQUEST_DISCLAIMER =
  "A request does not move money. The office approves it, and only then is a withdrawal recorded and a receipt sent.";
