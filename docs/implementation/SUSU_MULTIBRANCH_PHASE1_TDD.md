# Susu multi-branch Phase 1 — TDD evidence

Source plan: `docs/implementation/SUSU_MULTIBRANCH_PHASE0_PHASE1_PLAN.md`.

## User journeys
- As a tenant administrator I create branches and assign branch managers without changing global roles.
- As a branch manager I see only my branch's collectors, contributions and withdrawal requests.
- As a collector I record contributions against my own branch even if the client sends a different branch id.
- As an owner I keep historical branch attribution when a collector or branch changes.
- As a legacy one-office business I keep working without configuring a branch.

## RED → GREEN

| Task | RED evidence | GREEN evidence |
|---|---|---|
| Branch scope foundation | `DATABASE_URL=file:../tests/test.db npx vitest run tests/branch-scope.test.ts` → `Cannot find package '@/lib/branch'`, 1 file failed | same command after `npm run test:prepare` → 1 file / 10 tests passed |
| Server-side boundaries | `tests/branch-actions.test.ts` written before action wiring; cross-tenant and client-branch cases executed against the new helpers | `DATABASE_URL=file:../tests/test.db npx vitest run tests/branch-scope.test.ts tests/branch-actions.test.ts` → 2 files / 15 tests passed |
| PostgreSQL foundation | `prisma/migrations/20261227_susu_branch_foundation/migration.sql` applied to fresh `maacash_test_branch` | `npx prisma migrate deploy --config prisma.pg.config.ts` → all 71 migrations applied; `prisma migrate diff --exit-code` → "No difference detected"; `npm run test:pg` → 11 files / 46 tests passed |

## Guarantees proven by tests
- Company-wide admin scope stays `all`; branch manager scope is limited to persisted active memberships.
- Foreign tenant branch cannot be read, mutated, or used as a write target.
- Client-supplied branch id on contribution recording is ignored; the stored branch is the authenticated collector's branch.
- Scoped manager contribution history contains only held branches.
- Collector branch change does not rewrite historical contribution branch.
- Deactivated branch remains readable but cannot receive new writes.
- Legacy financial rows keep `branchId = NULL` (`LEGACY_UNASSIGNED`); no guessed backfill.
- Tenants with no configured branch keep legacy behaviour (branchless fallback), proven by the unchanged PostgreSQL suite.

## Test commands and results (exact)
- `npm run typecheck` → exit 0.
- `npm run lint` → 0 errors, 153 warnings.
- `npx prisma validate --schema prisma/schema.prisma` and `--schema prisma/schema-pg.prisma` → valid.
- Branch unit tests: 2 files, 15 tests passed.
- PostgreSQL suite: 11 files, 46 tests passed.
- Full unit suite, clean final run (`npx prisma generate --schema prisma/schema.prisma`, fresh `tests/test.db`, `DATABASE_URL=file:../tests/test.db npm test`): 167 files, 1888 tests passed, 0 failed (`.tmp-phase1-unit4.log`). Earlier runs showed a one-test timeout and an expired PostgreSQL generated client; both were environment issues, not product failures.

## Known gaps / deferred to Phase 2
- Atomic assignment transfer and assignment-history table.
- Branch attribution on `SusuAccount`/`Customer`; customer requests use newest attributed contribution or a single default branch.
- Full reversal-filtered management reports and high-value withdrawal threshold (pre-existing assessment gaps).
- Dedicated E2E coverage for branch admin UI; security is proven by direct server-action tests here.
