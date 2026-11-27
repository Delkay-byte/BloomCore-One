# Susu enterprise transformation — Phase 0 findings and Phase 1 plan

Status: Phase 0 verified against source on 2026-11-27. Phase 1 implemented locally only.
No production database, deploy, push, merge or external service was touched.

## Phase 0 — verified architecture

### Reusable capabilities
- Canonical tenant context: `src/lib/tenant.ts` — `getTenantContext`, `getApiTenantContext`, `assertTenantEntity`, `assertAllTenantEntities`. Tenant comes only from a verified module session and database rows; browser-supplied `tenantId` is never accepted.
- Session/module binding: `src/lib/auth.ts` — `readModuleCookie`, `payloadMatchesModule`, `verifyTabProof`, `SessionRecord`. Dual-role users get separate module sessions.
- RBAC helpers: `requireTenantAdmin`, `requireTenantAdminSusu`, `requireTenantCollector`, `requireTenantWorker`, `requireTenantCustomer` in `src/lib/tenant.ts`.
- Security primitives: `src/lib/security/step-up.ts`, `src/lib/security/dual-control.ts`, `src/lib/security/export-rate-limit.ts`, `src/lib/security/rate-limit.ts`, `src/lib/audit.ts` (`createAuditLogTx`).
- Branch model: `Location` (id, tenantId, name, code, status) already exists and is tenant scoped. MoMo workflows already scope workers by `User.locationId`: `daily-account.actions.ts`, `branch-transfer.actions.ts`, `shift.actions.ts`, `momo-ledger.actions.ts`.
- Financial invariants: `Contribution.referenceId @unique`, `ContributionAllocation`, `reversalOfId @unique`, `CollectorRemittance` idempotency key/hash, `db.systemJobLease` cross-process fencing.
- Offline: `src/lib/offline/*` and `src/app/api/offline/sync-contribution/route.ts` — encrypted queue, payload digest, key reservation, P2002 replay, device enrolment and 24 h authorisation.

### Confirmed gaps (verified against current source)
- `Collector` has no branch/location field; Susu collector creation never sets `User.locationId`.
- `Contribution`, `CollectorRemittance`, `Withdrawal`, `CustomerWithdrawalRequest`, `OfflineTransaction`, `OfflineActionRequest` have no branch field. Branch attribution cannot be derived later from a mutable employee relationship.
- No branch-manager or finance membership model; `User.role` only `admin | worker | collector | customer`. Tenant admins see all branches by design.
- `src/app/api/offline/sync-request/route.ts` validates subject tenant but not collector assignment or branch.
- Assignment weaknesses: overlapping active assignments possible; no atomic transfer or history (Phase 2).
- Reversal rows are not filtered in several aggregates (Phase 2 reporting work).

### Design decisions
- Reuse `Location` as the branch. No duplicate branch model.
- Add `BranchMembership` (tenant, user, location, role, status) as the maintainable scope model. A role-`admin` user with active `branch_manager`/`finance` membership is scope restricted; a role-`admin` user without such membership keeps existing company-wide authority. Collector scope comes from `Collector.branchId`. No new global role or JWT change is needed in Phase 1.
- Store branch directly on financial records at creation time. Historical rows keep `NULL` = explicit `LEGACY_UNASSIGNED`; no guessed backfill. A collector's later branch change never rewrites old records.
- Additive migrations only; no edits to applied migrations; no destructive backfill.
- Single-branch compatibility: when the authenticated scope has one branch, or the tenant has exactly one active branch, the branch is derived server-side. With several branches and no explicit choice, writes fail closed with a clear message.

### Historical-data risks
- Existing Susu financial rows have no branch. `NULL` must remain readable and reportable as `LEGACY_UNASSIGNED`.
- Existing collectors with no branch must remain usable in single-branch tenants; multi-branch tenants require explicit assignment for new writes.
- `Location` deactivation must not erase history; deactivation only blocks new assignments. No branch delete path is introduced.

### Implementation sequence (Phase 1)
1. Schema: `BranchMembership`, branch columns and indexes in both Prisma schemas.
2. Local additive migration for PostgreSQL; SQLite schema via `prisma db push` in tests.
3. `src/lib/branch.ts`: scope resolution, tenant+branch assertion, write-branch resolution, history-safe helpers.
4. Branch management actions: list/create/update/activate/deactivate, scoped to tenant admin.
5. Branch-aware Susu actions: collector creation/assignment, contribution recording/history, remittance, withdrawal workflows, dashboards, offline sync, audit views.
6. UI: minimal branch administration, branch selector for scoped admins, branch scope indicators.
7. Tests: RED first — cross-tenant, cross-branch, collector scope, client-supplied branch IDs, legacy immutability, offline branch validation.

### Security and regression strategy
- Direct server actions and API routes, not only pages.
- Synthetic fixtures: one-branch/two-collector business; three-branch business; central admin; one-branch manager; branch-changing collector; legacy contribution; offline capture before/after branch change.
- Run focused unit tests, PG integration tests, Prisma validation/format, migration rehearsal, typecheck, lint, full unit suite when isolated.
