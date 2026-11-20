# MaaCash MoMAG / MMAAG readiness — implementation progress

Branch: `feat/maacash-momag-readiness`
Base commit at the start of this programme: `dbc61f8e245cb1eae0093b2a5a02bef6fbd1bcf7`
Production reference `92d6d974…` verified as an ancestor of that commit.
Audit of record: [`docs/audits/maacash-12-feature-completion-gap-audit.md`](../audits/maacash-12-feature-completion-gap-audit.md)

Everything in this document was produced under the local-only restriction: no
push, fetch, pull, PR, merge, deploy, remote CI run, production database access,
production migration, production secret change, live financial transaction, live
AI approval or customer-data access. No security control was relaxed to make a
test pass.

Status vocabulary: **DONE** (implemented, tested, verified) · **PARTIAL**
(implemented in one layer, named gap remains) · **MISSING** (not started) ·
**BLOCKED_EXTERNAL** (cannot be completed without third-party approval or
credentials) · **PENDING_ASSOCIATION_DECISION** (needs MoMAG/MMAAG policy input).

---

## 1. Verification baseline

| Check | Command | Result |
| --- | --- | --- |
| SQLite provisioning rehearsals (4) | `node scripts/verify-sqlite-migrations.mjs` | pass |
| PostgreSQL migration rehearsals (3) | `node scripts/verify-pg-migrations.mjs` | pass — 90 tables, no drift |
| PostgreSQL integration suite | `npm run test:pg` | 10 files / 44 tests pass |
| Unit + integration suite (SQLite) | `npm test` | 131 files / 1415 tests pass |
| TypeScript | `npx tsc --noEmit` | clean |
| ESLint | `npx eslint .` | 0 errors, 97 pre-existing warnings |
| SQLite schema | `npx prisma validate --schema prisma/schema.prisma` | valid |
| PostgreSQL schema | `npx prisma validate --schema prisma/schema-pg.prisma` | valid |
| Production build | `npm run build` | succeeds |
| Browser acceptance, production build | `node scripts/verify-e2e.mjs` | chromium + mobile-chromium, all tests pass |

All of the above are reproducible from a clean checkout with a disposable
PostgreSQL cluster; see §6 for the exact environment.

---

## 2. Phase 0 — Release and test safety (complete)

### A0.1 PostgreSQL migration compatibility — DONE

Two migrations carried SQLite-only syntax while `migration_lock.toml` declares
`postgresql`, so a fresh PostgreSQL deployment failed at
`20261205_association_foundation` with `P3018 / 42704: type "datetime" does not
exist`. `DATETIME` → `TIMESTAMP(3)` and bare `DECIMAL` → `DECIMAL(65,30)` in:

- `prisma/migrations/20261205_association_foundation/migration.sql`
- `prisma/migrations/20261207_customer_messaging/migration.sql`

The whole chain now applies to an empty database, `migrate status` reports up to
date, and `migrate diff` against `prisma/schema-pg.prisma` is empty.

`scripts/verify-pg-migrations.mjs` keeps this honest with three rehearsals on
throwaway databases:

1. **Fresh chain** — every migration applies, no drift, required tables present.
2. **Existing-data upgrade** — chain applied up to a cut-off, representative
   business/customer/location/user/daily-account rows inserted, remaining
   migrations applied; every value preserved byte-for-byte and a second deploy is
   a no-op.
3. **Recovery and idempotency** — an interrupted `_prisma_migrations` record is
   refused, cleared with `migrate resolve --rolled-back`, then re-applied.

### A0.2 E2E database path — DONE

`scripts/prepare-e2e.mjs` deleted `<repo>/tests/e2e.db` while the runtime
resolved `file:../tests/e2e.db` to a file outside the repository — several stale
copies existed. Preparation and runtime now share
`scripts/test-database-paths.cjs`:

- `assertDisposableDatabase` — positive allowlist (`e2e.db`, `maacash-e2e.db`,
  `test.db`), refuses `dev.db`, `demo.db`, `prod.db`, `production.db`,
  `neondb.db`, `maacash-roadmap-dev.db`, requires `.db` and a path under
  `<repo>/tests` or the OS temp directory.
- `resolveE2eDatabasePath` / `e2eDatabase` / `unitDatabase` / `sqliteUrlFor`.

`playwright.config.ts` and `vitest.config.ts` import the same resolver, so the
two paths cannot drift again.

### A0.3 Stale E2E assertions — DONE

| Spec | Why it was stale | Repair |
| --- | --- | --- |
| `correction.spec.ts` | correction now requires step-up | fills the `#reauth-password` field in the dialog; step-up itself unchanged |
| `momo-workflow.spec.ts` | bounded best-effort `/api/auth/me` reads exist by design; shortage submit needs an explanation | blocks the endpoint and proves server-resolved first paint, then asserts a bounded count; fills `#reconciliation-note` and the opening reason |
| `role-workflows.spec.ts` | banner + toast duplicate the same status; statement label is “Contribution”; sign-out is a dialog | `.first()` on status, corrected label, `openSignOutMenu()` helper |
| `maacash-landing.spec.ts` | sign-in path comes from `BUSINESS_LOGIN_PATH` | widened href assertion, documented |
| `maacash-dual-role-switch.spec.ts` | offline panel copy changed | asserts the current copy |
| `platform.spec.ts` | `useConfirm` renders `role="alertdialog"` | `alertdialog` in all four assertions |
| `maacash-improvements-evidence.spec.ts` | delete flow is an in-app modal | `exact` button name, `alertdialog`, `Delete` / `Keep conversation` |
| `maacash-draft-persistence.spec.ts` | the seeded day needs an opening explanation, and the local autosave indicator was being accepted as proof of a server write | fills the explanation; asserts the server confirmation (`Draft saved successfully. Last saved at …`) and never the device-local indicator; the failure case now uses a real server rejection and proves the values survive and the retry succeeds |

The master-switch spec also restores the platform-wide Zeli switch in
`afterAll` (via `e2e/zeli-availability-restore.ts`), so one failure can no longer
leave every tenant without Zeli for the rest of the run.

Result: `node scripts/verify-e2e.mjs` → **89 passed, 0 failed** across the
`chromium` and `mobile-chromium` projects.

### A0.4 PG tests inside the release gate — DONE

- `scripts/pg-safety.mjs` requires `PG_DATABASE_URL` (never `DATABASE_URL`),
  `PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`, a loopback host, a database name
  matching `maacash_test*`, and refuses Neon/Render hosts, `NODE_ENV=production`
  and Render environment variables.
- `scripts/prepare-pg-db.mjs` applies the migration chain to that database.
- `scripts/ensure-prisma-client.mjs` regenerates the Prisma client when the
  generated datasource provider (sqlite/postgresql) does not match the run,
  which removes the `Driver Adapter … is not compatible with the provider`
  failure mode that made mixing the two suites unreliable.
- `npm run test:release` → `scripts/verify-release.mjs`: schema, sqlite
  rehearsals, pg rehearsals, unit suite, pg suite, typecheck, lint, production
  build, browser acceptance (`--skip-e2e` / `--only` supported).

### Phase 0 incidental repairs

- `eslint.config.mjs` registered `react-hooks/set-state-in-effect` without the
  plugin in the same flat-config object, so ESLint 9 refused to run at all. The
  plugin is now carried over from `eslint-config-next`, and `**/*.cjs` is allowed
  to use `require()` (Playwright loads those helpers directly).
- `prefer-const` and unused-import defects introduced during this work fixed.

---

## 3. Requirement register — Priority A

**5. Provider statement CSV importer — DONE.**
`src/lib/provider-statement.ts` parses CSV with BOM/quote/CRLF handling, detects
header synonyms, converts amounts to integer pesewa and rejects three-decimal
values, accepts only explicit date formats, derives direction, fingerprints each
row with SHA-256 and matches reference-first with a 15-minute amount-and-time
window that resolves ambiguity to `null`. `src/lib/actions/provider-statement.actions.ts`
imports under a Momo administrator, refuses a duplicate file, stores every row
with its own verdict, offers manual match/unmatch that can never set
`provider_confirmed`, and audits each import with `financialMutation: false`.
The `/admin/reconciliation` screen imports a file, shows per-line verdicts with
totals, and lets an operator pair a line with an internal record only after
seeing the candidates. Tests: `tests/provider-statement.test.ts` (14) plus the
browser flow in `e2e/maacash-reconciliation.spec.ts` (auto match, duplicate file
refusal, manual match, manual unmatch, and the statement that the internal record
stays unconfirmed).

**6. Branch liquidity snapshot — DONE.**
`BranchLiquiditySnapshot` / `BranchLiquidityLine` record the declared opening and
the counted close for cash and each network float. The server derives the
transfer adjustment from the transfer records for that day, so a browser can
never submit its own adjustment; a short line always needs an explanation even
when the net is balanced; reviewed snapshots are final. `/admin/liquidity`
renders the board per branch with declared, transfer-adjusted, expected, counted
and variance columns, an explanation field, save/submit/review actions, a
review note, and totals per branch and across branches. It also handles the
race where a slow board refresh would otherwise overwrite figures the operator
had just typed. Tests: `tests/reconciliation-liquidity.test.ts` (19) and the
browser flow that is refused without an explanation and then accepted with one.

**7. Unified reconciliation exception case — DONE.**
`ReconciliationExceptionCase` / `…Link` / `…Event` cover provider statements,
branch liquidity, transfers, remittances, shifts and daily closes with a case
number (`REC-YYYY-NNNN`), category, severity, owner, due date, evidence,
resolution and an append-only timeline. Transitions and resolution reasons are
enforced server-side; duplicate record links are refused; closing a case never
touches a financial record. `/admin/reconciliation/exceptions` provides the
queue with status filters and ageing, owner assignment, notes, evidence, record
linking, the resolution panel and the timeline. A reviewed short liquidity
snapshot opens a case automatically with the snapshot linked, and the browser
test follows that case from the review button to the queue.

**8. Partial transfer settlement — DONE.**
`settlePartialTransfer` accepts a sanctioned partial receipt only from
`variance_investigation` or `disputed`, refuses an amount at or above what was
dispatched, and either creates a draft follow-up transfer for the remainder or
writes the shortfall back, with step-up only when the tenant requires it for
approvals. The transfer detail screen shows the settlement panel, asks for the
password again at the server's high-value threshold, and displays the settled
amount, outstanding balance, settler and a link to the follow-up (or back to the
original from the follow-up). Tests cover follow-up versus write-back, double
settlement and worker denial.

**9. Branch asset/close reconciliation view — DONE.**
The liquidity board is that view: declared, transfer-adjusted and counted
figures per pocket with the variance, plus the daily close difference for the
branch when a daily account exists for the same day.

**10. Tenant shift policy — DONE.**
`TenantOperationalPolicy` holds the business's own rule, written only by an
administrator through `/admin/policy` and audited with the previous and new
values. When shifts are required, `submitDailyAccount` refuses with a plain
explanation unless the same employee has a **closed** shift for the same branch
and business day; another employee's closed shift does not satisfy it.
`tests/employee-accountability.test.ts` covers the refusal, the acceptance, the
wrong-employee case and the administrator-only write.

**11. Shift revision/correction — DONE.**
`ShiftRevision` records the figures before and after, the fields changed, the
reason, the requester and the approver. `correctClosedShift` works only on a
closed shift with no open handover variance, refuses an unchanged count, requires
a reason of at least ten characters and fresh proof of identity, and keeps the
shift closed. The shift detail screen shows the correction panel and the revision
history. Tests cover the successful correction, the preserved original, the audit
event and the three refusals.

**12. Shared-device actor proof — DONE.**
When the policy is on, submitting the outgoing shift count or the daily close
requires the actor's own password, presented as a single-use step-up grant bound
to that shift or daily account (`finance.shift_count.submit`,
`finance.daily_close.submit`). The worker screens ask for the password only after
the server refuses, so the browser never decides the rule. Tests prove the
refusal, the acceptance with a bound grant, and that replaying the same grant
against another record is refused.

**13–18. Offline operations — MISSING.**
**19–24. Messaging — MISSING.**
**25–30. Customer portal and disputes — MISSING.**
**31–36. Association foundation — MISSING** (item 36 is
PENDING_ASSOCIATION_DECISION).

**37–42. Training and certification — MISSING.**
**43–48. Sponsored subscriptions — MISSING.**
**49–53. Anomaly investigation — MISSING.**
**54–57. Business intelligence — MISSING.**

### Phase 1 schema and migration

Both Prisma schemas carry the new models and validate
(`ProviderStatementImport`, `ProviderStatementRow`, `BranchLiquiditySnapshot`,
`BranchLiquidityLine`, `ReconciliationExceptionCase`, `…Link`, `…Event`, plus the
`BranchTransfer` settlement fields and follow-up relation).
`prisma/migrations/20261209_phase1_reconciliation_foundation/migration.sql` and
`prisma/migrations/20261210_employee_accountability/migration.sql`, generated
with `scripts/make-pg-migration.mjs` (local host only, throwaway database,
refuses non-loopback targets), keep PostgreSQL deployments, which use
migrations, in step with SQLite, which is provisioned with `prisma db push`.

Label constants used by both the server and the browser live in
`src/lib/provider-statement-labels.ts`, because a client component that imported
the parsing module directly would pull `node:crypto` into the browser bundle.

---

## 4. Zeli AI explanation and investigation layer — Priority C

**C0 prerequisites — MISSING.**
**C1 implementation — MISSING.**
**C2 security tests — MISSING.**
**C3 approval — remains not granted.**

Provider gates are unchanged and still off: `PRODUCTION_PROVIDER_APPROVED=false`,
`PRODUCTION_CONVERSATION_APPROVED=false`. No AI provider credential is present in
the browser or the E2E environment (`scripts/e2e-env.cjs` blanks
`PAYSTACK_*`, `DEEPSEEK_*`, `ZELI_TEAM_TESTING_*`, `WHATSAPP_*`, `RESEND_API_KEY`
and `PLATFORM_OIDC_*`, and forces `PAYSTACK_ENABLED=false`,
`PLATFORM_OIDC_ENABLED=false`).

---

## 5. Association-dependent decisions

Still awaiting MoMAG/MMAAG input; no code has been written that assumes an
answer:

- which association body owns membership and whether one business may belong to
  more than one association;
- zone/chapter hierarchy depth and naming;
- who may see member financial data, and under what consent wording;
- sponsorship funding ownership, limits and accounting treatment;
- the association pilot dashboard’s contents and audience.

---

## 6. Local environment used for verification

- Disposable PostgreSQL 18 cluster on port 55441
  (`C:/Users/SAVIOUR/AppData/Local/Temp/maacash-pg2`, `initdb --auth=trust`,
  loopback only). No service database, no production project and no remote host
  was contacted.
- `PG_DATABASE_URL=postgresql://postgres@127.0.0.1:55441/maacash_test_suite`,
  `PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`.
- Browser suite runs a production build against `tests/e2e.db` on port 3101.

---

## 7. Next work, in order

1. A3 offline operations.
3. A4 messaging, A5 customer portal and disputes.
4. A6 association foundation on a generic model, then A7/A8.
5. A9 anomaly investigation, which is also the prerequisite for C0–C2.
6. A10 BI completion.
7. Final release gate: full suites, production-build browser acceptance, security
   and tenant review, then — and only then — discuss push/PR/deploy.
