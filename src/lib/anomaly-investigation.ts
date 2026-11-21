/**
 * Anomaly findings: investigation, disposition and suppression.
 *
 * The rule set is deterministic; this module holds the parts a person drives —
 * who owns an investigation, what was checked, why a finding was closed and how
 * long a known false positive stays quiet. Everything here is arithmetic and
 * policy, so it is testable without a database.
 */

import { z } from "zod";

export const INVESTIGATION_STATUSES = [
  "open",
  "investigating",
  "awaiting_evidence",
  "closed",
] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

export const INVESTIGATION_STATUS_LABELS: Record<InvestigationStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  awaiting_evidence: "Waiting for evidence",
  closed: "Closed",
};

export const DISPOSITIONS = ["genuine", "false_positive", "inconclusive"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  genuine: "Confirmed — a real issue",
  false_positive: "False positive",
  inconclusive: "Inconclusive",
};

export const EVENT_LABELS: Record<string, string> = {
  detected: "Detected",
  rescan: "Seen again with new values",
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  commented: "Comment",
  escalated: "Escalated",
  resolved: "Resolved",
  false_positive: "Marked false positive",
  reopened: "Reopened",
  suppressed: "Suppressed",
  correction_linked: "Correction linked",
  task_completed: "Checklist step done",
};

/** A finding this old without a decision is overdue. */
export const SLA_DAYS: Record<string, number> = { high: 2, medium: 5, low: 10 };

export function investigationDueAt(severity: string, from = new Date()): Date {
  const days = SLA_DAYS[severity] ?? SLA_DAYS.medium;
  return new Date(from.getTime() + days * 86_400_000);
}

export function isOverdue(dueAt: Date | null, status: string, now = new Date()): boolean {
  if (!dueAt || status === "closed") return false;
  return dueAt.getTime() < now.getTime();
}

/** The default checklist. A rule-specific step can be added on top. */
export const DEFAULT_CHECKLIST = [
  "Confirm the source records behind this finding",
  "Check who was on duty for the affected period",
  "Compare with the physical count or provider statement",
  "Decide whether a correction or reversal is needed",
] as const;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Whether a scan should reopen a closed finding.
 *
 * A closed finding that is still true is not history, it is an open problem, and
 * silently keeping it closed is how a known issue becomes invisible. Suppression
 * is the only thing that keeps a finding quiet, and it expires.
 */
export function scanDisposition(input: {
  status: string;
  disposition: Disposition | null;
  lastSnapshotHash: string | null;
  newSnapshotHash: string;
  suppressed: boolean;
}): "unchanged" | "updated" | "reopen" | "reopened_open" {
  const changed = input.lastSnapshotHash !== input.newSnapshotHash;
  if (input.status === "resolved") {
    return input.suppressed ? "unchanged" : "reopen";
  }
  return changed ? "updated" : "unchanged";
}

export const MAX_SUPPRESSION_DAYS = 180;
export const MIN_SUPPRESSION_REASON = 10;
/** Never raise more than this many new alerts from one scan. */
export const ALERT_BUDGET_PER_RUN = 3;
/** Do not re-alert the same finding inside this window. */
export const NOTIFY_QUIET_HOURS = 24;

export function suppressionExpiry(days: number, from = new Date()): Date {
  const capped = Math.min(Math.max(1, Math.round(days)), MAX_SUPPRESSION_DAYS);
  return new Date(from.getTime() + capped * 86_400_000);
}

export function suppressionIsActive(
  suppression: { revokedAt: Date | null; expiresAt: Date },
  now = new Date()
): boolean {
  return !suppression.revokedAt && suppression.expiresAt.getTime() > now.getTime();
}

export function suppressionCovers(
  suppression: { ruleKey: string; entityType: string | null; entityId: string | null },
  finding: { ruleKey: string; entityType: string; entityId: string }
): boolean {
  if (suppression.ruleKey !== finding.ruleKey) return false;
  if (!suppression.entityType) return true;
  return suppression.entityType === finding.entityType && suppression.entityId === finding.entityId;
}

/** Which newly created findings may raise a notification in this run. */
export function selectAlerts(
  candidates: Array<{ fingerprint: string; severity: string; lastNotifiedAt: Date | null }>,
  now = new Date()
): Array<{ fingerprint: string; severity: string; lastNotifiedAt: Date | null }> {
  const quietMs = NOTIFY_QUIET_HOURS * 3_600_000;
  return candidates
    .filter((row) => row.severity === "high")
    .filter((row) => !row.lastNotifiedAt || now.getTime() - row.lastNotifiedAt.getTime() > quietMs)
    .slice(0, ALERT_BUDGET_PER_RUN);
}

export const assignAnomalySchema = z.object({
  anomalyId: z.string().min(1),
  assigneeId: z.string().min(1, "Choose who owns this investigation."),
  note: z.string().trim().max(400).optional(),
});

export const investigationStatusSchema = z.object({
  anomalyId: z.string().min(1),
  status: z.enum(["open", "investigating", "awaiting_evidence"]),
  note: z.string().trim().max(400).optional(),
});

export const investigationCommentSchema = z.object({
  anomalyId: z.string().min(1),
  body: z.string().trim().min(2, "Write what you found.").max(1000),
});

export const closeInvestigationSchema = z.object({
  anomalyId: z.string().min(1),
  disposition: z.enum(DISPOSITIONS),
  note: z.string().trim().min(10, "Record what was checked (at least 10 characters).").max(1000),
  suppressDays: z.number().int().min(0).max(MAX_SUPPRESSION_DAYS).optional(),
});

export const suppressionSchema = z.object({
  ruleKey: z.string().min(1),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(80).optional(),
  reason: z
    .string()
    .trim()
    .min(MIN_SUPPRESSION_REASON, "Explain why this rule should stay quiet (at least 10 characters).")
    .max(500),
  days: z.number().int().min(1).max(MAX_SUPPRESSION_DAYS),
});

export const ANOMALY_INVESTIGATION_NOTE =
  "An investigation records what a person checked. Closing a finding never changes a transaction, a count or a balance.";
