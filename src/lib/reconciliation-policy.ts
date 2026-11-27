/**
 * Phase 5 — reconciliation and exception-management policy.
 *
 * This module is deliberately free of Node built-ins so the server actions and
 * the browser screens share exactly the same labels and state machines.
 *
 * The classifications are operational, never accusatory. A shortfall is a cash
 * difference; a duplicate is two records with the same business fingerprint;
 * neither is labelled fraud or given a risk score.
 */

export const RECONCILIATION_TYPES = [
  "daily_close",
  "branch_close",
  "remittance",
  "sync",
  "other",
] as const;
export type ReconciliationType = (typeof RECONCILIATION_TYPES)[number];

export const RECONCILIATION_TYPE_LABELS: Record<string, string> = {
  daily_close: "Daily collector closing",
  branch_close: "Branch reconciliation",
  remittance: "Remittance reconciliation",
  sync: "Offline synchronization",
  other: "Other Susu exception",
};

export const SESSION_STATUSES = [
  "open",
  "matching",
  "matched",
  "reviewed",
  "case_created",
  "closed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  matching: "Matching",
  matched: "Differences detected",
  reviewed: "Reviewed",
  case_created: "Cases raised",
  closed: "Closed",
};

/** Closed is terminal. A new run needs a new session, preserving the trail. */
const SESSION_TRANSITIONS: Record<string, string[]> = {
  open: ["matching", "closed"],
  matching: ["matched", "closed"],
  matched: ["matching", "reviewed", "case_created", "closed"],
  reviewed: ["closed"],
  case_created: ["matching", "reviewed", "closed"],
  closed: [],
};

export function canTransitionSession(from: string, to: string): boolean {
  return (SESSION_TRANSITIONS[from] ?? []).includes(to);
}

/** A detection run may start only from these statuses. */
export const SESSION_RUNNABLE_STATUSES = ["open", "matched", "case_created"] as const;

export const LINE_STATUSES = [
  "matched",
  "unmatched",
  "shortfall",
  "overage",
  "duplicate",
  "missing_evidence",
  "sync_failure",
  "pending_sync",
  "reviewed",
] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const LINE_STATUS_LABELS: Record<string, string> = {
  matched: "Matched",
  unmatched: "Unmatched",
  shortfall: "Shortfall",
  overage: "Overage",
  duplicate: "Duplicate",
  missing_evidence: "Missing evidence",
  sync_failure: "Sync failure",
  pending_sync: "Pending sync",
  reviewed: "Reviewed",
};

export function isLineStatus(value: unknown): value is LineStatus {
  return typeof value === "string" && (LINE_STATUSES as readonly string[]).includes(value);
}

/** Statuses that represent an unresolved difference. */
export const UNRESOLVED_LINE_STATUSES = [
  "unmatched",
  "shortfall",
  "overage",
  "duplicate",
  "missing_evidence",
  "sync_failure",
  "pending_sync",
] as const;

export function isUnresolvedLineStatus(status: string): boolean {
  return (UNRESOLVED_LINE_STATUSES as readonly string[]).includes(status);
}

export const CASE_STATUSES = [
  "open",
  "assigned",
  "under_review",
  "awaiting_evidence",
  "escalated",
  "resolution_proposed",
  "resolved",
  "rejected",
  "dismissed",
  "reopened",
  // Legacy provider-statement status. Kept so existing cases and screens stay
  // readable; it behaves like under_review.
  "investigating",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  assigned: "Assigned",
  under_review: "Under review",
  awaiting_evidence: "Awaiting evidence",
  escalated: "Escalated",
  resolution_proposed: "Resolution proposed",
  resolved: "Resolved",
  rejected: "Rejected",
  dismissed: "Dismissed",
  reopened: "Reopened",
  investigating: "Investigating",
};

const REVIEW_STATES = ["under_review", "investigating"];

/** Explicit Susu case state machine. Every transition is server-enforced. */
const CASE_TRANSITIONS: Record<string, string[]> = {
  open: [
    "assigned",
    "under_review",
    "awaiting_evidence",
    "escalated",
    "resolution_proposed",
    "resolved",
    "rejected",
    "dismissed",
  ],
  assigned: [
    "under_review",
    "awaiting_evidence",
    "escalated",
    "resolution_proposed",
    "resolved",
    "rejected",
    "dismissed",
  ],
  under_review: [
    "awaiting_evidence",
    "escalated",
    "resolution_proposed",
    "resolved",
    "rejected",
    "dismissed",
  ],
  investigating: [
    "awaiting_evidence",
    "escalated",
    "resolution_proposed",
    "resolved",
    "rejected",
    "dismissed",
  ],
  awaiting_evidence: [
    "under_review",
    "escalated",
    "resolution_proposed",
    "resolved",
    "rejected",
    "dismissed",
  ],
  escalated: [
    "under_review",
    "awaiting_evidence",
    "resolution_proposed",
    "resolved",
    "rejected",
    "dismissed",
  ],
  resolution_proposed: [
    "resolved",
    "rejected",
    "under_review",
    "escalated",
    "dismissed",
  ],
  resolved: ["reopened"],
  rejected: ["reopened"],
  dismissed: ["reopened"],
  reopened: [
    "assigned",
    "under_review",
    "awaiting_evidence",
    "escalated",
    "resolution_proposed",
    "resolved",
    "rejected",
    "dismissed",
  ],
};

export function canTransitionCase(from: string, to: string): boolean {
  if (REVIEW_STATES.includes(to) && REVIEW_STATES.includes(from)) return true;
  return (CASE_TRANSITIONS[from] ?? []).includes(to);
}

/** Which next statuses the UI may offer for this case. */
export function nextCaseStatuses(from: string): string[] {
  return CASE_STATUSES.filter((status) => canTransitionCase(from, status));
}

export const TERMINAL_CASE_STATUSES = ["resolved", "rejected", "dismissed"] as const;

export function isTerminalCaseStatus(status: string): boolean {
  return (TERMINAL_CASE_STATUSES as readonly string[]).includes(status);
}

export const CASE_CATEGORIES = [
  "provider_statement",
  "branch_liquidity",
  "branch_transfer",
  "remittance",
  "shift",
  "daily_close",
  "contribution",
  "offline_sync",
  "withdrawal",
  "other",
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const CASE_CATEGORY_LABELS: Record<string, string> = {
  provider_statement: "Provider statement",
  branch_liquidity: "Branch liquidity",
  branch_transfer: "Branch transfer",
  remittance: "Remittance",
  shift: "Shift handover",
  daily_close: "Daily close",
  contribution: "Contribution",
  offline_sync: "Offline synchronization",
  withdrawal: "Withdrawal exception",
  other: "Other",
};

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Operational priority from the amount at stake. Not a risk score. */
export function severityForAmount(absoluteAmount: number): Severity {
  const amount = Math.abs(Number.isFinite(absoluteAmount) ? absoluteAmount : 0);
  if (amount >= 500) return "high";
  if (amount >= 100) return "medium";
  return "low";
}

/**
 * At or above this amount (or high severity), a resolution must be proposed and
 * approved by a different authorized person. Branch finance (or a company-wide
 * administrator) is required to approve a high-value resolution.
 */
export const INDEPENDENT_APPROVAL_AMOUNT = 500;

export function requiresIndependentApproval(input: {
  severity: string;
  amountAtStake?: number | null;
}): boolean {
  const amount = Math.abs(input.amountAtStake ?? 0);
  return input.severity === "high" || amount >= INDEPENDENT_APPROVAL_AMOUNT;
}

/**
 * Evidence is mandatory before closing a case that represents a financial
 * difference. Low-value administrative cases may be resolved with a note.
 */
export function caseRequiresEvidence(input: {
  category: string;
  severity: string;
  amountAtStake?: number | null;
}): boolean {
  const amount = Math.abs(input.amountAtStake ?? 0);
  if (amount > 0.004) return true;
  if (input.severity === "high") return true;
  return [
    "remittance",
    "daily_close",
    "contribution",
    "offline_sync",
    "withdrawal",
    "branch_liquidity",
  ].includes(input.category);
}

/** Default due window by severity, in hours. Escalation is due-date driven. */
export const CASE_DUE_HOURS: Record<Severity, number> = {
  high: 24,
  medium: 72,
  low: 168,
};

export const RECONCILIATION_DEFINITION_VERSION = 1;

/** Susu currency is Ghana cedi; amounts are rounded to pesewas. */
export function money(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function normalizeBusinessDay(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

export function addDaysUtc(value: Date, days: number): Date {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function formatBusinessDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}
