/**
 * Risk Intelligence retention clock.
 *
 * Pure date arithmetic for the approved retention schedule. No database access, no
 * clock reading: callers supply the facts and the current time. The starred
 * entries below are the approved schedule; everything else is a helper.
 *
 *   Active signals         180 days from observedTo (expiry transition)
 *   Expired signals        90 days after expiry
 *   Withdrawn signals      90 days after withdrawal
 *   Disputed signals       adjudication + 90 days after actual resolution
 *   Notes / source pointers  same lifecycle as their parent signal
 *   Disclosure / RI audits  24 months under the current retention determination
 */

export const RISK_ACTIVE_SIGNAL_DAYS = 180;
export const RISK_POST_EXPIRY_DAYS = 90;
export const RISK_POST_WITHDRAWAL_DAYS = 90;
export const RISK_POST_RESOLUTION_DAYS = 90;
export const RISK_AUDIT_RETENTION_MONTHS = 24;
export const RISK_LEGAL_HOLD_REVIEW_DAYS = 14;

const DAY_MS = 86_400_000;

function addDaysUtc(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

/** Calendar months, clamped to the last valid day of the target month. */
export function addMonthsUtc(iso: string, months: number): string {
  const date = new Date(iso);
  const day = date.getUTCDate();
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  target.setUTCHours(
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  );
  return target.toISOString();
}

export interface SignalRetentionState {
  status: string;
  expiresAt: string;
  withdrawnAt?: string | null;
  resolvedAt?: string | null;
}

/**
 * The permanent-deletion deadline for one signal.
 *
 * `null` means "do not delete yet": an open challenge has no final resolution,
 * so the adjudication-plus-90 clock has not started. A legal hold is applied
 * separately by `legalHoldDeadline` and may push the deadline out again.
 */
export function signalDeletionDeadline(signal: SignalRetentionState): string | null {
  if (signal.status === "withdrawn" && signal.withdrawnAt) {
    return addDaysUtc(signal.withdrawnAt, RISK_POST_WITHDRAWAL_DAYS);
  }
  if (signal.status === "disputed_frozen") {
    return signal.resolvedAt
      ? addDaysUtc(signal.resolvedAt, RISK_POST_RESOLUTION_DAYS)
      : null;
  }
  return addDaysUtc(signal.expiresAt, RISK_POST_EXPIRY_DAYS);
}

/** Disclosure and Risk Intelligence audit rows follow the 24-month schedule. */
export function riskAuditDeletionDeadline(createdAt: string): string {
  return addMonthsUtc(createdAt, RISK_AUDIT_RETENTION_MONTHS);
}

export interface LegalHoldState {
  active: boolean;
  reviewDate?: string | null;
  /** Authorised extension of the 21-day target; the only lawful deferral. */
  extensionUntil?: string | null;
}

/**
 * Apply a scoped legal hold to a deletion deadline.
 *
 * An active hold with no authorised extension blocks deletion indefinitely.
 * An authorised extension defers to its stated date. A released hold has no
 * effect. Review/release must happen within 14 days of case closure; that is a
 * separate operational check, not a date arithmetic shortcut here.
 */
export function legalHoldDeadline(
  deadline: string | null,
  hold: LegalHoldState | null
): string | null {
  if (!hold?.active) return deadline;
  if (
    hold.extensionUntil &&
    new Date(hold.extensionUntil).getTime() > Date.now()
  ) {
    return hold.extensionUntil;
  }
  return null;
}

/**
 * Whether a legal hold must be reviewed now.
 * `caseClosureDate` starts the 14-day review clock.
 */
export function legalHoldReviewDue(
  caseClosureDate: string,
  now: string,
  releasedAt?: string | null
): boolean {
  if (releasedAt) return false;
  return new Date(now).getTime() >=
    new Date(caseClosureDate).getTime() + RISK_LEGAL_HOLD_REVIEW_DAYS * DAY_MS;
}

/** Fields removed at the approved deletion deadline. */
export const RISK_SCRUBBED_SIGNAL_FIELDS = [
  "subjectKey",
  "internalNote",
  "sourceId",
] as const;
