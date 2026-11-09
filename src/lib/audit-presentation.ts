/**
 * Human-readable presentation for audit records.
 *
 * This module never changes an audit row. It maps the stored action, entity
 * type and details to labels an ordinary business administrator can understand.
 * Unknown events fall back safely instead of leaking raw JSON.
 */

export interface AuditEntityContext {
  label?: string | null;
  reference?: string | null;
  secondary?: string | null;
}

export interface AuditPresentationInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: string | null;
  actorName?: string | null;
  entity?: AuditEntityContext | null;
}

export interface AuditDetailField {
  label: string;
  value: string;
}

export interface AuditPresentation {
  actionLabel: string;
  entityLabel: string;
  entityReference: string | null;
  entitySecondary: string | null;
  description: string;
  translated: boolean;
  detailFields: AuditDetailField[];
  technicalDetails: AuditDetailField[];
}

const ENTITY_LABELS: Record<string, string> = {
  dailyaccount: "Daily Account",
  dailysummary: "Daily Account",
  momodailyaccount: "Daily Account",
  device: "Device",
  deviceenrollment: "Device",
  contribution: "Contribution",
  contributionallocation: "Contribution",
  user: "User",
  staff: "User",
  customer: "Customer",
  location: "Location",
  expense: "Expense",
  susuaccount: "Susu Account",
  withdrawal: "Withdrawal",
  collector: "Collector",
  collectorremittance: "Money Handed In",
  remittance: "Money Handed In",
  offlinetransaction: "Offline Record",
  session: "Session",
  auditlog: "Activity Record",
  businesstenant: "Business",
  tenant: "Business",
};

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Sign-in failed",
  "auth.session_timeout": "Session timed out",
  "auth.session_background": "Session ended in background",
  "auth.session_absolute": "Session expired",
  "auth.password_changed": "Changed password",
  "auth.first_login_password_changed": "Changed password on first sign-in",
  "auth.password_recovery_requested": "Requested password recovery",
  "auth.password_recovery_completed": "Completed password recovery",
  "auth.reauth_success": "Confirmed identity",
  "auth.reauth_failed": "Identity confirmation failed",
  "auth.workspace_selected": "Selected a dashboard",
  "auth.workspace_switched": "Switched dashboard",
  "auth.mfa_enrolled": "Enabled multi-factor authentication",
  "auth.mfa_verified": "Verified multi-factor authentication",
  "auth.admin_recovery_issued": "Issued administrator recovery access",
  "auth.admin_recovery_redeemed": "Used administrator recovery access",
  "auth.mfa_reset_by_admin": "Reset another user's multi-factor authentication",
  "user.worker_created": "Added a MoMo agent",
  "user.worker_updated": "Updated a MoMo agent",
  "user.worker_activated": "Activated a MoMo agent",
  "user.worker_deactivated": "Deactivated a MoMo agent",
  "user.staff_created": "Added a staff member",
  "user.staff_updated": "Updated a staff member",
  "user.password_reset": "Reset a user's password",
  "user.module_assignment_changed": "Changed a user's dashboard access",
  "daily_account.created": "Started a daily closing",
  "daily_account.updated": "Updated a daily closing",
  "daily_account.submitted": "Submitted a daily closing",
  "daily_account.reviewed": "Reviewed a daily closing",
  "daily_account.corrected": "Corrected a daily closing",
  "daily_account.handover_confirmed": "Confirmed money received",
  "susu.contribution_recorded": "Recorded a customer payment",
  "susu.withdrawal_processed": "Processed a customer withdrawal",
  "susu.withdrawal_reversed": "Reversed a customer withdrawal",
  "susu.contribution_reversed": "Reversed a customer payment",
  "susu.remittance_recorded": "Recorded money handed in",
  "susu.remittance_reversed": "Reversed money handed in",
  "susu.customer_created": "Added a customer",
  "susu.customer_created_by_collector": "Collector added a customer",
  "susu.customer_updated": "Updated a customer",
  "susu.customer_reassigned": "Reassigned a customer",
  "susu.customer_assigned_to_collector": "Assigned a customer to a collector",
  "susu.customer_removed_from_collector": "Removed a customer from a collector",
  "susu.customer_portal_created": "Created customer portal access",
  "susu.customer_portal_password_reset": "Reset customer portal access",
  "susu.collector_created": "Added a collector",
  "susu.collector_activated": "Activated a collector",
  "susu.collector_deactivated": "Deactivated a collector",
  "offline.device_enrolled": "Registered a device for offline use",
  "offline.device_revoked": "Revoked a device for offline use",
  "offline.device_activated": "Restored a device for offline use",
  "offline.sync_rejected": "Rejected an offline record",
  "location.created": "Created a location",
  "location.updated": "Updated a location",
  "zeli.trial_started": "Started Zeli trial",
  "zeli.team_disclosure_accepted": "Accepted Zeli data disclosure",
};

const SENSITIVE_KEY = /(password|passcode|secret|token|authorization|bearer|otp|pin|hash|jwt|privatekey|apikey|api_key)/i;
const TECHNICAL_ONLY_KEY = /^(id|userId|tenantId|deviceId|ipAddress|ua|userAgent)$/i;

function normalizeKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return "Value";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function entityTypeLabel(entityType: string): string {
  const key = normalizeKey(entityType);
  if (ENTITY_LABELS[key]) return ENTITY_LABELS[key];
  const words = entityType
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : "Activity";
}

export function friendlyAction(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const words = action.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : "Activity recorded";
}

export function moduleLabel(value: unknown): string {
  const key = String(value ?? "").toLowerCase();
  if (key === "momo" || key === "worker") return "MoMo";
  if (key === "susu" || key === "collector") return "Susu Collector";
  if (key === "admin") return "Administrator";
  if (key === "customer") return "Customer";
  return key ? humanizeKey(key) : "another dashboard";
}

export function parseAuditDetails(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function formatMoney(value: unknown): string | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const formatted = amount.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `GH₵${formatted}`;
}

export function formatBusinessDate(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function detailDate(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  return (
    formatBusinessDate(details.businessDate) ??
    formatBusinessDate(details.date) ??
    null
  );
}

function dateClause(details: Record<string, unknown> | null): string {
  const date = detailDate(details);
  return date ? ` for ${date}` : "";
}

function amountClause(value: unknown, prefix = " "): string {
  const formatted = formatMoney(value);
  return formatted ? `${prefix}${formatted}` : "";
}

function sanitizeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 237)}…` : value;
  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? "—" : `${keys.length} detail${keys.length === 1 ? "" : "s"}`;
  }
  return String(value);
}

export function readableDetailFields(
  details: Record<string, unknown> | null
): AuditDetailField[] {
  if (!details) return [];
  const fields: AuditDetailField[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(key) || TECHNICAL_ONLY_KEY.test(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    fields.push({ label: humanizeKey(key), value: sanitizeValue(value) });
    if (fields.length >= 18) break;
  }
  return fields;
}

export function technicalDetailFields(
  details: Record<string, unknown> | null
): AuditDetailField[] {
  if (!details) return [];
  const fields: AuditDetailField[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(key)) continue;
    fields.push({ label: humanizeKey(key), value: sanitizeValue(value) });
    if (fields.length >= 18) break;
  }
  return fields;
}

function describeKnownAction(
  action: string,
  details: Record<string, unknown> | null
): string | null {
  const date = dateClause(details);
  switch (action) {
    case "auth.login":
      return "Signed in.";
    case "auth.logout":
      return "Signed out.";
    case "auth.login_failed":
      return "A sign-in attempt was rejected.";
    case "auth.session_timeout":
      return "The session was closed after inactivity.";
    case "auth.session_background":
      return "The session was closed after the app stayed in the background.";
    case "auth.session_absolute":
      return "The session reached its maximum lifetime and ended.";
    case "auth.password_changed":
      return "Changed the account password.";
    case "auth.first_login_password_changed":
      return "Changed the temporary password on first sign-in.";
    case "auth.password_recovery_requested":
      return "Requested password recovery.";
    case "auth.password_recovery_completed":
      return "Completed password recovery and set a new password.";
    case "auth.reauth_success":
      return "Confirmed identity for a protected action.";
    case "auth.reauth_failed":
      return "An identity confirmation attempt failed.";
    case "auth.workspace_selected":
      return `Selected the ${moduleLabel(details?.module)} dashboard.`;
    case "auth.workspace_switched":
      return `Switched dashboard from ${moduleLabel(details?.from)} to ${moduleLabel(details?.to)}.`;
    case "auth.mfa_enrolled":
      return "Enabled multi-factor authentication.";
    case "auth.mfa_verified":
      return "Verified multi-factor authentication.";
    case "auth.admin_recovery_issued":
      return "Issued administrator account recovery access.";
    case "auth.admin_recovery_redeemed":
      return "Used administrator account recovery access.";
    case "auth.mfa_reset_by_admin":
      return "Reset another user's multi-factor authentication.";
    case "user.worker_created":
      return "Added a MoMo agent account.";
    case "user.worker_updated":
      return "Updated a MoMo agent account.";
    case "user.worker_activated":
      return "Activated a MoMo agent account.";
    case "user.worker_deactivated":
      return "Deactivated a MoMo agent account.";
    case "user.staff_created":
      return "Added a staff account.";
    case "user.staff_updated":
      return "Updated a staff account.";
    case "user.password_reset":
      return "Reset a user's password.";
    case "user.module_assignment_changed":
      return "Changed a user's dashboard access.";
    case "daily_account.created":
      return `Started a daily closing${date}.`;
    case "daily_account.updated": {
      const expenses = formatMoney(details?.totalExpenses);
      const airtime = formatMoney(details?.airtimeSold);
      const parts = [
        expenses ? `Expenses: ${expenses}.` : null,
        airtime && Number(details?.airtimeSold) > 0
          ? `Airtime Sold: ${airtime} (operational only).`
          : null,
      ].filter(Boolean);
      return `Updated a daily closing${date}.${parts.length ? ` ${parts.join(" ")}` : ""}`;
    }
    case "daily_account.submitted":
      return `Submitted a daily closing${date}.`;
    case "daily_account.reviewed":
      return `Reviewed a daily closing${date}.`;
    case "daily_account.corrected": {
      const reason = typeof details?.reason === "string" ? details.reason : null;
      return `Corrected a daily closing${date}.${reason ? ` Reason: ${reason}` : ""}`;
    }
    case "daily_account.handover_confirmed": {
      const actual = formatMoney(details?.actualAmountReceived);
      const expected = formatMoney(details?.expectedAmount);
      const difference = formatMoney(details?.difference);
      return `Confirmed money received${date}.${actual ? ` Received ${actual}.` : ""}${
        expected ? ` Expected ${expected}.` : ""
      }${difference && Number(details?.difference) !== 0 ? ` Discrepancy ${difference}.` : ""}`;
    }
    case "susu.contribution_recorded": {
      const amount = amountClause(details?.amount, " of ");
      const offline =
        String(details?.source ?? "") === "offline_sync"
          ? " It was synchronized from an offline device."
          : "";
      return `Recorded a customer payment${amount}.${offline}`;
    }
    case "susu.withdrawal_processed": {
      const amount = amountClause(details?.amount, " of ");
      return `Processed a customer withdrawal${amount}.`;
    }
    case "susu.withdrawal_reversed":
      return "Reversed a customer withdrawal.";
    case "susu.contribution_reversed":
      return "Reversed a customer payment.";
    case "susu.remittance_recorded": {
      const amount = amountClause(details?.remittedAmount ?? details?.amount, " of ");
      const variance = Number(details?.variance ?? 0);
      return `Recorded money handed in by a collector${amount}.${
        Number.isFinite(variance) && variance !== 0
          ? ` Difference from expected: ${formatMoney(variance)}.`
          : ""
      }`;
    }
    case "susu.remittance_reversed":
      return "Reversed a money handed-in record.";
    case "susu.customer_created":
    case "susu.customer_created_by_collector":
      return "Added a customer.";
    case "susu.customer_updated":
      return "Updated a customer's details.";
    case "susu.customer_reassigned":
      return "Reassigned a customer to another collector.";
    case "susu.customer_assigned_to_collector":
      return "Assigned a customer to a collector.";
    case "susu.customer_removed_from_collector":
      return "Removed a customer from a collector.";
    case "susu.customer_portal_created":
      return "Created customer portal access.";
    case "susu.customer_portal_password_reset":
      return "Reset customer portal access.";
    case "susu.collector_created":
      return "Added a collector.";
    case "susu.collector_activated":
      return "Activated a collector.";
    case "susu.collector_deactivated":
      return "Deactivated a collector.";
    case "offline.device_enrolled":
      return `Registered a device for offline use${
        details?.module ? ` (${moduleLabel(details.module)})` : ""
      }.`;
    case "offline.device_revoked":
      return "Revoked a device's offline authorization.";
    case "offline.device_activated":
      return "Restored a device's offline authorization.";
    case "offline.sync_rejected": {
      const reason =
        typeof details?.reason === "string" ? ` Reason: ${details.reason}` : "";
      return `An offline record was rejected during synchronization.${reason}`;
    }
    case "location.created":
      return "Created a location.";
    case "location.updated":
      return "Updated a location.";
    case "location.activated":
      return "Activated a location.";
    case "location.deactivated":
      return "Deactivated a location.";
    case "zeli.trial_started":
      return "Started a Zeli trial.";
    case "zeli.team_disclosure_accepted":
      return "Accepted the Zeli data disclosure.";
    default:
      return null;
  }
}

/**
 * Build the display model for one audit row. Known events get a specific plain
 * description. Unknown events get a safe fallback; raw JSON is never primary.
 */
export function presentAuditEntry(input: AuditPresentationInput): AuditPresentation {
  const details = parseAuditDetails(input.details);
  const actionLabel = friendlyAction(input.action);
  const entityLabel = input.entity?.label ?? entityTypeLabel(input.entityType);
  const entityReference = input.entity?.reference ?? null;
  const entitySecondary = input.entity?.secondary ?? null;
  const known = describeKnownAction(input.action, details);

  return {
    actionLabel,
    entityLabel,
    entityReference,
    entitySecondary,
    description:
      known ??
      "Activity recorded — additional details unavailable.",
    translated: known !== null,
    detailFields: readableDetailFields(details),
    technicalDetails: technicalDetailFields(details),
  };
}
