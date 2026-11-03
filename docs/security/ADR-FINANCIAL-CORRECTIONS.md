# ADR — Remittance and Daily-Account Corrections

**Date:** 2 November 2026
**Status:** Implemented
**Scope:** `CollectorRemittance`, `DailyAccount`, `DailyAccountRevision`

## Context

Withdrawals and contributions already use compensating reversal entries. The
previous assessment found two record types without a correction path:

1. **Collector remittances** record physical cash handed to the office. Their
   `expectedAmount` is derived from contributions since the previous remittance.
2. **Daily accounts** are one row per location/date, with submitted/reviewed
   figures and expenses.

Appending a negative remittance would corrupt sums and the "last remittance"
anchor. Adding a second daily-account row would violate the unique
`(locationId, businessDate)` identity.

## Decision

### Remittance: in-place reversal marker

- `CollectorRemittance` gains `reversedAt`, `reversedById`, `reversalReason`.
- Reversal sets `status = "reversed"` atomically only when `reversedAt IS NULL`.
- The original fields and `referenceId` are never changed or deleted.
- Active calculations (expected amount anchor, today's handed-in total,
  variance, history aggregate) exclude reversed rows.
- The history list includes reversed rows with their reason.
- Audit: `susu.remittance_reversed` includes amounts, collector, reason and actor.

**Why:** the remittance is an observation of cash handover, not a ledger posting.
Removing it from the active anchor makes subsequent contributions expected again,
without touching any balance or creating a synthetic entry.

### Daily account: immutable revision snapshots + live row correction

- `DailyAccount` gains `correctedAt`, `correctedById`, `correctionReason`,
  `revisionCount`.
- New `DailyAccountRevision` stores a JSON snapshot of the full pre-correction
  financial state (all totals, variances, expenses, status, review metadata),
  the mandatory reason, author and version.
- The live row keeps the same `(location, date)` identity and receives the
  corrected figures. Expenses are replaced in the same transaction.
- Duplicate/concurrent corrections are prevented by:
  - `@@unique([dailyAccountId, version])`;
  - an atomic `updateMany` conditioned on the previous `revisionCount`.
- Audit: `daily_account.corrected` with version and impact.

**Why:** reports and dashboards continue to read one authoritative row, while
every prior state is queryable and attributable. No negative entry is inserted.

## Affected calculations

| Surface | Behaviour |
|---|---|
| Remittance expected amount | Anchor uses latest non-reversed remittance |
| Today's handed-in / variance | Reversed rows excluded |
| History aggregate | Reversed rows excluded |
| Remittance list | Reversed rows visible with status/reason |
| Daily account list/report/dashboard | Live corrected figures |
| Daily account history | Every revision retained with reason/actor |
| Audit | Append-only application records for both corrections |

## Unresolved business decisions

None block the implementation. The following remain owner policy choices:

- Whether a reversed remittance should require a replacement remittance before a
  collector can be marked reconciled. The system currently recalculates expected
  cash from the previous active remittance.
- Whether daily-account corrections should notify the worker or require a second
  approver. Current behaviour is tenant-admin only with audit, no second approver.

## Evidence

- SQLite: `tests/financial-corrections.test.ts` (3 tests).
- PostgreSQL: `tests/pg-financial-corrections.test.ts` (concurrent correction and
  concurrent reversal).
- Migration: `prisma/migrations/20261102_financial_corrections/migration.sql`.
