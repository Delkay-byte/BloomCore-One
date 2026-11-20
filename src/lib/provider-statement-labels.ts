/**
 * Statement and exemption labels shared by the server module and the browser.
 *
 * This file must stay free of Node built-ins: the reconciliation screens import
 * it directly, and a `node:crypto` import here would break the client bundle.
 */

export const STATEMENT_PROVIDERS = ["mtn", "telecel", "at_money"] as const;
export type StatementProvider = (typeof STATEMENT_PROVIDERS)[number];

export const STATEMENT_PROVIDER_LABELS: Record<StatementProvider, string> = {
  mtn: "MTN MoMo",
  telecel: "Telecel Cash",
  at_money: "AT Money",
};

export function isStatementProvider(value: unknown): value is StatementProvider {
  return typeof value === "string" && (STATEMENT_PROVIDERS as readonly string[]).includes(value);
}

export const STATEMENT_CASE_STATUSES = [
  "open",
  "investigating",
  "awaiting_evidence",
  "resolved",
  "dismissed",
] as const;
export type StatementCaseStatus = (typeof STATEMENT_CASE_STATUSES)[number];

export const STATEMENT_CASE_CATEGORY_LABELS: Record<string, string> = {
  provider_statement: "Provider statement",
  branch_liquidity: "Branch liquidity",
  branch_transfer: "Branch transfer",
  remittance: "Remittance",
  shift: "Shift handover",
  daily_close: "Daily close",
  other: "Other",
};

export const STATEMENT_CASE_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  investigating: "Investigating",
  awaiting_evidence: "Awaiting evidence",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

/** Allowed case transitions. A closed case may only be reopened deliberately. */
const CASE_TRANSITIONS: Record<string, string[]> = {
  open: ["investigating", "awaiting_evidence", "resolved", "dismissed"],
  investigating: ["awaiting_evidence", "resolved", "dismissed"],
  awaiting_evidence: ["investigating", "resolved", "dismissed"],
  resolved: ["open"],
  dismissed: ["open"],
};

export function canTransitionCase(from: string, to: string): boolean {
  return (CASE_TRANSITIONS[from] ?? []).includes(to);
}

