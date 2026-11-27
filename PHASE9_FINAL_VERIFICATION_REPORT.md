# MaaCash Susu Enterprise Transformation — Phase 9 Final Verification Report

**Phase:** 9 — Final Integration, Security and Release Readiness Verification
**Branch:** `feat/susu-enterprise-phases-1-9-verification`
**Worktree:** `BloomCore-One-susu-phases-1-9-verification`
**Integration commit:** `39a23d0` (merge of Phase 8 `61335fe` into `8a98782`)
**Date:** 2026-11-27
**Scope:** local-only verification. No push, pull request, merge to main, deployment, production database access, provider connection or real customer data was used.

---

## 1. Executive summary and readiness decision

Phases 1–8 were reviewed against the code rather than against their reports, merged into a single verification branch, and exercised on SQLite and PostgreSQL. Two real defects were found and fixed during this phase:

1. **Phase 8 staff lifecycle was not branch-scoped.** A branch-limited administrator could read the whole tenant staff directory and call offboarding, role change, branch assignment and session revocation on any person in the business. The page and every lifecycle action now require company-wide administrator access, matching the existing branch-administration rule. A regression test proves a branch manager cannot read the board, offboard a colleague, or change a role.
2. **The PostgreSQL release verifier's upgrade rehearsal was invalid.** It applied "every migration except a hard-coded list" as the pre-upgrade schema, then applied the list. Because later migrations legitimately depend on earlier ones (`20261222` alters a table created by `20261221`), the fixture database was impossible and the gate failed at `RiskIntelligenceConsent`. The rehearsal now treats the cut-off as a prefix of the ordered chain and verifies fresh, existing-data upgrade and interrupted-migration recovery successfully.

The previously reported PostgreSQL hook timeout was reproduced and root-caused: `TRUNCATE` cleanup was waiting on `DataFileImmediateSync`, a per-relation synchronous file write, on the Docker Desktop volume. Disabling `fsync` and `synchronous_commit` on the **disposable test server only** removed the stall; three consecutive full PostgreSQL runs passed 15 files / 61 tests in 20–22 seconds each. No assertion, timeout or test was weakened.

**Readiness decision: B — TECHNICALLY READY FOR CONTROLLED PILOT.**

This is not a decision for broad production. The code, tenant isolation, financial invariants and migration path are verified locally, but the release still depends on business validation (HCode cut-over counts, support staffing), infrastructure configuration (secrets, host, backups, monitoring) and owner authorisation before any real money or real customer data is handled. HCode and Hubtel are not integrated and must not be claimed as such.

---

## 2. Scope, constraints and prohibited actions

### 2.1 Included

- Create the verification worktree and branch from `8a98782`.
- `git merge --no-ff` the Phase 8 branch.
- Review Phases 1–8 against code, tests and contracts.
- Build and inspect a security matrix.
- Fresh PostgreSQL 16 migration rehearsal, plus a disposable PostgreSQL 18 rehearsal.
- Full SQLite suite, PostgreSQL suite, typecheck, lint, production build, full Playwright suite, release verification gate.
- Root-cause the PostgreSQL hook-timeout flake.
- Execute scenarios A–I.
- Review performance of the new administrative surfaces.
- Document the HCode and Hubtel boundary.
- Produce this report and `SUSU_ENTERPRISE_RELEASE_CHECKLIST.md`.

### 2.2 Excluded, and confirmed not performed

| Prohibited action | Status |
|---|---|
| Push, pull request, merge into main, main modification | Not performed |
| Deployment (Vercel, Render, HCode) | Not performed |
| Neon, Render or production database access | Not performed |
| Hubtel connection, sandbox call or credential | Not performed |
| Live Paystack transaction | Not performed |
| Production migration | Not performed |
| Real customer data | Not used; every fixture is synthetic |
| 1,000-VU load test | Not performed |
| Destructive Git (`reset --hard`, `clean`, stash, branch deletion) | Not performed |
| Phase 10 or further feature work | Not started |

The pre-existing `stash@{0}` was not touched. The main worktree was not modified; the verification branch was created from the integration commit in a separate worktree.

---

## 3. Baseline, worktree and merge record

| Item | Value |
|---|---|
| Baseline | `8a987825e93898eede16fd4ac60802ae4ccf6e44` ("test(susu): integrate and verify Phases 4-7 end to end") |
| Phase 8 tip | `61335fe` ("feat(susu): Phase 8 enterprise administration and support") |
| Verification branch | `feat/susu-enterprise-phases-1-9-verification` |
| Merge command | `git merge --no-ff feat/susu-enterprise-phase-8-admin-support` |
| Merge result | clean, no conflicts; merge commit `39a23d0` |
| Working tree after merge | clean |

The merge brought in 35 files: three support models, one additive migration, four action modules, the support/staff/guide/platform routes, navigation entries, four test files (43 tests) and the Phase 8 report. The Phase 8 report was read but not treated as evidence; the code and tests were inspected independently.

---

## 4. Independent review method

For each phase the review asked four questions:

1. **Does the implemented guard match the role the UI claims?** The page was not trusted; the server action and its tenant/branch predicate were read.
2. **Can a caller supply the tenant, branch or actor from the browser?** Any such field was traced to a server-side resolution.
3. **Is the financial or lifecycle consequence atomic?** The transaction boundary, audit write and post-commit state were checked.
4. **Is there a test that would fail if the guard were removed?** Where the only test exercised the happy path, that gap is recorded in section 13 or 20.

The review deliberately re-ran the suites rather than quoting the Phase 8 report's numbers. Where the Phase 8 report and the code differed, the code won and the difference is recorded here.

---

## 5. Phase 1 — branch scope and tenant foundation

**Verdict: verified.**

- `resolveBranchScope` derives the scope from persisted `BranchMembership` rows; a caller cannot pass a scope. `assertBranchAccess` is the write/read gate.
- `getTenantContext(module, requiredModule?)` and `requireTenantContext` resolve the tenant from the signed session, not from a header or body. The support work in Phase 8 reuses this, and its fallback for administrator-only sessions still reads the role from the database.
- Branch-scoped readers are refused a foreign branch rather than silently receiving unfiltered data in reporting, support and staff surfaces.
- The historical branch attribution on money rows is immutable; a later transfer does not rewrite the branch of a past contribution.

Evidence: `tests/branch-scope.test.ts`, `tests/branch-actions.test.ts`, `tests/branch-transfers.test.ts`, `tests/pg-branch.test.ts`, and the new branch-manager denial in `tests/susu-staff-lifecycle.test.ts`.

---

## 6. Phase 2 — collector and contribution operations

**Verdict: verified.**

- `recordContribution` requires an authenticated staff or customer identity, a tenant-owned account, a branch the actor may write, a positive amount and a unique reference. The cycle day allocation runs inside a transaction and the account advisory lock serialises concurrent balance changes on PostgreSQL.
- A duplicate reference is rejected by the database, not by a read-then-write check that could race.
- Offline sync uses the idempotency key as the durable identity and returns "already processed" on retry without double-posting.
- Collector assignment and collector status are checked server-side; a suspended collector cannot collect.

Evidence: `tests/susu-phase-2.test.ts`, `tests/susu.test.ts`, `tests/pg-offline-idempotency.test.ts` (including the 429 contract and concurrent-key test), `tests/security-release-fixes.test.ts`.

---

## 7. Phase 3 — remittance lifecycle

**Verdict: verified.**

- Declare → acknowledge receipt → independent verify is enforced by the transition guard, not by the UI. The verifier cannot be the declarer or receiver where separation is required.
- The collector remittance advisory lock serialises concurrent acknowledgements and verifications; a second verifier receives a failure, not a second settlement.
- Over-remittance and short-remittance are recorded as discrepancies, not forced into a balanced ledger.
- The remittance position is derived from allocated contributions, not from a mutable "settled" flag alone.

Evidence: `tests/susu-phase-3.test.ts`, `tests/pg-susu-phase-3.test.ts` (parallel receipt and verification races), `tests/susu-phases-1-7-integration.test.ts` (cash closed through Phase 5 and settled through Phase 3).

---

## 8. Phase 4 — withdrawal controls

**Verdict: verified.**

- A versioned tenant policy decides limits, high-value thresholds, required approvals and separation of duties. The request stores the policy version it was evaluated against.
- Step-up grants are single-use, five-minute, scene-bound and target/amount-bound; approval and payment each require their own grant. A grant for one amount cannot pay another.
- Payment writes the `Withdrawal` row and the evidence reference only after the gate closes. The customer cannot mark a request paid.
- Cross-branch requests are refused; the policy is evaluated with the branch of record.
- Phase 4 deliberately does not create or mutate Phase 5 reconciliation cases.

Evidence: `tests/susu-phase-4.test.ts`, `tests/withdrawal-policy.test.ts`, `tests/withdrawal-requests.test.ts`, `tests/pg-withdrawal-concurrency.test.ts`, `tests/pg-susu-phase-4.test.ts`.

---

## 9. Phase 5 — reconciliation and exception cases

**Verdict: verified.**

- Daily collector closing has a guarded state machine and a single owner; a second close for the same day is refused by the unique constraint and the transaction, not by a UI check.
- Branch/remittance/offline reconciliation sessions match statement lines, create exception cases for unmatched or anomalous lines, and never reverse a contribution or withdrawal themselves.
- Exception cases are owned, evidenced and resolved with a reason; resolution is audited.
- The optional `sourceSession` relation uses `SetNull`, and the test cleanup order was re-checked: the suspected foreign-key ordering bug was disproved, so no test helper was changed.

Evidence: `tests/susu-phase-5.test.ts`, `tests/susu-phase-5-cases.test.ts`, `tests/reconciliation-liquidity.test.ts`, `tests/pg-susu-phase-5.test.ts`, `e2e/maacash-reconciliation.spec.ts`.

---

## 10. Phase 6 — reporting and exports

**Verdict: verified, with one gap closed in Phase 8 and re-verified here.**

- Cycle, branch, consolidated and statement reports resolve the reader's branch scope and filter the underlying contribution, withdrawal and allocation rows, not only the cycle header.
- Branch-scoped readers do not see unassigned legacy accounts; company-wide readers do, and a foreign branch request is refused.
- CSV output uses the shared cell sanitiser, so a customer name beginning with `=` cannot become a spreadsheet formula.
- **Gap found in the Phase 6 verification and closed in Phase 8:** Susu report exports returned a CSV without an audit row. `susu-reporting.actions.ts` now writes `finance.susu_report_exported` with the report, row count, date range, branch and format before returning. A Phase 8 test asserts the row, and the Phase 9 suite re-runs it.

Evidence: `tests/susu-reporting.test.ts`, `tests/consolidated-reporting.test.ts`, `tests/csv-export.test.ts`, `tests/susu-guide-and-export.test.ts`, `e2e/maacash-consolidated-report.spec.ts`.

---

## 11. Phase 7 — onboarding, bulk import and migration

**Verdict: verified.**

- Office and field registration create a customer, an account and the first cycle with a real opening date and branch/collector attribution.
- Bulk import is staged and previewed with a plan hash; confirmation requires the literal `IMPORT`, is idempotent per row and resumable by `(tenantId, fileHash)`.
- Import commits **identity only**: zero contributions, withdrawals, commissions or opening balances. A second tenant cannot preview or commit another tenant's batch.
- Histories are never fabricated; unresolved branches or collectors become review rows.

Evidence: `tests/susu-phase-7.test.ts`, `tests/susu-phases-1-7-integration.test.ts`, `tests/susu-phases-integration.test.ts`.

---

## 12. Phase 8 — administration and support, including defects found

**Verdict: verified after two fixes.**

The Phase 8 design holds up under review: tenant id from the session, tenant-visible messages filtered in the database predicate, platform-only internal notes, purpose-bound step-up grants, bounded metadata-only exports, live operational guidance, and audit rows for every administrative action. The platform actions all call `requirePlatformAdmin`; the tenant actions all call a tenant guard.

Two defects were found and fixed in Phase 9:

### 12.1 Branch-limited administrators could administer the whole tenant

`getStaffLifecycleOverview` loaded every active and inactive user for a tenant administrator, and `offboardStaff`, `reactivateStaff`, `changeStaffRole`, `assignStaffBranch`, `revokeStaffBranchMembership` and `revokeStaffSessions` did not require company-wide access. A branch manager could therefore read the tenant directory and offboard a colleague in another branch.

Fix:

- The staff page renders a "Company-wide access required" notice and does not call the read model for a branch-limited administrator.
- `getStaffLifecycleOverview`, `getStaffOffboardingReadiness` and `getStaffBranchOptions` require `isCompanyWideAdmin`.
- Every lifecycle mutation returns a structured denial: "Staff administration is limited to company-wide administrators."
- The new regression test creates a branch manager with a membership and proves the read model rejects, offboarding and role change are denied with no state change, and the target remains active with the original role.

This is recorded as a Phase 8 defect, not as a Phase 9 feature: Phase 8 shipped the gap; Phase 9 closed it.

### 12.2 What remains deliberately limited

- Staff account creation remains the pre-existing `/admin/staff` flow; the Phase 8 board links to it. There is no new creation test in Phase 9 either, because creation is not a Phase 8 code path.
- Platform action forms are covered by server-action tests, not clicked in the browser. The queue rendering and the tenant journey are browser-tested.
- Support creation and reply rate limits are wired but no test drives a subject to the ceiling.
- Internal-note discipline is enforced in the data predicate, not by judging what an agent types into a tenant-visible reply.

Evidence: `tests/susu-support-tenant.test.ts` (12), `tests/susu-staff-lifecycle.test.ts` (13 after the new test), `tests/platform-support.test.ts` (13), `tests/susu-guide-and-export.test.ts` (6), `e2e/maacash-support.spec.ts` (4 browser tests).

---

## 13. Security matrix

| Control | Implementation | Evidence | Status |
|---|---|---|---|
| Tenant resolution | Signed session; `getTenantContext`/`requireTenantContext` | `tests/tenant-isolation.test.ts`, `tests/tenant-status-access.test.ts` | Verified |
| Branch read scope | `resolveBranchScope` + `assertBranchAccess` | `tests/branch-scope.test.ts`, `tests/branch-actions.test.ts` | Verified |
| Branch write scope | `assertBranchAccess(..., "write")` before mutation | `tests/branch-actions.test.ts`, `tests/susu-support-tenant.test.ts` | Verified |
| Tenant admin guard | `requireTenantAdminSusu` (role + module + paid operations) | `tests/staff-status.test.ts`, Phase 8 suites | Verified |
| Staff lifecycle | Company-wide admin only (fixed in Phase 9) | New branch-manager test in `tests/susu-staff-lifecycle.test.ts` | Verified |
| Platform admin guard | `requirePlatformAdmin` on every platform action | `tests/platform-auth.test.ts`, `tests/platform-support.test.ts` | Verified |
| Self-protection | No self-offboard, self-reactivate or self-revoke | `tests/susu-staff-lifecycle.test.ts` | Verified |
| Privilege ceiling | Tenant cannot create/promote an admin | `tests/susu-staff-lifecycle.test.ts` | Verified |
| Step-up | Single-use, 5-minute, session- and target-bound, purpose-scoped | `tests/pg-step-up.test.ts`, `tests/susu-staff-lifecycle.test.ts` | Verified |
| Session revocation | `tokenVersion` bump + `SessionRecord.revokedAt` | `tests/susu-staff-lifecycle.test.ts`, `tests/platform-session-revocation.test.ts` | Verified |
| Internal notes | Database predicate `visibility: "tenant"` on tenant reads | `tests/susu-support-tenant.test.ts`, `tests/platform-support.test.ts` | Verified |
| Credential screening | Rejects keys, JWTs, bearer tokens and `password: value` text | `tests/susu-support-tenant.test.ts` | Verified |
| Export authorisation | Step-up grant bound to dataset; branch scoped; audited | `tests/susu-guide-and-export.test.ts` | Verified |
| CSV injection | Shared `csvCell` neutralises formula prefixes | `tests/csv-export.test.ts` | Verified |
| Support rate limits | `supportRequest`, `supportReply`, `adminExport*` wired | Code review; no ceiling test | Partial |
| Offline idempotency | Unique key; retry returns the prior result | `tests/pg-offline-idempotency.test.ts`, `tests/offline-isolation.test.ts` | Verified |
| Financial concurrency | Account/remittance advisory locks on PostgreSQL | `tests/pg-withdrawal-concurrency.test.ts`, `tests/pg-susu-phase-3.test.ts` | Verified |
| Webhook signatures | Raw-body HMAC for Paystack; timestamp never rescued by legacy header | `tests/security-release-fixes.test.ts`, `tests/security-hardening.test.ts` | Verified |
| Audit trail | Tenant transaction audit; platform audit with request reference | Phase 8 suites, `tests/susu-reporting.test.ts` | Verified |
| Migration safety | Explicit confirmation + loopback + `maacash_test*` name | `scripts/pg-safety.mjs`; rehearsals in section 15 | Verified |
| No impersonation | Platform reads through its own guard; no tenant session minted | `tests/platform-support.test.ts` | Verified |

**Partial row:** the rate-limit ceilings are the one control in this matrix without a dedicated ceiling test. The primitive is tested elsewhere, and the actions call it, but Phase 9 does not claim more than that.

---

## 14. Tenant isolation and authorization evidence

- A second tenant cannot list, read, reply to, reopen or export the first tenant's support requests; a foreign branch id is refused before any write.
- A branch-limited administrator sees only their branches' requests plus their own submissions; the detail query repeats the predicate rather than relying on the list.
- A platform session cannot call a tenant action and a tenant session cannot call a platform action; both directions are tested.
- A tenant administrator sees tenant-visible messages only; an internal note is absent from the tenant detail and the tenant export, and present in the agent view.
- A branch manager cannot read the staff board or mutate staff (Phase 9 fix).
- Export scope is derived from the actor, not from a row filter supplied by the client.
- The support fallback for an administrator-only session still requires a live tenant session and an admin role read from the database; it is not an unauthenticated path.

The one residual authorization area is the platform action forms: their server actions are tested, but the browser interaction is not. This does not change the authorization decision, which happens server-side.

---

## 15. Data model and migration verification

### 15.1 Schema and migration

Phase 8 adds exactly three tables: `SupportRequest`, `SupportMessage` and `SupportEvent`, with five request indexes, two message indexes, two event indexes and additive foreign keys. No existing table, column or index is dropped or rewritten. Both `prisma/schema.prisma` and `prisma/schema-pg.prisma` carry the block, and the migration is plain SQL that applies to both providers.

The chain now has **78 migrations**. `npx prisma validate` accepts both schemas. The Phase 8 fresh PostgreSQL 16 rehearsal applied all 78, reported "Database schema is up to date!" and "No difference detected."

### 15.2 Phase 9 rehearsals

| Rehearsal | Environment | Result |
|---|---|---|
| Fresh PostgreSQL 16 chain | New database `maacash_phase9_fresh` on the disposable PG16 container (port 55499) | 78 migrations applied; status up to date; migrate diff empty |
| Disposable PostgreSQL 18 chain | New container `maacash-phase9-pg18` (port 55498, `postgres:18-alpine`), new database `maacash_phase9_test` | 78 migrations applied; status up to date; migrate diff empty; container removed |
| Release verifier fresh chain | Temporary database, 156 tables | pass |
| Release verifier existing-data upgrade | Prefix chain through `20261221`, representative rows inserted, remaining migrations applied | customer and daily-account values preserved byte-for-byte; six new tables created; re-deploy no-op |
| Release verifier interrupted-migration recovery | Deliberately failed migration row | deploy refused; `migrate resolve --rolled-back` cleared it; re-deploy succeeded |

**Defect fixed in this phase:** the release verifier previously staged "all migrations except a hard-coded set" as the pre-upgrade database. That is not a valid schema because later migrations depend on the excluded ones. It now uses an ordered prefix cut-off. The failed run failed at `20261222_risk_intelligence_governance_safeguards` with `relation "RiskIntelligenceConsent" does not exist`; after the prefix fix the same command passed all three rehearsals.

The PG18 rehearsal is genuinely optional and was performed because the image was already present locally; it is not required for the decision and did not touch the pre-existing PG18 container used by another project.

---

## 16. Test verification ledger

| Command | Scope | Result |
|---|---|---|
| `npm run typecheck` | whole tree | exit 0 |
| `npm run lint` | whole tree | 0 errors, 193 warnings (baseline count) |
| `npm test` | SQLite, 181 files | **2,073 tests passed**, 375.37 s |
| `npm run test:pg` | PostgreSQL 16, 15 files | **61 tests passed**, 3 consecutive runs (21.14 s, 20.14 s, 22.02 s) |
| `node scripts/verify-pg-migrations.mjs` | fresh, upgrade, recovery | all three passed |
| `npx playwright test e2e/maacash-support.spec.ts` | support, guide, staff, platform queue | 4 passed (2.4 min) |
| `npm run test:release` | full gate: schema, SQLite provisioning, PG rehearsals, SQLite suite, PG suite, typecheck, lint, build, Playwright | **PASS** (SQLite 379 s, PG 32 s, TypeScript 8 s, ESLint 73 s, build 282 s, browser 560 s) |
| `npm run test:e2e` (inside the gate) | production build, desktop and mobile | **129 passed (8.9 m)** |
| Fresh PG16 / PG18 | migrations | pass (section 15) |

Baseline before Phase 8: 177 files / 2,029 tests / 451.36 s; PG 15 files / 61 tests. Phase 9 final: 181 files / 2,073 tests. The increase is Phase 8's four files and 44 tests (43 originally plus the branch-manager regression).

The TypeScript and ESLint results are from the final tree. The full release gate is the single command that binds schema validation, SQLite provisioning, PostgreSQL rehearsals, unit tests, PostgreSQL tests, typecheck, lint, production build and Playwright. It finished with **Release verification PASSED** and every step green: Prisma validation 3 s, SQLite provisioning 9 s, PostgreSQL migration rehearsal 16 s, SQLite suite 379 s, PostgreSQL suite 32 s, TypeScript 8 s, ESLint 73 s, production build 282 s, browser acceptance 560 s. The browser suite ran 129 tests (the Phase 1–7 baseline of 125 plus the four Phase 8 support tests) and passed all of them.

---

## 17. PostgreSQL hook-timeout root cause and remediation

**Symptom:** `tests/pg-offline-idempotency.test.ts` failed in `beforeEach` with `Hook timed out in 10000ms` in 3 of 5 earlier full runs; the file alone passed 12 of 12.

**Investigation:** a temporary monitor sampled `pg_stat_activity` during the cleanup. When the failure reproduced, there was no competing session and no advisory-lock waiter. The test's own `TRUNCATE` was active and waiting on:

```
wait_event_type = IO
wait_event      = DataFileImmediateSync
```

**Root cause:** `TRUNCATE` forces an immediate sync of each relation's new file. The cleanup truncates about 40 tables, so it performs about 40 synchronous writes. On this Windows host the disposable PostgreSQL container stores data on the Docker Desktop volume; under concurrent host I/O the cumulative sync latency exceeded the 10-second hook budget. The database logs showed no deadlock or statement timeout, which matches a pure I/O stall.

**Remediation:** the disposable test server only was restarted with `fsync = off` and `synchronous_commit = off`; `SHOW fsync` and `SHOW synchronous_commit` confirmed both. No test timeout, assertion or application behaviour changed. Production and managed databases must keep `fsync = on`.

**Result:** three consecutive full PostgreSQL runs passed 15 files / 61 tests in 20–22 seconds. The suite previously took 67.39 s and failed in the first diagnostic run. The root cause, evidence, commands and residual CI limitation are documented in `docs/testing/POSTGRES-TEST-ENVIRONMENT.md`.

**Residual:** a CI runner with default durability settings on a slow volume can still hit this stall. The correct configuration is a disposable PostgreSQL service with `fsync=off` or a tmpfs data directory. Raising the hook timeout was deliberately not done because it would hide the condition.

---

## 18. Scenario execution A–I

The nine scenarios below are the end-to-end business journeys this release must support. Each was executed through the real action/route layer with synthetic data; the browser suite adds UI coverage where noted. They are not marketing walkthroughs: each asserts a failure mode as well as a success.

| # | Scenario | What was exercised | Evidence |
|---|---|---|---|
| A | A new business goes live | Tenant, branch, admin, collector, withdrawal policy, customer, account, cycle, first contribution | `tests/susu-phases-1-7-integration.test.ts` ("collects on a newly registered customer..."), `tests/susu-phase-7.test.ts` |
| B | A collector takes cash twice with one key | Duplicate reference, retry, offline idempotency, branch attribution | `tests/susu-phase-2.test.ts`, `tests/pg-offline-idempotency.test.ts` ("posts a retried idempotency key exactly once") |
| C | Cash is declared, received and verified once | Parallel receipt/verification, discrepancy creation, collector position | `tests/susu-phase-3.test.ts`, `tests/pg-susu-phase-3.test.ts` |
| D | A customer withdraws | Policy limits, high-value approval, step-up, payment evidence, cross-branch refusal | `tests/susu-phase-4.test.ts`, `tests/withdrawal-policy.test.ts`, `tests/pg-susu-phase-4.test.ts` |
| E | The day closes and reconciles | Single daily close under a race, statement matching, exception resolution, no double-close | `tests/susu-phase-5.test.ts`, `tests/susu-phase-5-cases.test.ts`, `tests/pg-susu-phase-5.test.ts` |
| F | A business imports its customers | CSV staging, plan hash, `IMPORT` confirmation, duplicate/idempotent rows, no invented money, tenant isolation | `tests/susu-phase-7.test.ts`, `tests/susu-phases-1-7-integration.test.ts` |
| G | An owner exports a report | Branch-scoped figures, CSV formula safety, export audit row | `tests/susu-reporting.test.ts`, `tests/susu-guide-and-export.test.ts`, `tests/csv-export.test.ts` |
| H | A business asks for help | Tenant request, platform acknowledge/reply/internal note/resolve, tenant sees resolution but never the internal note; admin-only session access | `tests/susu-support-tenant.test.ts`, `tests/platform-support.test.ts`, `e2e/maacash-support.spec.ts` |
| I | A staff member leaves | Blocked while work is live, offboard after transfer, sessions and memberships revoked, self and branch-manager denial, reactivation | `tests/susu-staff-lifecycle.test.ts`, `e2e/maacash-support.spec.ts` |

**Honest scope note:** H is browser-tested end to end; I's board is browser-checked and its lifecycle is action-tested; A–G are integration/action-level journeys, not new browser scripts. The full Playwright suite is run as a separate gate (section 16). Calling these "E2E" is accurate at the system boundary (real database, real actions, real guards) but not a claim that every step in A–G was clicked in a browser.

---

## 19. Performance review

No load test was run; the 1,000-VU test remains prohibited for this phase. The review is static plus suite timing.

| Area | Finding |
|---|---|
| Support queue | `MAX_QUEUE = 200`; summary uses eight parallel counts; five request indexes cover status, tenant, submitter, assignee and priority. At the pilot's expected volume this is bounded and index-supported. |
| Tenant support list | `take: 200`; detail loads messages only for one request; no unbounded findMany on the tenant path. |
| Support export | `MAX_TENANT_EXPORT_ROWS = 5000`; platform export `MAX_EXPORT_ROWS = 5000`; metadata only. |
| Staff overview | Bulk `groupBy` queries for assignments, remittances, cases, offline requests and approvals; no per-user query loop. |
| Staff export | Branch-scoped, bounded, one audit write. |
| Reporting | Existing paged/aggregate queries; export audit adds one insert per export, not per row. |
| PostgreSQL suite | 61 tests in 20–22 s after the test-server fix; the application itself is not tuned by that setting. |
| Browser suite | Full suite duration is recorded in the final ledger; no performance assertion is attached to it. |

The known scaling limits are honest: the support queue is not paginated beyond 200, exports stop at 5,000 rows, and the staff board computes readiness for every staff member in one transaction. Those are appropriate for a controlled pilot and must be revisited before broad production.

---

## 20. HCode/Hubtel boundary, blockers and final decision

### 20.1 HCode and Hubtel

Neither is integrated. There is no HCode or Hubtel code, credential, endpoint, webhook or test in the tree. The detailed boundary is in `PHASE9_PROVIDER_BOUNDARY.md`; the short version:

- HCode is a CSV cut-over source only. A live connector would need a separate approved design; historic money is never fabricated.
- Hubtel is not a dependency. Manual, evidence-backed Susu flows are what this release verifies. Automated collection, payout, statement ingestion, fee accounting and SMS are explicitly not delivered.

### 20.2 Readiness decision

**B — TECHNICALLY READY FOR CONTROLLED PILOT.**

Why not A: the tenant guards, financial invariants, migrations, full SQLite suite, PostgreSQL suite and browser suite pass locally, and the two defects found in review are fixed with regression evidence.

Why not C: broad production needs business validation (HCode counts and field mapping, support staffing and escalation ownership), infrastructure configuration (production secrets, host, backups, monitoring, PG durability settings), and owner authorisation (real money, provider connections, deployment). It also needs the platform action forms and rate-limit ceilings exercised in a browser/load context.

### 20.3 Outstanding blockers before a pilot

1. **Business validation of HCode migration**, if a business is moving from HCode: field mapping, duplicate counts and opening-position sign-off.
2. **Support operating model**: named agents, escalation ownership and response expectations. The queue exists; the staffing does not.
3. **Production infrastructure configuration**: secrets, database, backups, monitoring and the decision to keep `fsync=on` in production.
4. **Owner authorisation** for the pilot scope, data set and any provider connection.
5. **Platform action browser coverage** and **rate-limit ceiling tests** are quality gaps, not authorisation gaps; they should be closed before broad production.
6. **Staff onboarding test**: the Phase 8 board links to the inherited creation flow, which Phase 9 did not re-prove.

### 20.4 Confirmation of no production action

No push, pull request, merge to main, deployment, production migration, Neon/Render access, Hubtel connection, live Paystack transaction or real customer data was used. All databases were disposable and loopback; all fixtures were synthetic; the pre-existing stash was untouched.

**Signed off locally on `feat/susu-enterprise-phases-1-9-verification`: merge commit `39a23d0` plus the Phase 9 fix commit at the tip of this branch.**
