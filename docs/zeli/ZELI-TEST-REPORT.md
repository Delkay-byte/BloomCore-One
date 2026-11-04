# Zeli — Test Report

**Date:** 4 November 2026.
**Environment:** Windows 11, Node 22.23.2 (CI parity), SQLite test database,
PostgreSQL 16.15 and PostgreSQL 18.6 containers, Chromium via Playwright.

## Summary

| Check | Result | Evidence |
|---|---|---|
| Typecheck | PASS (0 errors) | `npx tsc --noEmit` |
| Lint | PASS (0 errors, 83 warnings) | `npm run lint` |
| Unit/integration tests | PASS — 49 files, 493 tests | `npm test` |
| PostgreSQL tests (16.15) | PASS — 6 files, 32 tests | `vitest --config vitest.pg.config.ts` |
| PostgreSQL tests (18.6) | PASS — 6 files, 32 tests | `vitest --config vitest.pg.config.ts` |
| Browser E2E | PASS — 20 tests | `npm run test:e2e` |
| Production build | PASS | `npm run build` |
| Dependency audit | 3 high, all in the Prisma CLI chain (dev tooling) | `npm audit --omit=dev` |
| Migration verification | PASS — 21 migrations, empty `migrate diff` | `prisma migrate deploy` on PostgreSQL 16 and 18 |
| Analytics reconciliation | PASS | `tests/zeli-analytics.test.ts` |
| Provider isolation | PASS | `tests/zeli-privacy-gateway.test.ts` |

CI runs on the pushed PR head and is reported on the pull request. The table
above records local execution on 4 November 2026; staging results are recorded
in `ZELI-STAGING-DEPLOYMENT.md`.

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

## Commerce, provider and advanced-intelligence suites (new)

- `zeli-billing.test.ts` (8): checkout price from DB, unavailable package,
  forged webhook, duplicate webhook, amount/currency mismatch, refund suspension,
  server-verified callback, cancellation until period end.
- `zeli-provider-control.test.ts` (16): default/emergency/synthetic/approved
  policy matrix, gateway package rules, small groups, synthetic/real confusion,
  DeepSeek transport, output validation, normal chat never sent in synthetic mode.
- `zeli-provider-actions.test.ts` (14): platform session required, production
  mode locked, synthetic environment permission, emergency stop override,
  latched stop across mode changes and restart, clear action authorization,
  reason, refusal and immutable audit.
- `zeli-chat-provider-header.test.ts` (8): server-derived external-AI status for
  every policy state, no key/approval/reference leakage, local Zeli unaffected.
- `zeli-expiry.test.ts` (7): expired entitlement, repeat-run idempotency,
  renewal racing expiry, missed execution, cancelled subscription, future
  entitlement untouched, manual non-expiring entitlement untouched.
- `zeli-trial.test.ts` (4): one audited trial with the configured duration,
  second trial refused, zero-day package refused, global switch blocks trial.
- `zeli-billing-lifecycle.test.ts` (25): early renewal extension, expired
  renewal boundary, replayed charge, callback + webhook dedupe, concurrent
  duplicate renewal, refund after renewal, checkout race, stale checkout
  replacement, duplicate settlement refund, refund failure exception, refund
  retry dedupe, non-charge event dedupe, forged signature, wrong amount, wrong
  currency, unknown reference, out-of-order refund, failed-event recovery,
  unsupported event, global switch, pending guard release, cancellation.
- `release-config.test.ts` (4): production MFA `enforce`, branch/health/deploy
  contract, staging manual isolation with TEST key contract, no hardcoded
  payment secret and `PRODUCTION_PROVIDER_APPROVED = false`.
- `zeli-commerce-actions.test.ts` (5): platform plan management, mandatory reason,
  invalid price/currency, no seeded price, tenant exclusion.
- `zeli-availability.test.ts` (6): missing row, immediate toggle, all roles,
  chat API 503, export 503, analytics action denial.
- `zeli-availability-actions.test.ts` (5): platform-only authorization,
  mandatory reason, previous/new audit, provider-control independence, Paystack
  webhook unaffected.
- `zeli-advanced-insights.test.ts` (3): dormant accounts, contribution
  consistency, reporting gaps, collector concentration, rich recommendations.

## Browser E2E (`e2e/`)

20 tests across desktop and mobile Chromium:

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
- mobile Zeli and analytics layout;
- owner-configured package creation;
- provider emergency stop;
- honest checkout-configuration state.

Run:

```bash
npm run test:e2e
```

The suite prepares `tests/e2e.db` with two synthetic tenants and starts the
production build on port 3100. `E2E_BASE_URL` can point at hosted staging; this
was **not** run against production.

## PostgreSQL

Both supported rehearsal versions were exercised on 4 November 2026.

```bash
DATABASE_URL=... DIRECT_URL=... npx prisma migrate deploy --schema prisma/schema-pg.prisma
DATABASE_URL=... PG_DATABASE_URL=... npx vitest run --config vitest.pg.config.ts
```

| Version | Migrations applied | PG suite | `migrate diff` |
|---|---|---|---|
| PostgreSQL 16.15 | 21/21 | 32/32 | empty |
| PostgreSQL 18.6 | 21/21 | 32/32 | empty |

The PostgreSQL 18 rehearsal also covered the upgrade path: the 20 pre-existing
migrations were applied to an empty database, representative tenant, plan,
subscription, entitlement and payment-event rows were inserted, then the new
`20261105_zeli_renewal_checkout_refund_expiry` migration was applied. Row counts
were identical before and after (`BusinessTenant` 1, `ZeliSubscription` 1,
`ZeliEntitlement` 1, `ZeliPaymentEvent` 1), the existing subscription defaulted
to `periodGranted = false`, and the new unique indexes and exception table were
created. Full details are in `ZELI-MIGRATION-REHEARSAL.md`.

No migration drops a table or column, deletes a row or rewrites existing data.

## Staging evidence

Staging is deployed manually from the approved candidate commit with
Auto-Deploy OFF. The exact commit SHA, migration status, acceptance results and
the Paystack TEST webhook evidence are recorded in
`ZELI-STAGING-DEPLOYMENT.md` after each verification run.

- Synthetic staging data only; no customer charge and no production data.
- Paystack TEST mode only; the LIVE key is never copied to staging.
- DeepSeek synthetic testing is off by default and was not re-enabled for this
  release.
- Independent penetration testing: **DEFERRED**; not performed.

## CI evidence

CI runs `Lint, typecheck, test, build` on the exact PR head. The pass/fail
result is attached to PR #4; the final head SHA is recorded in the release
closeout report.

Local full-suite runs occasionally hit environment timeouts in
`customer-portal` and `password-lockout-live` on a loaded Windows host; the
same files pass when re-run alone. The PostgreSQL 18 suite had one transient
10-second `beforeEach` hook timeout on its first cold run; an immediate re-run
passed 32/32. No timeout was raised and no assertion was weakened.

## Known test limitations

- Browser tests use synthetic SQLite fixtures, not hosted staging.
- The E2E suite does not exercise a real external provider (disabled by design).
- The expiry scheduler registration is type-checked; the in-process timer path
  is not unit-tested because `VITEST` deliberately skips it. The sweep itself is
  covered by `zeli-expiry.test.ts`.
- SQLite cannot deterministically interleave two writers inside one statement;
  race safety in the suite is behavioural plus database-level unique indexes and
  conditional updates verified on PostgreSQL.
- Dependency advisories remain in the Prisma CLI chain (`deepmerge-ts`), which
  is build-time tooling. No critical advisory; upgrading Prisma is a breaking
  change outside this release.
