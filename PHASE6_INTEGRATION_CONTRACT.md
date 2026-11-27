# Phase 6 — Susu Reporting and Analytics: Integration Contract

Status: implemented locally, local-only.

## Purpose

Phase 6 builds reporting and analytics for MaaCash Susu on top of the Phase 1–3 integrated data model and settlement engine. It must not redefine financial truth on its own.

## Implemented reports and metrics

| Report | Function | Source | Reversal-aware | Notes |
| --- | --- | --- | --- | --- |
| Management overview | `getSusuOverview` | Contribution, Customer, Collector, CollectorRemittance, Withdrawal, RemittanceDiscrepancy, Location | Yes | Gross, net, outstanding, remittance activity, branch comparisons. |
| Contribution report | `getContributionReport` | Contribution | Yes | Rows + gross/reversed/net totals; filters by period, channel, reversal status, collector, account, cycle. |
| Collector performance | `getCollectorPerformanceReport` | Contribution, CollectorRemittance | Yes | Per-collector contribution and remittance figures. |
| Branch report | `getBranchReport` | Contribution, CollectorRemittance, Collector, Withdrawal, Discrepancy | Yes | Company-wide or branch-scoped. |
| Customer statement | `getCustomerStatement` | SusuAccount, Contribution, Withdrawal, Commission | Yes | Running balance per account. |
| Cycle report | `getCycleReport` | SusuCycle, SusuAccount, Contribution, ContributionAllocation, Withdrawal | Yes | Per-cycle summary, scoped to the branch of the owning account (Phase 7 integration), optional `branchId` filter. |
| Exports | `exportSusuReport` | Same filters as screen | Yes | CSV, full filtered set, rate limited, formula-sanitised. Supports `overview`, `contributions`, `collectors`, `branches`, `cycles`, `statement`, `transactions`. |

## Exact financial calculation definitions

- **Gross recorded amount**: sum of `Contribution.amount` where `reversalOfId IS NULL`
  (original contribution entries) within the selected scope and period.
- **Reversed amount**: absolute sum of `Contribution.amount` where `reversalOfId IS NOT NULL`
  (reversal entries) within the selected scope and period.
- **Net contribution amount**: gross recorded minus reversed amount.
- **Outstanding balance**: sum of `CollectorRemittance.outstandingAmount` for active
  (non-reversed) remittances within the selected scope. Computed by the authoritative
  Phase 3 settlement engine; never recomputed here.
- **Remittance declared / received / verified**: sums of `CollectorRemittance.declaredAmount`,
  `receivedAmount`, `verifiedAmount` across remittances. Declared is never treated as
  received, and received is never treated as verified.

## Source tables and relationships

- `Contribution`, `ContributionAllocation`, `Withdrawal`, `Commission`, `CardFee`.
- `Collector`, `CollectorRemittance`, `RemittanceContribution`, `RemittanceDiscrepancy`.
- `SusuAccount`, `SusuCycle`.

Reversal handling uses `reversedAt` and `reversalOfId` without rewriting history.

## Filters and permissions

- Period (`dateFrom`, `dateTo`), branch (server-resolved via `resolveBranchScope`),
  collector, account, cycle, channel, reversal status, transaction status.
- Server-side tenant isolation plus branch scope. No client-supplied tenant ID is trusted.
- Cross-tenant and cross-branch access denied by the auth layer.
- Every report resolves branch scope the same way: a limited-scope reader may omit the
  branch filter (implicitly restricted to their branches) or name one of their branches;
  naming a foreign branch is refused with `"Branch not in your authorized scope."`.
  A company-wide reader may narrow to any branch in the tenant.

## Export behaviour

- `exportSusuReport` writes the complete filtered set to CSV via `buildCsv` / `csvBlob`.
- Full result set: no pagination truncation (cap of 50,000 rows enforced before export).
  Multi-page reports (contributions, cycles) are paged internally at 200 rows per page
  until `total` is reached, so the CSV always matches the filtered screen totals rather
  than the visible page.
- `report: "cycles"` exports the cycle summary columns
  (Cycle, Status, Branch, Customer, Account, Start, End, Daily Contribution (GH₵),
  Contributions, Contribution Amount (GH₵), Reversed (GH₵), Net (GH₵), Allocated (GH₵),
  Withdrawals, Withdrawal Amount (GH₵)).
- Spreadsheet formula injection guarded by `csvCell`.
- Export rate-limited via `enforceExportRateLimit("susuReport", ...)` .
- Download handled through `GET /api/susu/reports/export` (authorisation + rate limit + CSV body).

## Missing Phase 4 / Phase 5 integration fields

- Phase 4 withdrawal controls: no extra fields required for the current report figures,
  but future withdrawal status/reversal fields will flow into withdrawal aggregates.
- Phase 5 reconciliation exceptions: open discrepancy counts currently read
  `RemittanceDiscrepancy.status = "open"`; the wider exception-management module is out of
  scope.

## Phase 7 integration — cycle branch attribution

Phase 7 added `SusuAccount.branchId`. `SusuCycle.account` is a required relation, so a
cycle belongs to exactly one account and therefore to exactly one branch: the account
branch is the branch of record for the cycle.

- `getCycleReport` resolves `resolveBranchScope(identity)` and applies the account-branch
  filter to rows (`where.account = { branchId }`).
- The per-cycle money inside a row is filtered by the same branch filter:
  contributions and withdrawals by `Contribution.branchId` / `Withdrawal.branchId`, and
  allocations through `contribution: { ..., branchId }`. An anomalous cross-branch
  contribution row therefore cannot inflate a branch-scoped cycle aggregate.
- Each row carries `branchId` (the account branch, or `null` for legacy unassigned
  accounts, which only company-wide readers see inside their tenant scope) and
  `branchName`, resolved with one tenant-scoped lookup per page. The cycle CSV prints the
  name and falls back to the id when the location no longer exists.
- The optional `branchId` parameter follows the shared scope rules above; a limited-scope
  reader asking for a foreign branch is refused rather than silently unfiltered.
- `exportSusuReport({ report: "cycles" })` uses the same function, so the CSV obeys the
  identical branch scope.

## Assumptions

- Accounts created before Phase 7 (or seeded without a branch) carry `branchId = null`;
  they remain visible to company-wide readers and are excluded from a branch-scoped read.
- Customer statements use the account's contribution history, withdrawals and commissions.

## Remaining risks / limitations

- Management overview assumes all branches in scope are returned; branch-scoped admin
  sessions receive a limited branch list.
- Large result sets above the export cap are rejected rather than silently truncated.

## API endpoint

`GET /api/susu/reports/export` - tenant-scoped CSV export backed by `exportSusuReport`.
