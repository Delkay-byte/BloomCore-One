/**
 * Subject-rights service-level clock. Pure; no database and no clock reading.
 *
 * Approved levels:
 *   acknowledge within 3 business days
 *   resolve within 21 calendar days
 *   one authorised extension of up to 14 calendar days, decided in writing
 *     before the original deadline
 *   freeze the subject and signals for the entire adjudication
 *
 * Business days skip Saturdays and Sundays and Ghanaian public holidays from
 * the versioned calendar in ghana-holidays.ts. The calendar version is recorded
 * on the case so the acknowledgement deadline can be reproduced.
 */

import {
  ghanaHolidayCalendarVersion,
  isGhanaPublicHoliday,
} from "@/lib/risk-intelligence/ghana-holidays";

export const RIGHTS_ACK_BUSINESS_DAYS = 3;
export const RIGHTS_RESOLUTION_CALENDAR_DAYS = 21;
export const RIGHTS_EXTENSION_CALENDAR_DAYS = 14;

const DAY_MS = 86_400_000;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/** Add business days, preserving the time of day. */
export function addBusinessDays(iso: string, count: number): string {
  const date = new Date(iso);
  let added = 0;
  while (added < count) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (!isWeekend(date) && !isGhanaPublicHoliday(date)) added += 1;
  }
  return date.toISOString();
}

function addCalendarDays(iso: string, count: number): string {
  return new Date(new Date(iso).getTime() + count * DAY_MS).toISOString();
}

export interface RightsDeadlines {
  ackDeadline: string;
  resolutionDeadline: string;
  holidayCalendarVersion: string;
}

export function computeRightsDeadlines(receivedAt: string): RightsDeadlines {
  return {
    ackDeadline: addBusinessDays(receivedAt, RIGHTS_ACK_BUSINESS_DAYS),
    resolutionDeadline: addCalendarDays(receivedAt, RIGHTS_RESOLUTION_CALENDAR_DAYS),
    holidayCalendarVersion: ghanaHolidayCalendarVersion(),
  };
}

/**
 * Apply the single permitted extension.
 *
 * The caller must record the written, reasoned privacy notice and must issue it
 * before the original deadline; those are checked by the server action, not
 * by this date helper.
 */
export function applyRightsExtension(
  resolutionDeadline: string,
  writtenReason: string
): string {
  // The reason is recorded by the caller; it is required before this helper
  // may be used. Keeping it as a parameter prevents an extension without one.
  if (writtenReason.trim().length === 0) {
    throw new Error("A written, reasoned privacy notice is required for an extension.");
  }
  return addCalendarDays(resolutionDeadline, RIGHTS_EXTENSION_CALENDAR_DAYS);
}

export function isOverdue(deadline: string, now: string): boolean {
  return new Date(now).getTime() > new Date(deadline).getTime();
}

export const SUBJECT_RIGHT_TYPES = [
  "access",
  "correction",
  "objection",
  "challenge",
  "complaint_review",
] as const;

export type SubjectRightType = (typeof SUBJECT_RIGHT_TYPES)[number];

/** Objection and challenge always freeze the subject; the rest are reviewed. */
export function requiresFreeze(type: SubjectRightType): boolean {
  return type === "objection" || type === "challenge" || type === "complaint_review";
}
