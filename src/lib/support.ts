/**
 * Phase 8 — tenant support request vocabulary and guards.
 *
 * One module owns the status machine, the reference format, the credential
 * screen and the export column definitions so a tenant page, a platform page,
 * a server action and a CSV export can never disagree about what a status or a
 * column means.
 *
 * Nothing here resolves a tenant or authorises a caller: those decisions stay
 * in `src/lib/tenant.ts` and the action that performs the write.
 */

import { randomBytes } from "crypto";

export const SUPPORT_STATUSES = [
  "open",
  "acknowledged",
  "in_progress",
  "escalated",
  "resolved",
  "closed",
] as const;

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_CATEGORIES = [
  "account_access",
  "contribution",
  "remittance",
  "withdrawal",
  "reporting",
  "import",
  "staff",
  "other",
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

/** The only two values `SupportMessage.visibility` may hold. */
export const SUPPORT_VISIBILITY = {
  TENANT: "tenant",
  INTERNAL: "internal",
} as const;

const TRANSITIONS: Record<SupportStatus, readonly SupportStatus[]> = {
  open: ["acknowledged", "in_progress", "escalated", "resolved", "closed"],
  acknowledged: ["in_progress", "escalated", "resolved", "closed"],
  in_progress: ["escalated", "resolved", "closed"],
  escalated: ["in_progress", "resolved", "closed"],
  resolved: ["closed", "open"],
  closed: ["open"],
};

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === "string" && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

export function isSupportPriority(value: unknown): value is SupportPriority {
  return typeof value === "string" && (SUPPORT_PRIORITIES as readonly string[]).includes(value);
}

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === "string" && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

/** True when a status change is part of the reviewed lifecycle. */
export function canTransitionSupport(from: string, to: string): boolean {
  if (!isSupportStatus(from) || !isSupportStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export function isOpenSupportStatus(status: string): boolean {
  return status !== "resolved" && status !== "closed";
}

export function supportStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "acknowledged":
      return "Acknowledged";
    case "in_progress":
      return "In progress";
    case "escalated":
      return "Escalated";
    case "resolved":
      return "Resolved";
    case "closed":
      return "Closed";
    default:
      return "Unknown";
  }
}

export function supportPriorityLabel(priority: string): string {
  switch (priority) {
    case "low":
      return "Low";
    case "normal":
      return "Normal";
    case "high":
      return "High";
    case "urgent":
      return "Urgent";
    default:
      return "Unknown";
  }
}

export function supportCategoryLabel(category: string): string {
  switch (category) {
    case "account_access":
      return "Account access";
    case "contribution":
      return "Contribution";
    case "remittance":
      return "Money handed in";
    case "withdrawal":
      return "Withdrawal";
    case "reporting":
      return "Reports & exports";
    case "import":
      return "Customer import";
    case "staff":
      return "Staff & permissions";
    case "other":
      return "Other";
    default:
      return "Unknown";
  }
}

/** Field limits shared by the server actions and the forms. */
export const SUPPORT_SUBJECT_MAX = 140;
export const SUPPORT_DESCRIPTION_MIN = 10;
export const SUPPORT_DESCRIPTION_MAX = 4000;
export const SUPPORT_MESSAGE_MAX = 4000;
export const SUPPORT_REASON_MIN = 5;
export const SUPPORT_REASON_MAX = 500;

export function normalizeSupportText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

/**
 * Generate a human-quotable reference. Random, not sequential: a reference
 * leaks nothing about volume or when a business joined. Collisions are handled
 * by the unique index plus a retry in the creating action.
 */
export function generateSupportReference(now: Date = new Date()): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `SUP-${now.getUTCFullYear()}-${suffix}`;
}

/**
 * Detect values that look like a credential before they are stored.
 *
 * Deliberately narrow: "I forgot my password" is a legitimate support subject,
 * so only a labelled value (`password: hunter2`) or a machine-shaped token is
 * rejected. Returns a human message, or null when the text is acceptable.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:password|passcode|pin|otp|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S{3,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export function findCredentialLikeValue(text: string): string | null {
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return "Remove the password, key or token from your message. Support staff never need it and it must not be stored.";
    }
  }
  return null;
}

/**
 * Human age bucket for a queue, computed on the server so the page does not
 * depend on the browser clock.
 */
export function supportAgeLabel(createdAt: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - createdAt.getTime());
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Export columns. Both exports are metadata only: message bodies (and, for the
 * platform export, internal note counts) are never copied into a spreadsheet.
 * A tenant export therefore cannot leak an internal note even by accident.
 */
export interface SupportExportRow {
  reference: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  branchName: string;
  submittedByName: string;
  assignedAgentName: string;
  createdAt: Date;
  lastActivityAt: Date;
  reopenedCount: number;
  internalNoteCount?: number;
}

export function tenantSupportExportRows(rows: SupportExportRow[]): unknown[][] {
  return [
    [
      "Reference",
      "Subject",
      "Category",
      "Priority",
      "Status",
      "Branch",
      "Submitted by",
      "Created (UTC)",
      "Last activity (UTC)",
      "Reopened",
    ],
    ...rows.map((row) => [
      row.reference,
      row.subject,
      supportCategoryLabel(row.category),
      supportPriorityLabel(row.priority),
      supportStatusLabel(row.status),
      row.branchName,
      row.submittedByName,
      row.createdAt.toISOString(),
      row.lastActivityAt.toISOString(),
      row.reopenedCount,
    ]),
  ];
}

export function platformSupportExportRows(rows: SupportExportRow[]): unknown[][] {
  return [
    [
      "Reference",
      "Subject",
      "Category",
      "Priority",
      "Status",
      "Branch",
      "Submitted by",
      "Assigned to",
      "Created (UTC)",
      "Last activity (UTC)",
      "Reopened",
      "Internal notes",
    ],
    ...rows.map((row) => [
      row.reference,
      row.subject,
      supportCategoryLabel(row.category),
      supportPriorityLabel(row.priority),
      supportStatusLabel(row.status),
      row.branchName,
      row.submittedByName,
      row.assignedAgentName,
      row.createdAt.toISOString(),
      row.lastActivityAt.toISOString(),
      row.reopenedCount,
      row.internalNoteCount ?? 0,
    ]),
  ];
}
