/**
 * Customer dispute rules.
 *
 * A dispute never changes money. It records the customer's account of one
 * contribution or withdrawal, tracks a two-sided review, and preserves every
 * step. An upheld outcome points at the separate correction/reversal that an
 * administrator must perform through the existing financial controls.
 */

import { z } from "zod";

export const DISPUTE_CATEGORIES = [
  "not_received",
  "wrong_amount",
  "duplicate_charge",
  "unauthorised",
  "other",
] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const DISPUTE_CATEGORY_LABELS: Record<DisputeCategory, string> = {
  not_received: "Payment not received",
  wrong_amount: "Wrong amount",
  duplicate_charge: "Charged twice",
  unauthorised: "Not authorised by me",
  other: "Something else",
};

export const DISPUTE_STATUSES = [
  "open",
  "under_review",
  "awaiting_customer",
  "resolved_upheld",
  "resolved_declined",
  "cancelled",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  open: "Open",
  under_review: "Under review",
  awaiting_customer: "More information needed",
  resolved_upheld: "Resolved — in your favour",
  resolved_declined: "Resolved — records confirmed",
  cancelled: "Cancelled by customer",
};

export const DISPUTE_STATUS_TONES: Record<
  DisputeStatus,
  "neutral" | "attention" | "positive" | "critical" | "info"
> = {
  open: "attention",
  under_review: "info",
  awaiting_customer: "attention",
  resolved_upheld: "positive",
  resolved_declined: "neutral",
  cancelled: "neutral",
};

const TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  open: ["under_review", "cancelled"],
  under_review: ["awaiting_customer", "resolved_upheld", "resolved_declined"],
  awaiting_customer: ["under_review", "resolved_upheld", "resolved_declined"],
  resolved_upheld: [],
  resolved_declined: [],
  cancelled: [],
};

export function canTransitionDispute(from: DisputeStatus, to: DisputeStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isDisputeStatus(value: string): value is DisputeStatus {
  return (DISPUTE_STATUSES as readonly string[]).includes(value);
}

export function isDisputeCategory(value: string): value is DisputeCategory {
  return (DISPUTE_CATEGORIES as readonly string[]).includes(value);
}

export type DisputeSubjectType = "contribution" | "withdrawal";

export function isDisputeSubjectType(value: string): value is DisputeSubjectType {
  return value === "contribution" || value === "withdrawal";
}

export function subjectLabel(type: DisputeSubjectType): string {
  return type === "contribution" ? "contribution" : "withdrawal";
}

export const openDisputeSchema = z.object({
  subjectType: z.enum(["contribution", "withdrawal"]),
  subjectId: z.string().min(1, "Choose the transaction you are disputing."),
  category: z.enum(DISPUTE_CATEGORIES),
  details: z
    .string()
    .trim()
    .min(10, "Explain what happened in at least 10 characters.")
    .max(1000, "Keep the explanation under 1000 characters."),
  evidenceReference: z
    .string()
    .trim()
    .max(300, "Evidence reference must be 300 characters or fewer.")
    .optional(),
});

export const respondToDisputeSchema = z.object({
  disputeId: z.string().min(1),
  note: z
    .string()
    .trim()
    .min(5, "Add at least 5 characters of information.")
    .max(1000, "Keep the information under 1000 characters."),
});

export const resolveDisputeSchema = z.object({
  disputeId: z.string().min(1),
  outcome: z.enum(["upheld", "declined"]),
  note: z
    .string()
    .trim()
    .min(10, "Record the evidence checked and the outcome (at least 10 characters).")
    .max(1000, "Keep the outcome under 1000 characters."),
  outcomeReference: z.string().trim().max(120).optional(),
  resolutionEvidence: z
    .string()
    .trim()
    .max(300, "Resolution evidence must be 300 characters or fewer.")
    .optional(),
});

export const requestDisputeInfoSchema = z.object({
  disputeId: z.string().min(1),
  note: z
    .string()
    .trim()
    .min(5, "Say what information is needed (at least 5 characters).")
    .max(1000),
});

export function generateDisputeReference(now: Date, random: string): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `DSP-${stamp}-${random}`.slice(0, 40);
}

export function outcomeStatus(outcome: "upheld" | "declined"): DisputeStatus {
  return outcome === "upheld" ? "resolved_upheld" : "resolved_declined";
}

/** A dispute is still being worked while it is in any non-final status. */
export function isOpenDispute(status: string): boolean {
  return status === "open" || status === "under_review" || status === "awaiting_customer";
}
