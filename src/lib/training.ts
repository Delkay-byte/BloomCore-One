/**
 * Training and certification rules.
 *
 * The previous state was a register of manually entered training events. These
 * rules make completion and certification facts rather than opinions:
 *
 * - a learner completes a course only when attendance and a passing assessment
 *   attempt both satisfy the course criteria;
 * - a certificate is issued from a completed enrolment, carries an expiry and a
 *   verification token, and can be revoked with a reason;
 * - a verification lookup answers issued / expired / revoked without exposing
 *   contact details.
 *
 * Nothing here grants a licence or a regulatory credential, and nothing here
 * writes a financial row.
 */

import { z } from "zod";

export const TRAINING_COURSE_STATUSES = ["draft", "published", "retired"] as const;
export type TrainingCourseStatus = (typeof TRAINING_COURSE_STATUSES)[number];

export const TRAINING_COURSE_STATUS_LABELS: Record<TrainingCourseStatus, string> = {
  draft: "Draft",
  published: "Published",
  retired: "Retired",
};

export const TRAINING_ENROLMENT_STATUSES = [
  "enrolled",
  "in_progress",
  "completed",
  "failed",
  "withdrawn",
] as const;
export type TrainingEnrolmentStatus = (typeof TRAINING_ENROLMENT_STATUSES)[number];

export const TRAINING_ENROLMENT_STATUS_LABELS: Record<
  TrainingEnrolmentStatus,
  string
> = {
  enrolled: "Enrolled",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Not yet passed",
  withdrawn: "Withdrawn",
};

export function isCourseStatus(value: string): value is TrainingCourseStatus {
  return (TRAINING_COURSE_STATUSES as readonly string[]).includes(value);
}

export function isEnrolmentStatus(value: string): value is TrainingEnrolmentStatus {
  return (TRAINING_ENROLMENT_STATUSES as readonly string[]).includes(value);
}

/** A certificate is only real while it is issued and inside its validity. */
export type CertificateState = "issued" | "expired" | "revoked" | "unknown";

export function certificateState(
  record:
    | {
        status: string;
        issuedAt: Date;
        expiresAt: Date;
        revokedAt: Date | null;
      }
    | null
    | undefined,
  now = new Date()
): CertificateState {
  if (!record) return "unknown";
  if (record.status === "revoked" || record.revokedAt) return "revoked";
  if (record.expiresAt.getTime() <= now.getTime()) return "expired";
  return "issued";
}

export const CERTIFICATE_STATE_LABELS: Record<CertificateState, string> = {
  issued: "Valid certificate",
  expired: "Expired certificate",
  revoked: "Revoked certificate",
  unknown: "No certificate found for that reference",
};

/**
 * The completion rule.
 *
 * Attendance is measured against the sessions that were actually held, so a
 * cancelled session cannot lower somebody's percentage. A course with no sessions
 * does not fail a learner on attendance; the assessment still has to pass.
 */
export interface CompletionInput {
  requiredAttendancePct: number;
  passingScore: number;
  sessionsHeld: number;
  sessionsAttended: number;
  bestScore: number | null;
}

export interface CompletionResult {
  complete: boolean;
  attendancePct: number;
  bestScore: number | null;
  reasons: string[];
}

export function evaluateCompletion(input: CompletionInput): CompletionResult {
  const reasons: string[] = [];
  const attendancePct =
    input.sessionsHeld > 0
      ? Math.min(100, Math.round((input.sessionsAttended / input.sessionsHeld) * 100))
      : 100;
  if (input.sessionsHeld > 0 && attendancePct < input.requiredAttendancePct) {
    reasons.push(
      `Attendance ${attendancePct}% is below the required ${input.requiredAttendancePct}%.`
    );
  }
  if (input.bestScore === null) {
    reasons.push("No assessment attempt has been recorded.");
  } else if (input.bestScore < input.passingScore) {
    reasons.push(
      `Best score ${input.bestScore} is below the pass mark of ${input.passingScore}.`
    );
  }
  return {
    complete: reasons.length === 0,
    attendancePct,
    bestScore: input.bestScore,
    reasons,
  };
}

/** Certificate expiry, calculated from the course's validity period. */
export function certificateExpiry(issuedAt: Date, validityMonths: number): Date {
  const expiry = new Date(issuedAt);
  expiry.setUTCMonth(expiry.getUTCMonth() + Math.max(1, validityMonths));
  return expiry;
}

/** How long the certificate row and its evidence are kept after expiry. */
export function certificateRetention(expiresAt: Date, retentionYears: number): Date {
  const until = new Date(expiresAt);
  until.setUTCFullYear(until.getUTCFullYear() + Math.max(1, retentionYears));
  return until;
}

/** A serial someone can read over the phone: course code, year, sequence. */
export function certificateSerial(
  courseCode: string,
  issuedAt: Date,
  sequence: number
): string {
  const code = courseCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8) || "COURSE";
  return `${code}-${issuedAt.getUTCFullYear()}-${String(sequence).padStart(4, "0")}`;
}

/** Mask a learner's name for the public verification page. */
export function maskLearnerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "Learner";
  const first = parts[0]!;
  const initial = first.charAt(0).toUpperCase();
  return parts.length > 1 ? `${initial}. ${parts[parts.length - 1]}` : `${initial}.`;
}

export const trainingCourseSchema = z.object({
  associationId: z.string().min(1, "Choose an association."),
  code: z
    .string()
    .trim()
    .min(2, "Enter a course code of at least 2 characters.")
    .max(24)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),
  title: z.string().trim().min(3, "Enter the course title.").max(160),
  version: z.string().trim().max(20).optional(),
  description: z.string().trim().max(1000).optional(),
  passingScore: z.number().int().min(1, "A pass mark is at least 1.").max(100),
  requiredAttendancePct: z
    .number()
    .int()
    .min(0, "Attendance cannot be negative.")
    .max(100, "Attendance cannot exceed 100%."),
  validityMonths: z.number().int().min(1).max(120),
  retentionYears: z.number().int().min(1).max(20),
});

export const trainingModuleSchema = z.object({
  courseId: z.string().min(1),
  position: z.number().int().min(1, "Modules are numbered from 1.").max(200),
  title: z.string().trim().min(3, "Give the module a title.").max(160),
  content: z.string().trim().max(20000).optional(),
  resourceUrl: z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => !value || /^https:\/\//.test(value),
      "A resource link must start with https://."
    )
    .optional(),
});

export const trainingSessionSchema = z.object({
  courseId: z.string().min(1),
  title: z.string().trim().min(3, "Give the session a title.").max(160),
  scheduledAt: z.string().trim().min(1, "Choose a date and time."),
  durationMinutes: z.number().int().min(15).max(480),
  location: z.string().trim().max(160).optional(),
  trainerName: z.string().trim().max(120).optional(),
});

export const enrolmentSchema = z
  .object({
    courseId: z.string().min(1),
    memberId: z.string().trim().nullable().optional(),
    userId: z.string().trim().nullable().optional(),
    learnerName: z.string().trim().min(2, "Enter the learner's name.").max(160),
  })
  .refine((value) => Boolean(value.memberId) !== Boolean(value.userId), {
    message: "Choose either an association member or a staff user as the learner.",
    path: ["memberId"],
  });

export const attendanceSchema = z.object({
  sessionId: z.string().min(1),
  enrolmentId: z.string().min(1),
  /** Minutes actually attended; a partial attendance is recorded as such. */
  minutes: z.number().int().min(0).max(480),
  note: z.string().trim().max(300).optional(),
});

export const attemptSchema = z.object({
  assessmentId: z.string().min(1),
  enrolmentId: z.string().min(1),
  score: z.number().int().min(0, "A score cannot be negative."),
  assessorName: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
});

export const certificateRevokeSchema = z.object({
  certificateId: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(10, "Say why the certificate is being revoked (10 characters).")
    .max(500),
});

export const TRAINING_DISCLAIMER =
  "This training record is an association record. It is not a regulatory licence, and completion does not certify anyone with a regulator.";
