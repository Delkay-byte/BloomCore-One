# Phase 1 Integration Contract — Agent 2 (Phase 2: Collector Operations)

This document records the exact schema/API contracts that Phase 2 requires from
Agent 1's Phase 1 (branch foundation and access control). Phase 2 does NOT
duplicate the branch model; it integrates at the documented boundary below.

## Verified baseline

- Common baseline commit: `ce5a3d0` (main, `fix(marketing): send public sign-in links to the role chooser`).
- Phase 2 branch: `feat/susu-enterprise-phase-2-collector-operations`
- Phase 2 worktree: `C:\Users\SAVIOUR\Documents\DScience\BIK Prestige Ent\BloomCore-One-phase-2`
- Agent 1's working directory (`BloomCore-One`, branch `fix/public-signin-role-chooser`) was left untouched.

## Branch model contract (from Phase 1)

Reuse `Location` as the branch. No duplicate branch model, no duplicate branch fields.

1. `Location` (id, tenantId, name, code, status) — tenant-scoped, already exists.
2. `BranchMembership` (tenant, user, location, role, status) — maintainable scope model. A role-`admin` user with active `branch_manager`/`finance` membership is scope-restricted; a role-`admin` user without such membership keeps company-wide authority. Collector scope comes from `Collector.branchId`. No new global role or JWT change needed in Phase 1.
3. Branch stored directly on financial records at creation time. Historical rows keep `NULL` = explicit `LEGACY_UNASSIGNED`; no guessed backfill. A collector's later branch change never rewrites old records.
4. Single-branch compatibility: when the authenticated scope has one branch, or the tenant has exactly one active branch, the branch is derived server-side. With several branches and no explicit choice, writes fail closed with a clear message.

## What Phase 2 did NOT add (Phase 1 owns these)

- No `BranchMembership` model.
- No `Collector.branchId` column.
- No branch columns on `Contribution`, `CollectorRemittance`, `Withdrawal`, etc.
- No branch-manager/finance membership UI or actions.
- No branch-scoped permission middleware.

## What Phase 2 added (compatible with Phase 1 boundary)

### Schema (additive, both `prisma/schema.prisma` and `prisma/schema-pg.prisma`)

- `Collector.status` — `active | inactive | suspended` (was `active | inactive`).
- `Collector.statusReason`, `Collector.statusChangedAt`, `Collector.statusChangedById`.
- `CollectorAssignmentEvent` — append-only assignment history (assigned/reactivated/transferred/unassigned).
- `CollectorCustomerAssignment.activeAccountKey` (`String? @unique`) — database invariant: at most one active assignment per account (NULL rows never collide).
- `CollectorCustomerAssignment.assignedById`.
- `Contribution.capturedAt` — original device capture time, evidence only; `collectionDate` remains server posting time used for financial ordering and period reporting.
- `OfflineSyncAttempt` — append-only trace of sync outcomes (accepted/already_synced/rejected/failed), safe context only (no payload, no auth material).
- Indexes: `Collector(tenantId, status)`, `CollectorCustomerAssignment(tenantId, active)`, `CollectorAssignmentEvent(tenantId, accountId, createdAt)`, `OfflineSyncAttempt(tenantId, outcome, createdAt)` and `(tenantId, retryable, createdAt)`.

Migration: `prisma/migrations/20261227_susu_collector_operations/migration.sql` (additive PG; no drops/renames/truncates).

### New server actions

- `src/lib/actions/susu-collector-lifecycle.ts` — `changeCollectorLifecycleStatus` (activate/deactivate/suspend/reactivate with step-up `collector.lifecycle` purpose, audit, rate limit), `getCollectorLifecycle`, `listCollectorsWithLifecycle`. Only `active` collectors may collect; both `Collector.status` and `User.status` stay in sync.
- `src/lib/actions/susu-assignment.ts` — `assignCustomerToCollector` (atomic, `activeAccountKey` invariant, append-only history), `transferCustomerAssignment` (validates current active collector via `fromCollectorId`, mandatory reason, history), `removeCustomerFromCollector`, `listAssignments`, `getAssignmentHistory`. Existing `assignCustomerToCollector` in `susu-collector.actions.ts` now delegates here.
- `src/lib/actions/susu-collector-performance.ts` — `getCollectorPerformance` (daily/weekly/monthly/custom; reversed contributions excluded; totals from server records only), `getCollectorFollowUpList` (self or team-scoped, never exposes another branch's customers).
- `src/lib/actions/susu-offline-sync-admin.ts` — `listOfflineSyncAttempts`, `resolveOfflineSyncAttempt`, `retryOfflineSyncAttempt` (safe retry signal; no server-side repost, no duplicate transaction).

### Modified files

- `src/lib/offline/payload.ts` — `capturedAt` accepted and canonicalized (optional, clamped to ±30 days).
- `src/app/api/offline/sync-contribution/route.ts` — stores `capturedAt` on the contribution; records every rejection/failure in `OfflineSyncAttempt`; idempotency and replay protection unchanged.
- `src/lib/actions/susu-collector.actions.ts` — `assignCustomerToCollector` delegates to atomic implementation.
- `src/lib/actions/susu-customer.actions.ts` — `findUnique({collectorId_accountId})` → `findFirst` (pair is no longer unique across history).
- `src/lib/security/step-up.ts` — new `collector.lifecycle` purpose.
- `tests/setup.ts` — cleanup order for `CollectorAssignmentEvent`.

## Security controls preserved

- Tenant resolved only from verified session (never browser input).
- `assertTenantEntity` on collector/customer/account before every write.
- Same-origin, device enrollment, 24h offline window, per-user rate limit, idempotency key bound to canonical payload digest, P2002 replay guard.
- Audit via `createAuditLogTx` inside the same transaction (financial mutations never commit without audit).
- Collectors cannot read/write `OfflineSyncAttempt`; tenant admin only.
- No client-trusted tenant/branch/collector IDs or financial totals.

## Dependencies on Phase 1 (recorded, not implemented here)

Branch-scoped collector operations (E branch-aware collector operations) are documented against the Phase 1 contract above but NOT implemented in Phase 2, because Phase 1's `BranchMembership` and `Collector.branchId` are not yet available. When Phase 1 lands:

1. Add `branchId` to `Collector` and branch columns to financial records (Phase 1 scope).
2. Enforce `Collector.branchId` in `changeCollectorLifecycleStatus`, `assignCustomerToCollector`, `transferCustomerAssignment`.
3. Scope `listCollectorsWithLifecycle`, `getCollectorPerformance`, `getCollectorFollowUpList` and `listOfflineSyncAttempts` by branch per `BranchMembership`.
4. Fail closed when several branches exist and no explicit choice is made.

## Tests

- `tests/susu-phase-2.test.ts` — 18 tests, all passing: lifecycle (activate/deactivate/suspend/reactivate restrictions, reason required, no inactive→suspended), assignment (valid, inactive collector blocked, duplicate active blocked, atomic transfer, reason required, wrong current collector rejected, history preserved), performance (daily totals excluding reversed, weekly/monthly/custom, follow-up list, cross-collector isolation), offline capture timestamp normalization.
- Existing suites still pass: `tests/susu.test.ts` (35), `tests/offline-payload.test.ts` (7), `tests/staff-status.test.ts` (2).
- `npx tsc --noEmit` clean (excluding pre-existing errors in rehearsal/cleanup scripts). `npx eslint` clean on all touched files.
