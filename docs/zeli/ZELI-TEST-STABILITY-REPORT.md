# Zeli — Test Stability Report

**Date:** 4 November 2026.
**Environment:** Windows 11, Node 22.23.2, SQLite test database.

## Original flakes

| Test | Symptom | Root cause |
|---|---|---|
| `customer-portal.test.ts` → “finds staff by uppercase AMA…” | `beforeEach` hook timeout at 10s | full-schema cleanup plus fixture setup under load |
| `password-lockout-live.test.ts` → progressive cooldown | test timeout at 5s | five real bcrypt verifications at cost 12 |
| `password-lockout-live.test.ts` → correct password after cooldown | test timeout at 5s | same bcrypt cost, plus throttle cleanup |

These were timing/resource failures, not assertion failures.

## Fixes

1. Test-only fixture password hashes now use bcrypt cost 4. Production
   `hashPassword` remains cost 12.
2. `cleanDatabase` runs all bounded deletes in one transaction instead of ~40
   round trips.
3. The two genuinely crypto/DB-heavy suites receive a targeted 30-second budget.
   No global timeout increase; no skipped tests; no change to parallelism.
4. Test data remains unique; no fixed sleeps were added.

## Verification

Five consecutive full-suite runs:

| Run | Result | Duration |
|---|---|---|
| 1 | 424/424 passed | 107.39s |
| 2 | 424/424 passed | 85.42s |
| 3 | 424/424 passed | 101.62s |
| 4 | 424/424 passed | 95.85s |
| 5 | 424/424 passed | 93.47s |

An earlier five-run validation before the commerce/provider feature also passed
387/387 each time. Post-feature suite: 42 files, 424 tests passed.

PostgreSQL suite is run separately (`vitest.pg.config.ts`), not in parallel with
SQLite tests. Browser tests remain a separate Playwright run.

## Remaining risks

- CI and local timing can still differ on very slow hosts; no flaky test was
  observed in five runs.
- Playwright uses one worker because it shares the synthetic database.
- No test is skipped without a documented reason.
