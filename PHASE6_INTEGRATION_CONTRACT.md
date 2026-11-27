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
| Cycle report | `getCycleReport` | SusuCycle, Contribution, ContributionAllocation, Withdrawal | Yes | Per-cycle summary. |
| Exports | `exportSusuReport` | Same filters as screen | Yes | CSV, full filtered set, rate limited, formula-sanitised. |

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

## Export behaviour

- `exportSusuReport` writes the complete filtered set to CSV via `buildCsv` / `csvBlob`.
- Full result set: no pagination truncation (cap of 50,000 rows enforced before export).
- Spreadsheet formula injection guarded by `csvCell`.
- Export rate-limited via `enforceExportRateLimit("susuReport", ...)` .
- Download handled through `GET /api/susu/reports/export` (authorisation + rate limit + CSV body).

## Missing Phase 4 / Phase 5 integration fields

- Phase 4 withdrawal controls: no extra fields required for the current report figures,
  but future withdrawal status/reversal fields will flow into withdrawal aggregates.
- Phase 5 reconciliation exceptions: open discrepancy counts currently read
  `RemittanceDiscrepancy.status = "open"`; the wider exception-management module is out of
  scope.

## Assumptions

- Cycle reporting is tenant-scoped only because `SusuAccount` and `SusuCycle` carry no
  branch attribution; branch attribution lives on `Contribution`.
- Customer statements use the account's contribution history, withdrawals and commissions.

## Remaining risks / limitations

- Management overview assumes all branches in scope are returned; branch-scoped admin
  sessions receive a limited branch list.
- Large result sets above the export cap are rejected rather than silently truncated.

## API endpoint

`GET /api/susu/reports/export` - tenant-scoped CSV export backed by `exportSusuReport`.
