/**
 * Tenant operational policy — the explicit business rules behind shift
 * accountability and shared-device identity proof.
 *
 * These settings exist so the product never claims a control it does not
 * enforce. A business that requires shifts gets a real refusal at daily close;
 * a business that runs shared devices can require an actor to prove identity
 * again before a sensitive count is submitted.
 */

import { z } from "zod";

export interface TenantOperationalPolicyValues {
  shiftsRequired: boolean;
  actorProofForSensitiveCounts: boolean;
  offlineIdleLockMinutes: number | null;
  note: string | null;
}

/** Product default for the offline idle lock, matching the unlock module. */
export const DEFAULT_OFFLINE_IDLE_LOCK_MINUTES = 15;
export const MIN_OFFLINE_IDLE_LOCK_MINUTES = 1;
export const MAX_OFFLINE_IDLE_LOCK_MINUTES = 120;

export const DEFAULT_OPERATIONAL_POLICY: TenantOperationalPolicyValues = {
  shiftsRequired: false,
  actorProofForSensitiveCounts: false,
  offlineIdleLockMinutes: null,
  note: null,
};

export const tenantPolicySchema = z.object({
  shiftsRequired: z.boolean(),
  actorProofForSensitiveCounts: z.boolean(),
  offlineIdleLockMinutes: z
    .union([z.number().int(), z.null()])
    .optional()
    .refine(
      (value) =>
        value === undefined ||
        value === null ||
        (value >= MIN_OFFLINE_IDLE_LOCK_MINUTES && value <= MAX_OFFLINE_IDLE_LOCK_MINUTES),
      {
        message: `Choose between ${MIN_OFFLINE_IDLE_LOCK_MINUTES} and ${MAX_OFFLINE_IDLE_LOCK_MINUTES} minutes.`,
      }
    ),
  note: z.string().trim().max(500).optional(),
});

export type TenantPolicyInput = z.infer<typeof tenantPolicySchema>;

export const SHIFT_POLICY_SUMMARY = {
  optional:
    "Shifts are optional. Workers can open and close a shift, but a daily close does not depend on one.",
  required:
    "Shifts are required. A worker cannot submit a daily close without a closed shift for that employee, branch and business day.",
} as const;

export const ACTOR_PROOF_SUMMARY = {
  off: "Sensitive counts rely on the signed-in session only.",
  on: "Before a shift count or a daily close is submitted, the actor enters their own password again. The proof is recorded against that record.",
} as const;

export function shiftPolicySummary(required: boolean): string {
  return required ? SHIFT_POLICY_SUMMARY.required : SHIFT_POLICY_SUMMARY.optional;
}

/** Minutes actually enforced, resolving the product default. */
export function effectiveIdleLockMinutes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_OFFLINE_IDLE_LOCK_MINUTES;
  }
  return Math.min(
    MAX_OFFLINE_IDLE_LOCK_MINUTES,
    Math.max(MIN_OFFLINE_IDLE_LOCK_MINUTES, Math.round(value))
  );
}

export function actorProofSummary(enabled: boolean): string {
  return enabled ? ACTOR_PROOF_SUMMARY.on : ACTOR_PROOF_SUMMARY.off;
}

/** Reason shown to a worker whose daily close is blocked by the shift policy. */
export const SHIFT_REQUIRED_REFUSAL =
  "This business requires a shift. Ask your administrator to open a shift for you, then close it before submitting the day.";

/** Reason shown when a sensitive count needs fresh proof of identity. */
export const ACTOR_PROOF_REQUIRED =
  "This business requires you to confirm your password before a sensitive count is submitted.";

/** Which sensitive actions count as a shared-device identity checkpoint. */
export const SENSITIVE_COUNT_ACTIONS = ["shift_count", "daily_close"] as const;
export type SensitiveCountAction = (typeof SENSITIVE_COUNT_ACTIONS)[number];

/**
 * The business day a worker's close belongs to, so the shift policy looks at the
 * same day the operator is closing rather than "today".
 */
export function businessDayBounds(value: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
