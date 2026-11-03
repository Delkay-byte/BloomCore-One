# Zeli — Test Report

**Date:** 3 November 2026.
**Environment:** Windows 11, Node 22.23.2 (CI parity), SQLite test database,
PostgreSQL 16 container, Chromium via Playwright.

## Summary

| Check | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm run typecheck` |
| CI | PASS | GitHub Actions run on PR #3 head |
| Lint | PASS (0 errors, 78 warnings) | `npm run lint` |
| Unit/integration tests | PASS — 37 files, 387 tests (CI) | `npm test` |
| PostgreSQL tests | PASS — 6 files, 31 tests | `vitest --config vitest.pg.config.ts` |
| Browser E2E | PASS — 16 tests | `playwright test` |
| Production build | PASS | `npm run build` |
| Dependency audit | 0 critical, 6 high, 19 moderate (dev toolchain) | `npm audit` |
| Migration verification | PASS | `prisma migrate deploy` against PostgreSQL 16 |
| Analytics reconciliation | PASS | `tests/zeli-analytics.test.ts` |
| Provider isolation | PASS | `tests/zeli-privacy-gateway.test.ts` |

## New/extended automated tests

### `tests/zeli-analytics.test.ts` (7)
- Totals reconcile with direct database aggregates.
- Reversed contributions and withdrawals are excluded.
- `netCashFlow` equals contributions + cash income − withdrawals − expenses.
- Daily series sums to period totals.
- Tenant B data never enters Tenant A results.
- Location filters validate against the tenant.
- Refresh is idempotent under repeat.
- Insights carry period, metric, calculation, source, freshness and limitations.
- Invalid and future periods are rejected.
- Entitlement matrix: role, missing, expired, suspended, revoked.

### `tests/zeli-analytics-access.test.ts` (7)
- Entitled tenant admin allowed.
- Missing/expired/suspended/revoked denied at the server guard.
- Worker denied.
- Missing entitlement redirects an action to the upgrade screen.
- Another tenant's location filter rejected.
- Tenant user cannot call platform entitlement management.
- Platform grant/suspend/revoke writes history and platform audit with reasons.

### `tests/zeli-privacy-gateway.test.ts` (11)
- Valid aggregate payload accepted by the schema evaluator.
- Unknown top-level/nested fields rejected.
- Sensitive fields, identifiers, free text and exact timestamps rejected.
- Raw input fails closed.
- Small groups suppressed; minimum cannot go below 5.
- No network request while disabled, even with provider/approval/key.
- Gateway audit contains no values.
- DeepSeek adapter inert; credential value never exposed.
- Chat stays providerless with environment flags set.

### `tests/zeli-intents.test.ts` (7)
- Supported intents and periods.
- Unsupported request returns a limitation.
- Non-admin roles are limited to their questions.
- Comparison answers are server-computed.
- Metric definition answer is deterministic.
- Customer role cannot obtain tenant analytics.

### `tests/financial-corrections.test.ts` (extended)
- Correction read model returns revision history to the owning admin.
- Another tenant's admin gets no record.
- No session is redirected.
- Immutable snapshot retains the original figures.

### `tests/pg-zeli-analytics.test.ts` (2)
- Concurrent refresh idempotency and PostgreSQL aggregate reconciliation.
- Entitlement lifecycle persists and evaluates in PostgreSQL.

## Browser E2E (`e2e/`)

16 tests across desktop and mobile Chromium:

- provider-disabled status and supported answer;
- unsupported-question limitation;
- create/rename/delete conversation;
- tenant administrator blocked from `/platform/zeli`;
- Tenant B denied analytics and navigation item;
- analytics KPIs, charts, explanation;
- period and branch filters;
- CSV export;
- refresh;
- no Tenant B data in export;
- platform provider status and no DeepSeek toggle;
- platform grant/suspend/revoke with mandatory reason;
- platform page exposes no tenant financial records;
- correction screen original/proposed values, reason, confirmation, revision;
- cross-tenant correction denial;
- mobile Zeli and analytics layout.

Run:

```bash
npm run test:e2e
```

The suite prepares `tests/e2e.db` with two synthetic tenants and starts the
production build on port 3100. `E2E_BASE_URL` can point at hosted staging; this
was **not** run against production.

## PostgreSQL

```bash
DATABASE_URL=... DIRECT_URL=... npx prisma migrate deploy --schema prisma/schema-pg.prisma
DATABASE_URL=... PG_DATABASE_URL=... npx vitest run --config vitest.pg.config.ts
```

All 9 migrations applied, including
`20261103_zeli_business_intelligence`. 31 PG tests passed, including concurrent
daily-account correction and remittance reversal.

## CI evidence

- PR #1: `Lint, typecheck, test, build` pass.
- PR #2: `Lint, typecheck, test, build` pass after retarget to `main`.
- PR #3: `Lint, typecheck, test, build` pass (5m04s).

Local full-suite runs occasionally hit environment timeouts in
`customer-portal` and `password-lockout-live` on a loaded Windows host; the
same files pass when re-run alone, and CI is green. No assertion failure was
observed in the Zeli suites.

## Known test limitations

- Browser tests use synthetic SQLite fixtures, not hosted staging.
- The E2E suite does not exercise a real external provider (disabled by design).
- Local model evaluation was documentation-only; no inference host was
  provisioned.
- Dependency advisories remain in dev tooling (Vitest, ESLint/TypeScript
  resolver, Prisma CLI transitive). No critical advisory; no runtime dependency
  was added beyond Playwright (dev only).
