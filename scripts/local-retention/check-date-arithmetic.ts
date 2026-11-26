/**
 * Local-only assertions on the exact production date arithmetic.
 * Imports the same module used by the retention preview and the sweep.
 */

import {
  addMonthsUtc,
  legalHoldDeadline,
  legalHoldReviewDue,
  riskAuditDeletionDeadline,
  signalDeletionDeadline,
  RISK_ACTIVE_SIGNAL_DAYS,
  RISK_AUDIT_RETENTION_MONTHS,
  RISK_POST_EXPIRY_DAYS,
  RISK_POST_RESOLUTION_DAYS,
  RISK_POST_WITHDRAWAL_DAYS,
} from "../../src/lib/risk-intelligence/retention";

const DAY_MS = 86_400_000;
const results: string[] = [];

function equal(name: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${name}: got ${String(actual)}, expected ${String(expected)}`);
  }
  results.push(name);
}

equal("constants", [RISK_ACTIVE_SIGNAL_DAYS, RISK_POST_EXPIRY_DAYS, RISK_POST_WITHDRAWAL_DAYS, RISK_POST_RESOLUTION_DAYS, RISK_AUDIT_RETENTION_MONTHS].join(","), "180,90,90,90,24");

// Exact 90-day boundary from expiry.
equal(
  "expiry-plus-90-exact",
  signalDeletionDeadline({ status: "expired", expiresAt: "2026-01-01T00:00:00.000Z" }),
  "2026-04-01T00:00:00.000Z"
);
// One millisecond before expiry instant is still before the deadline.
equal(
  "expiry-deadline-strict",
  signalDeletionDeadline({ status: "expired", expiresAt: "2026-01-01T00:00:00.001Z" }),
  "2026-04-01T00:00:00.001Z"
);
// Withdrawal clock uses withdrawnAt, not expiresAt.
equal(
  "withdrawal-plus-90",
  signalDeletionDeadline({
    status: "withdrawn",
    expiresAt: "2026-01-01T00:00:00.000Z",
    withdrawnAt: "2026-06-01T00:00:00.000Z",
  }),
  "2026-08-30T00:00:00.000Z"
);
// Unresolved dispute never becomes a deletion candidate.
equal(
  "unresolved-disputed-null",
  signalDeletionDeadline({ status: "disputed_frozen", expiresAt: "2026-01-01T00:00:00.000Z" }),
  null
);
// Resolution starts the 90-day clock.
equal(
  "resolved-plus-90",
  signalDeletionDeadline({
    status: "disputed_frozen",
    expiresAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: "2026-05-01T00:00:00.000Z",
  }),
  "2026-07-30T00:00:00.000Z"
);
// Timezone offset input is normalised through the UTC instant.
const offsetInstant = new Date("2026-01-01T23:30:00+14:00").toISOString();
equal(
  "offset-normalised",
  signalDeletionDeadline({ status: "expired", expiresAt: "2026-01-01T23:30:00+14:00" }),
  new Date(new Date(offsetInstant).getTime() + 90 * DAY_MS).toISOString()
);
// 24-month audit retention with end-of-month clamp.
equal("add-months-clamp", addMonthsUtc("2024-02-29T12:00:00.000Z", 24), "2026-02-28T12:00:00.000Z");
equal(
  "audit-24-months",
  riskAuditDeletionDeadline("2024-02-29T12:00:00.000Z"),
  "2026-02-28T12:00:00.000Z"
);
// Legal hold rules: active hold blocks; released hold does not.
equal(
  "hold-active-blocks",
  legalHoldDeadline("2026-04-01T00:00:00.000Z", { active: true }),
  null
);
equal(
  "hold-released",
  legalHoldDeadline("2026-04-01T00:00:00.000Z", { active: false }),
  "2026-04-01T00:00:00.000Z"
);
// 14-day review clock and its release override.
equal(
  "hold-review-due",
  legalHoldReviewDue("2026-01-01T00:00:00.000Z", "2026-01-15T00:00:00.000Z"),
  true
);
equal(
  "hold-review-not-due",
  legalHoldReviewDue("2026-01-01T00:00:00.000Z", "2026-01-14T23:59:59.999Z"),
  false
);
equal(
  "hold-review-released",
  legalHoldReviewDue("2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-01-10T00:00:00.000Z"),
  false
);

console.info(`[date-arithmetic] ok ${results.length} checks`);
