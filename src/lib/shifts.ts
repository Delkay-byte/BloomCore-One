/**
 * Shift and two-sided handover rules.
 *
 * Shifts are sub-day accountability snapshots. They are deliberately NOT
 * summed into the daily account: the daily account remains the single
 * financial close for the business day. A handover preserves both sides of the
 * count and never lets the receiver overwrite what the outgoing employee
 * declared.
 */

import { z } from "zod";
import { hasCurrencyPrecision } from "./expense-lines";
import { openingDifferenceIsMaterial } from "./momo-ledger";

export const SHIFT_NAMES = ["morning", "afternoon", "evening", "custom"] as const;
export type ShiftName = (typeof SHIFT_NAMES)[number];

export const SHIFT_NAME_LABELS: Record<ShiftName, string> = {
  morning: "Morning shift",
  afternoon: "Afternoon shift",
  evening: "Evening shift",
  custom: "Custom shift",
};

export const SHIFT_STATUSES = [
  "draft",
  "open",
  "awaiting_handover",
  "variance_open",
  "closed",
  "cancelled",
] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const SHIFT_STATUS_LABELS: Record<ShiftStatus, string> = {
  draft: "Draft",
  open: "Open",
  awaiting_handover: "Awaiting handover confirmation",
  variance_open: "Handover variance open",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const SHIFT_STATUS_TONES: Record<
  ShiftStatus,
  "neutral" | "attention" | "positive" | "critical"
> = {
  draft: "neutral",
  open: "attention",
  awaiting_handover: "attention",
  variance_open: "critical",
  closed: "positive",
  cancelled: "neutral",
};

const SHIFT_TRANSITIONS: Record<ShiftStatus, ShiftStatus[]> = {
  draft: ["open", "cancelled"],
  open: ["awaiting_handover", "cancelled"],
  awaiting_handover: ["closed", "variance_open"],
  variance_open: ["closed"],
  closed: [],
  cancelled: [],
};

export function canShiftTransition(from: ShiftStatus, to: ShiftStatus): boolean {
  return (SHIFT_TRANSITIONS[from] ?? []).includes(to);
}

export function isShiftName(value: unknown): value is ShiftName {
  return typeof value === "string" && (SHIFT_NAMES as readonly string[]).includes(value);
}

export interface HandoverVariance {
  cashVariance: number;
  floatVariance: number;
  totalVariance: number;
  balanced: boolean;
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Difference between what the outgoing employee declared and what the receiver
 * physically counted. Positive means the receiver found more.
 */
export function computeHandoverVariance(input: {
  outgoingCash: unknown;
  outgoingFloat: unknown;
  incomingCash: unknown;
  incomingFloat: unknown;
}): HandoverVariance {
  const cashVariance = money(money(input.incomingCash) - money(input.outgoingCash));
  const floatVariance = money(money(input.incomingFloat) - money(input.outgoingFloat));
  return {
    cashVariance,
    floatVariance,
    totalVariance: money(cashVariance + floatVariance),
    balanced: cashVariance === 0 && floatVariance === 0,
  };
}

export function describeHandoverVariance(variance: HandoverVariance): string {
  if (variance.balanced) return "Both sides agree";
  return `Cash ${variance.cashVariance >= 0 ? "+" : ""}${variance.cashVariance.toFixed(
    2
  )}, float ${variance.floatVariance >= 0 ? "+" : ""}${variance.floatVariance.toFixed(2)}`;
}

/** Materiality for a manually adjusted shift opening. */
export const MATERIAL_SHIFT_OPENING_DIFFERENCE = 1;

export function shiftOpeningIsMaterial(
  manual: { cash: unknown; float: unknown },
  reference: { cash: unknown; float: unknown }
): boolean {
  return openingDifferenceIsMaterial(manual, reference);
}

export interface ShiftOpeningCarry {
  available: boolean;
  sourceShiftId: string | null;
  sourceLabel: string | null;
  openingCash: number | null;
  openingMomoFloat: number | null;
  reason: "no_prior_shift" | "prior_not_closed" | "prior_variance" | null;
}

/**
 * Policy: only a fully closed previous shift with no unresolved handover
 * variance can seed the next shift's opening. Anything else stays manual and
 * has to be explained.
 */
export function decideShiftOpeningCarry(prior: {
  id: string;
  label: string | null;
  status: string;
  closingCash: unknown;
  closingMomoFloat: unknown;
  openVariance: boolean;
} | null): ShiftOpeningCarry {
  if (!prior) {
    return {
      available: false,
      sourceShiftId: null,
      sourceLabel: null,
      openingCash: null,
      openingMomoFloat: null,
      reason: "no_prior_shift",
    };
  }
  const base = {
    sourceShiftId: prior.id,
    sourceLabel: prior.label,
    openingCash: null,
    openingMomoFloat: null,
  };
  if (prior.status !== "closed") {
    return { ...base, available: false, reason: "prior_not_closed" };
  }
  if (prior.openVariance) {
    return { ...base, available: false, reason: "prior_variance" };
  }
  return {
    ...base,
    available: true,
    openingCash: money(prior.closingCash),
    openingMomoFloat: money(prior.closingMomoFloat),
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const amount = (label: string) =>
  z
    .number()
    .finite(`${label} must be a number.`)
    .min(0, `${label} cannot be negative.`)
    .max(999_999_999.99, `${label} is too large.`)
    .refine(hasCurrencyPrecision, `${label} must use no more than two decimal places.`);

export const createShiftSchema = z.object({
  locationId: z.string().min(1, "Choose a location."),
  businessDate: z.string().min(1, "Choose the business date."),
  name: z.enum(SHIFT_NAMES),
  label: z.string().trim().max(60).optional(),
  assignedUserId: z.string().min(1, "Choose the employee for this shift."),
  scheduledStart: z.string().optional(),
  scheduledEnd: z.string().optional(),
  openingCash: amount("Opening cash"),
  openingMomoFloat: amount("Opening E-cash"),
  openingAdjustmentReason: z.string().trim().max(500).optional(),
});

export const closeShiftSchema = z.object({
  shiftId: z.string().min(1),
  closingCash: amount("Closing cash"),
  closingMomoFloat: amount("Closing E-cash"),
  handoverToUserId: z.string().min(1, "Choose the employee receiving the handover."),
  outstandingOperations: z.string().trim().max(1000).optional(),
  outgoingNotes: z.string().trim().max(500).optional(),
  outgoingEvidence: z.string().trim().max(300, "Outgoing evidence must be 300 characters or fewer.").optional(),
  // A single-use proof of the actor's own identity, required only when the
  // business enforces shared-device actor proof.
  actorProofToken: z.string().trim().max(512).optional(),
});

export const confirmHandoverSchema = z.object({
  handoverId: z.string().min(1),
  incomingCash: amount("Counted cash"),
  incomingMomoFloat: amount("Counted E-cash"),
  operationsAccepted: z.boolean(),
  incomingNotes: z.string().trim().max(500).optional(),
  incomingEvidence: z.string().trim().max(300, "Incoming evidence must be 300 characters or fewer.").optional(),
});

export const resolveHandoverSchema = z.object({
  handoverId: z.string().min(1),
  resolutionNote: z
    .string()
    .trim()
    .min(10, "Record an investigation conclusion of at least 10 characters.")
    .max(500),
  stepUpToken: z.string().optional(),
});

export function generateShiftReference(now: Date, random: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `SHF-${stamp}-${random}`.slice(0, 40);
}

export function generateHandoverReference(now: Date, random: string): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `HND-${stamp}-${random}`.slice(0, 40);
}
