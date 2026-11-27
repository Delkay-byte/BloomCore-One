# MaaCash Susu Enterprise — Phases 1–7 Integration Report

**Classification: `INTEGRATION COMPLETE`** (local integration only; nothing deployed,
pushed, merged to `main` or connected to a live provider).

Prepared on branch `feat/susu-enterprise-phases-1-7-integration` in worktree
`BloomCore-One-susu-phases-1-7-integration`, starting from the Phases 1–3 baseline
`7073548`. All test data is synthetic. No real customer, payment or production data was
read or written.

---

## 1. Executive summary

Phases 4, 5, 7 and 6 were merged, in that order, onto the existing Phases 1–3 integration.
Nothing was rebuilt and no Phase 1–3 history was rewritten: every source branch is
preserved as a second parent, and the source worktrees were never opened for writing.

What the integration pass found and fixed (all committed on the integration branch):

1. **Phase 6 migration ordering defect.** `20261127_susu_reporting_indexes` indexed
   `Contribution.branchId` before `20261227_susu_branch_foundation` created it, so a fresh
   PostgreSQL database could not apply the chain. The migration was renamed (via
   `git mv`, SQL untouched) to `20261229_susu_reporting_indexes`.
2. **Phase 6 contract gap.** `exportSusuReport` declared `report: "cycles"` but returned
   `"Unsupported report."`. Cycle export is now implemented for the same filtered set as
   the screen.
3. **Phase 6 branch-scope gap.** Cycle reporting was tenant-scoped only, even though
   Phase 7 gave `SusuAccount` a `branchId`. It now resolves the shared branch scope and
   filters rows and per-cycle money by the account branch.
4. **Phase 6 navigation/UI gaps.** Reports were split across pages with no shared tabs;
   four report pages had no server-side export. A shared tab layout, a server-side export
   button and the missing nav entries (`Withdrawal Controls`, `Reports & Analytics`) were
   added.
5. **`"use server"` hygiene.** One baseline module exported a non-async constant from a
   `"use server"` file; the export was removed (implementation detail, no behaviour change).

Verification is comprehensive and all green: 2,029 SQLite tests, 61 PostgreSQL tests on a
**fresh** PostgreSQL 16 database with the full 77-migration chain and zero drift, clean
typecheck, lint (0 errors), production build, and the full Playwright suite
(see §14).

## 2. What "integration" means here

The task was to make four independently developed phases behave as one system, not to
redesign them. The rules that governed every edit:

- no second withdrawal reversal engine, settlement engine or case model;
- no automatic Phase 4 → Phase 5 case feed;
- no fabricated financial history, especially not in imports;
- no weakening of tenant, branch or role authorisation to make a test pass;
- synthetic data only; no secrets, no production targets, no deployment.

Every correction either closed a contract gap the phase itself declared, or fixed an
ordering/navigation defect that only appears when the phases sit together.

## 3. Baseline, branches, worktrees and merge sequence

| Step | Commit | Shape | Notes |
| --- | --- | --- | --- |
| Phases 1–3 baseline | `7073548` | provided | not re-merged, not rebuilt |
| Phase 4 | `2c28842` | merge, `--no-ff` | source head `e03d250` (8 commits preserved) |
| Phase 5 | `ef2f11b` | merge, `--no-ff` | source head `c911104` |
| Phase 7 | `e1a5ade` | merge, `--no-ff` | source head `f7ea45f` |
| Phase 6 | `2839ab7` | merge, `--no-ff` | source head `515f7bb`, clean (no conflicts) |

Before the integration corrections the merged tree changed 75 files against the baseline;
the corrections add the report layout/tabs, the export button, the cycle-scope and cycle-
export changes, the nav entries, the Phase 6 contract update, the new cross-phase test file
and this report. The finished branch changes **82 files** against `7073548`
(about +28.4k / −466). Source branches remained at exactly the required commits and their
worktrees were not modified.

Merge order (4 → 5 → 7 → 6) was chosen so that Phase 7 (which adds
`SusuAccount.branchId`) lands before Phase 6 reporting, which now depends on it.

## 4. Conflict resolution record

Only two textual conflicts occurred, both semantic unions rather than choices:

- `src/lib/evidence-constants.ts` — Phase 5 added `"reconciliationExceptionCase"`, Phase 6
  added `"withdrawalRequest"` (or vice versa); both subject types are valid evidence
  subjects, so both were kept, alphabetically ordered.
- `tests/pg-setup.ts` — both phases extended the truncation order; both blocks were kept,
  with the case-before-session order required by the foreign keys.

Nothing was resolved by discarding a side. No `git reset --hard`, `git clean`, stash,
destructive checkout, branch deletion or worktree switch was used.

## 5. Prisma schema reconciliation (SQLite and PostgreSQL)

- `prisma/schema.prisma` (SQLite) and `prisma/schema-pg.prisma` (PostgreSQL) are
  structurally identical: same models, fields, relations, enums, `@unique` constraints and
  indexes.
- The only intentional PostgreSQL-only differences are two mapped index names
  (`RiskIntelligenceConsent @@index([expelledAt], map: …)` and
  `EmployeeNoticeAttestation @@index([tenantId, verified], map: …)`), which exist because
  SQLite does not support `map` on those definitions.
- Both schemas validate (`prisma validate`) and the PostgreSQL database built from
  `prisma/migrations` matches `prisma/schema-pg.prisma` exactly (see §6).
- A structural comparison with comments, `provider`, URLs and mapped index names
  normalised leaves exactly **two** differences — the two PostgreSQL-only mapped indexes —
  and 3,387 vs 3,389 significant lines. The other line-level differences are SQLite-only
  documentation comments.
- Phase 4/5/7 additions are additive: new tables (`WithdrawalApproval`,
  `WithdrawalPolicy`, `ReconciliationSession`, `ReconciliationExceptionCase`,
  `CustomerImportBatch`, `CustomerImportRow`, `CustomerImportRowEvent`), new nullable
  columns and indexes. No existing column was renamed or retyped.

## 6. Migration chain and the ordering defect

**Defect.** Phase 6 shipped `prisma/migrations/20261127_susu_reporting_indexes`, which
creates indexes on `Contribution.branchId`, `Withdrawal.branchId`,
`CollectorRemittance.branchId` and `AuditLog.branchId`. Phase 7 shipped
`20261227_susu_branch_foundation`, which adds those columns. Lexicographic ordering put
Phase 6 first, so any database that had not already received the Phase 1–3 branch columns
failed on a fresh apply. It had gone unnoticed because each phase worktree applied its own
migration on top of an already-migrated dev database.

**Fix.** The Phase 6 migration directory was renamed to `20261229_susu_reporting_indexes`
with `git mv`; the SQL is byte-identical, so no database that already applied it is
affected (Prisma records the migration name, not the timestamp).

**Fresh rehearsal.** A brand-new database `maacash_test_int_fresh` was created in the
disposable PostgreSQL 16.15 container (`maacash-int-pg16`, `127.0.0.1:55499`) and the real
chain applied:

```text
$ npx prisma migrate deploy --config prisma.pg.config.ts
All migrations have been successfully applied.   # 77 migrations, finished_at = 77
$ npx prisma migrate diff --config prisma.pg.config.ts --from-config-datasource --to-schema prisma/schema-pg.prisma --exit-code
No difference detected.                          # exit 0
```

PostgreSQL 18 was not rehearsed; it was listed as optional and the local PG18 container
belongs to another project. The chain contains no version-specific SQL beyond standard
`CREATE INDEX IF NOT EXISTS`, so PG16 success is strong evidence, not proof, for PG18.

## 7. Shared helpers, models and server-action hygiene

- **Branch scope is one implementation.** `src/lib/branch.ts` exposes
  `resolveBranchScope`, `resolveUserBranchScope`, `resolveWriteBranch`,
  `assertBranchAccess`, `isBranchlessTenant`, `resolveCustomerRequestBranch`,
  `isCompanyWideAdmin` and `LEGACY_UNASSIGNED_BRANCH`. Phase 4/5/6/7 actions call these
  rather than re-deriving scope; the integration added no new scope helper.
- **Reporting scope** uses `branchWhere(scope, override)` in
  `src/lib/actions/susu-reporting.actions.ts`: limited reader without an override → their
  branches; limited reader naming a foreign branch →
  `"Branch not in your authorized scope."`; company-wide reader with an override → that
  branch; company-wide reader without one → tenant-wide. The cycle report now uses it too.
- **`"use server"` modules export only async functions.** All 82 modules carrying the
  directive (including `src/app/**`) were audited. One baseline constant (`OFFLINE_REQUEST_STATUS_LABELS`) was exported from
  `offline-request.actions.ts`; it is now a module-local constant. The existing SEC-01
  regression test (`tests/security-release-fixes.test.ts`) still passes.
- **Money representations are explicit at each boundary:** `Contribution.amount` is a
  Decimal in GHS; Phase 4 policy thresholds are integer pesewas; report totals are
  `number` GHS. Converting at the wrong boundary is the main Hubtel risk (see §18).

## 8. Navigation, routes and UI corrections

| Problem | Correction |
| --- | --- |
| Reports pages had no shared navigation; six report pages lived on separate routes with no common tab bar | `src/app/susu/admin/reports/layout.tsx` + `_components/ReportTabs.tsx` with Overview, Contributions, Collectors, Branches, Cycles, Customer statements, Transaction lists |
| No nav entry for Phase 4 | `Withdrawal Controls` (`ShieldCheck`) added to `src/lib/admin-nav.tsx` |
| Reports nav pointed at the bare index | now `Reports & Analytics` → `/susu/admin/reports/overview` |
| Contributions page exported only the visible page, client-side | `ExportReportButton` → `GET /api/susu/reports/export?report=contributions&…` (server-side full filtered set, rate limited, formula-sanitised) |
| Branches, collectors and cycles had no export | same button added with the page’s own filters |
| `report=cycles` was unimplemented | implemented in `exportSusuReport`, CSV columns documented in the Phase 6 contract; the CSV prints the branch **name** (falling back to the id) instead of a raw cuid |
| Cycle table showed no branch | a Branch column now shows the account branch name |

Build output confirms the routes exist: `/susu/admin/reports/{overview,contributions,
collectors,branches,cycles,customers}` plus the transaction-list index
`/susu/admin/reports`, `/susu/admin/withdrawal-controls` and
`/api/susu/reports/export`.

## 9. Phase 4 — withdrawal controls

What integrates cleanly: a tenant policy (limits, high-value threshold, required
approvals, separation of duties, step-up, evidence fields) is evaluated when the customer
requests a withdrawal; `requested → awaiting_payment` (or `needs_review`) → `paid`;
approval and payment each need a scoped, single-use step-up grant bound to the exact
amount, purpose, target and session; payment writes the `Withdrawal` row and the evidence
reference. The policy is versioned and audited.

Integration checks: policy → request → approval → payment works end-to-end on a real
customer session (scenario C); concurrent approval/payment gates are covered by the Phase 4
suite (`eb4762f`); cross-branch denial by `e03d250`; the Phase 4 PostgreSQL coverage test
runs in the PG suite.

Deliberate boundary kept: Phase 4 does **not** create, close or mutate Phase 5
reconciliation cases, and Phase 5 does not know about withdrawal approvals.

## 10. Phase 5 — reconciliation and exceptions

What integrates cleanly: daily collector closings
(`open → declare → handover → receive → close`, status `balanced`/`short`/`over`),
branch/remittance/sync reconciliation sessions, and a dedicated
`ReconciliationExceptionCase` model whose evidence subject is registered with the evidence
store. Phase 5 does not reverse contributions or withdrawals; it observes and escalates.

Integration checks: the same cash recorded through Phase 2 is closed through Phase 5 and
then settled through Phase 3 (scenario B); a paid Phase 4 withdrawal produces **zero**
reconciliation cases and a clean branch session balances (scenario C). The optional
`sourceSession` relation defaults to `SetNull`, so the test cleanup order is safe; the
suspected FK-order bug in `tests/setup.ts` was investigated and disproved, so the file was
left unchanged.

## 11. Phase 7 — onboarding, bulk import and migration

What integrates cleanly: office and field registration write a `Customer` +
`SusuAccount` + first `SusuCycle` with branch/collector attribution and a real opening date;
the CSV pipeline is staged (`createImportBatch` → `validateImportBatch` →
`getImportPreview` with `planHash` → `confirmImportBatch` requiring the literal `IMPORT`),
idempotent per row, resumable by `(tenantId, fileHash)`, and stores provenance
(`registeredVia`, `openedVia`, `importBatchId`, `externalAccountReference`).

Integration checks: an onboarded customer is immediately collectable and appears in
branch/cycle/statement reports with the right branch (scenario A); an import commits
identity only — zero contributions, withdrawals and commissions — and the imported account
is immediately collectable and reportable (scenario E); a second tenant cannot preview or
commit another tenant’s batch (scenario E).

Deliberate boundary kept: no opening balances, no back-filled contributions, no `.xlsx`,
no silent customer merge.

## 12. Phase 6 — reporting, and the branch-scoping decision

**Question:** does Phase 7’s `SusuAccount.branchId` enable safe branch filtering of Phase 6
cycle reports?

**Answer: yes, and it is now implemented.** `SusuCycle.account` is a required relation, so a
cycle belongs to exactly one account and therefore exactly one branch; the account branch
is the branch of record. Implementation:

- `getCycleReport({ branchId?, … })` resolves `resolveBranchScope(identity)` and applies
  `where.account = { branchId: branchFilter }`;
- per-cycle contributions, withdrawals and allocations are filtered by
  `Contribution.branchId` / `Withdrawal.branchId` / `allocation.contribution.branchId`, so
  an anomalous cross-branch row cannot inflate a branch-scoped total;
- each row returns `branchId` **and a human-readable `branchName`** (one tenant-scoped
  lookup per page, no N+1), and company-wide readers still see unassigned legacy accounts
  while branch-scoped readers do not;
- a limited-scope reader asking for a foreign branch is refused, not silently unfiltered;
- `exportSusuReport({ report: "cycles" })` uses the same function, so the CSV obeys the same
  scope.

Contract updated: `PHASE6_INTEGRATION_CONTRACT.md` now documents the semantics, the export
columns and the scope rules instead of the old “tenant-scoped only, because accounts carry
no branch” assumption.

## 13. Cross-phase scenarios

`tests/susu-phases-1-7-integration.test.ts` (5 tests) drives real server actions with real
cookie sessions; only `next/headers`, `next/navigation` and `next/cache` are mocked, so
tenant, branch, step-up and session checks are the production implementations.

| # | Scenario | Assertions |
| --- | --- | --- |
| A | Onboarding → collection → reporting | registered customer/account carry branch A; contribution gets branch A; contribution and cycle reports, branch report and customer statement agree on 50 |
| B | Contribution → remittance → daily closing | 2 × 100 collector cash; closing expects 200, `balanced` after declare/handover/receive; remittance declares 200, receipt and independent finance verification settle it; position and overview show 0 outstanding, 200 verified |
| C | Withdrawal controls + reconciliation | policy (10,000-pesewa threshold, step-up, separation of duties); customer request 200; approval and payment each with purpose/target/amount-bound step-up by different admins; exactly one withdrawal; branch session balances with **0** exception cases; policy persists; audit events recorded |
| D | Branch scope over account branches | branch-A manager sees only cycle A (100) and 100 net, is refused branch B, and an injected cross-branch 999 row does not leak into the branch-A aggregate; company-wide sees 2 cycles; branch-B narrowing returns 70; cycle CSV contains only branch A |
| E | Bulk import | 2 customers/accounts/cycles imported with branch A; 0 contributions/withdrawals/commissions; imported account is immediately collectable and appears in the branch report; foreign tenant cannot preview or commit |

These are deliberately in-process (Vitest) rather than browser tests: they exercise the
authorisation and accounting seams that a browser cannot reach, and they run in the normal
`npm test` gate.

## 14. Verification ledger

All commands run in the integration worktree, with synthetic SQLite/PostgreSQL data.

| Check | Command | Result |
| --- | --- | --- |
| SQLite suite (final tree) | `npm test` | **177 files / 2,029 tests passed**, 451.36 s (the new cross-phase file adds 1 file / 5 tests) |
| PostgreSQL chain (fresh DB) | `prisma migrate deploy --config prisma.pg.config.ts` | **77 migrations applied** on `maacash_test_int_fresh` |
| PostgreSQL drift | `prisma migrate diff --config prisma.pg.config.ts --from-config-datasource --to-schema prisma/schema-pg.prisma --exit-code` | **No difference detected** (exit 0); 77 applied migrations, 0 rolled back |
| PostgreSQL suite (final tree) | `npm run test:pg` | **15 files / 61 tests passed**, 46.69 s. Three of five full-suite runs hit a 10 s `beforeEach` `TRUNCATE` hook timeout in `pg-offline-idempotency` under load; the file passes 12/12 standalone and the final suite run passes 61/61 (see §19) |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | **0 errors**, 193 pre-existing warnings (none in the new test file) |
| Production build | `npm run build` | exit 0; Susu report/withdrawal routes emitted, and rebuilt by the Playwright web server on the final tree |
| Playwright E2E (full) | `npm run test:e2e` | **125 tests passed** (desktop chromium + Android-sized mobile-chromium), 13.0 min, against a fresh production build |
| Final-tree rebuild + Susu specs | `npm run test:e2e -- e2e/role-workflows.spec.ts e2e/maacash-reconciliation.spec.ts` | **9 tests passed**, 2.4 min, fresh production build, seeded E2E database |

## 15. Security invariants

Verified by the suites above, not assumed:

- **Tenant isolation** — every action resolves the tenant from the session; the import
  scenario proves a foreign tenant cannot preview or commit a batch; the existing
  `tests/tenant-isolation.test.ts` and `tests/financial-security.test.ts` pass.
- **Branch isolation** — Phase 4 cross-branch denial test, Phase 6 branch-scope tests, and
  scenario D’s foreign-branch refusal.
- **Step-up is scoped and single-use** — scenario C binds grants to
  `withdrawal.approve`/`withdrawal.pay`, target and amount; the Phase 4 suite covers
  concurrent approval/payment and expired/changed-amount grants.
- **Session binding** — grants are bound to the session `jti`; the integration tests sign
  real `jose` cookies and create real `SessionRecord` rows, so a stale/revoked session is
  rejected by production code.
- **Server-action surface** — only async functions are exported from `"use server"`
  modules (SEC-01 test plus the 82-module audit).
- **Exports** — server-side, rate-limited, formula-sanitised, tenant/branch scoped.
- **No secrets** — no credential was read or written; provider integrations are mock or
  platform-billing only.

## 16. Data-integrity and accounting invariants

- One remittance/settlement engine (Phase 3) and one reversal engine (Phase 1–2); Phase 6
  only reads them, Phase 5 never rewrites financial rows.
- A paid withdrawal creates exactly one `Withdrawal` and **no** reconciliation case
  (scenario C), preserving the contract that Phase 5 is an observer.
- Imports move identity and never money: 0 contributions/withdrawals/commissions after a
  commit (scenario E).
- Reversal figures are computed from `reversalOfId`/`reversedAt`; gross − reversed = net is
  asserted in the reporting suites.
- Branch attribution on a contribution is written at creation and never rewritten by later
  transfers.

## 17. HCode compatibility assessment

**Finding:** the integrated repository contains **no HCode reference** — no import schema,
API client, database link, configuration or sample export. `rg -i hcode` over the tree
returns only false positives (`is-fullwidth-code-point`, `hashCode`). No HCode-specific code
was written, because inventing a schema would be exactly the kind of unverified assumption
this integration must avoid.

What the Phase 7 migration boundary can accept today, and therefore what an HCode cut-over
would have to provide:

| Legacy (HCode) data | MaaCash destination | Constraint |
| --- | --- | --- |
| Customer name, phone, e-mail | `Customer` | phone normalised to E.164; e-mail globally unique |
| Passbook / customer number | `Customer.externalReference` | intentionally **not** unique (numbers repeat across years) |
| Account number | `SusuAccount.externalAccountReference` when MaaCash issues a different `accountId` | provenance only |
| Daily contribution | `SusuAccount.dailyContribution`, `SusuCycle.dailyContribution` | must be positive |
| Branch | `branchId` via `single_branch` or a per-row column | resolved against `Location`/`BranchMembership`, never guessed |
| Collector | `collectorRef` → `CollectorCustomerAssignment` | optional; unresolved rows become review items |
| Real start date | `SusuAccount.openingDate`, `SusuCycle.startDate` | `NULL` allowed when unknown |
| Historic contributions / balances | **refused** | no opening balances; history is not fabricated |

**Verdict: compatible with a controlled CSV cut-over, not with direct HCode sync.** A
one-off, reviewed, idempotent identity import is supported today; a live HCode database or
API feed would need a connector, a field-confirmation exercise with the business, and a
count reconciliation (customers, accounts, duplicates) on a synthetic extract first. Until
then HCode compatibility is **paper-only** and is not claimed as delivered.

## 18. Hubtel

See `HUBTEL_INTEGRATION_ASSESSMENT.md`. Summary: the repository has no Hubtel code at all;
the assessment maps Hubtel collections, payouts, settlement lines and SMS onto the Phase 1–7
surface, reuses the proven Paystack webhook/idempotency pattern, and classifies the work as
**not integrated, mapping viable, deliberately deferred**. The highest-risk detail is the
pesewa/GHS boundary: `Contribution.amount` is Decimal GHS while Phase 4 policy thresholds
are integer pesewas.

## 19. Limitations, risks and deliberate omissions

- **No push, PR, `main` merge or deployment.** Nothing was run against Neon, Render, HCode,
  Hubtel, Paystack live, or any production database.
- **PostgreSQL 18 not rehearsed** (optional; PG16 fresh chain and drift check passed).
- **No 1,000-VU load test** (forbidden) and no production smoke test.
- **HCode has no connector** and **Hubtel has no implementation** (by scope).
- **Baseline reporting gap:** no `PHASES_1_3_INTEGRATION_REPORT.md` exists in the baseline;
  the Phase 1–3 evidence is the phase contracts plus
  `docs/testing/POSTGRESQL_INTEGRATION_AND_REGRESSION_REPORT.md`.
- **Lint warnings (193) are pre-existing** and were not mass-fixed, to keep this branch
  reviewable as an integration rather than a style rewrite.
- **Legacy accounts with `branchId = null`** remain visible to company-wide readers and are
  excluded from branch-scoped reads; this is intentional and documented in the Phase 6
  contract.
- The Playwright suite is browser-level; it does not sign in with real customer credentials
  or touch a live provider (the web server is started with provider credentials blanked).
- **Pre-existing flake in `tests/pg-offline-idempotency.test.ts`.** Its `beforeEach` truncates
  150 tables and must wait for in-flight handler transactions. Under load that occasionally
  exceeds Vitest's 10 s hook timeout (3 of 5 full-suite runs during this session; a bare
  `TRUNCATE ... CASCADE` measures 1.7 s on an idle database). The file passes 12/12
  standalone, the suite passes 61/61 on a clean run, and the integration did not change
  offline-sync code: Phase 7 only added three tables to the truncate list. The timeout was
  left unchanged rather than loosened, because loosening a gate is not an integration fix.

## 20. Reproducibility, final state and sign-off

```powershell
# from BloomCore-One-susu-phases-1-7-integration
npm ci
npm run db:generate
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
# fresh PostgreSQL 16; test:pg regenerates the Prisma client for PostgreSQL
$env:PG_DATABASE_URL="postgresql://postgres:<local-only>@127.0.0.1:55499/maacash_test_int_fresh"
$env:PG_TEST_CONFIRM="DISPOSABLE_TEST_DATABASE"
npm run test:pg
npm run db:generate   # restore the SQLite client afterwards
```

Run the browser suite through `npm run test:e2e`, not `npx playwright test`: the npm script
first runs `scripts/prepare-e2e.mjs`, which creates and seeds the disposable E2E database.
Invoking Playwright directly against an unseeded database produces timeouts that look like
product failures.

`npm run test:pg` regenerates the Prisma client against `schema-pg.prisma`; run
`npm run db:generate` again before building for SQLite, otherwise the build bundles a
PostgreSQL client. The same caveat applies to running `test:pg` while the SQLite suite is
running: don't.

- Final branch: `feat/susu-enterprise-phases-1-7-integration`
- Final commit: the branch tip, i.e. the commit that contains this report
  (`git log -1 --format=%H feat/susu-enterprise-phases-1-7-integration`). The four merge
  commits below it are `2c28842` (P4), `ef2f11b` (P5), `e1a5ade` (P7), `2839ab7` (P6).
- Tracked tree: clean; source branches/worktrees untouched; main worktree untouched.
- Diff against the baseline: **82 files, about +28.4k / −466** (the report's own lines are
  part of that total).
- Classification: **INTEGRATION COMPLETE** (local only). Deployment remains an explicit
  owner decision outside this task.