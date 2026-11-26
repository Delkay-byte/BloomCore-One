# MaaCash test data and environment policy

**Status:** read-only audit. No environment variable, database, secret or configuration was
changed. This document records the controls already present and the rules that must be kept.

Evidence base: `scripts/test-database-paths.cjs`, `scripts/pg-safety.mjs`,
`scripts/prepare-e2e.mjs`, `scripts/prepare-pg-db.mjs`, `scripts/prepare-unit-db.mjs`,
`scripts/e2e-env.cjs`, `vitest.config.ts`, `vitest.pg.config.ts`, `playwright.config.ts`,
`.github/workflows/ci.yml`, `docs/SECURITY_AND_TEST_REPORT.md`.

---

## 1. Rule 1 — isolated disposable databases only

### SQLite

`scripts/test-database-paths.cjs` resolves one absolute location per database and shares the
helper between preparation scripts, Vitest config and Playwright config. This prevents the
preparation/runtime path mismatch that previously caused clean runs to hit a stale database.

| Database | Default path | Used by |
| --- | --- | --- |
| Unit + integration | `tests/test.db` | `vitest.config.ts` via `unitDatabase()`; `npm test` (`pretest` prepares it) |
| Browser | `tests/e2e.db` | `playwright.config.ts`, `scripts/prepare-e2e.mjs`, `scripts/seed-e2e.ts` |

Guards observed in `assertDisposableDatabase`:

- positive allow-list of basenames: `e2e.db`, `maacash-e2e.db`, `test.db`;
- protected names refused: `dev.db`, `demo.db`, `demo-verify.db`, `prod.db`, `production.db`,
  `neondb.db`, `maacash-roadmap-dev.db`;
- path must be inside `tests/` or the OS temporary directory;
- `E2E_DB_PATH` override still passes the same guard — it cannot point at a dev/production file;
- deletion in `scripts/prepare-e2e.mjs` retries on Windows `EBUSY`/`EPERM` and fails with an
  actionable message rather than a raw OS error.

### PostgreSQL

`scripts/pg-safety.mjs` fails closed before any destructive test:

- requires `PG_DATABASE_URL`, never `DATABASE_URL`;
- requires explicit `PG_TEST_CONFIRM = DISPOSABLE_TEST_DATABASE`;
- refuses `NODE_ENV=production`, Render service environments, and Neon/Render hostnames;
- requires a loopback host and a database name matching `maacash_test*`;
- prints only host and database name, never the full connection string.

`scripts/prepare-pg-db.mjs` applies the real migration chain to that guarded target.
`vitest.pg.config.ts` uses `PG_DATABASE_URL` and runs the `tests/pg-*.test.ts` set with
`fileParallelism: false`, `maxWorkers: 1`. PG test files truncate business tables in `beforeEach`;
this is why the guard is mandatory.

### Test execution shape

- `vitest.config.ts`: node environment, one worker, sequential files, shared SQLite file,
  `NODE_ENV=test`, test-only JWT secret and legacy-cookie migration bridge.
- `playwright.config.ts`: Chromium + Pixel 7, `workers: 1`, `fullyParallel: false`, `retries: 1`
  under `CI`, trace/screenshot/video retained on failure, 90 s test timeout.
- CI `sqlite-verify` uses a disposable SQLite URL; `postgres-verify` uses a disposable
  `postgres:16-alpine` service. No production target appears in either job.

---

## 2. Rule 2 — no live provider calls, no real customer data

`scripts/e2e-env.cjs` constructs the browser server environment and blanks every external
provider credential, including payment, messaging, email, AI, OIDC and internal tokens. It also
sets `NODE_ENV=production` for realistic rendering while keeping the database disposable and
the session/security values test-only. This prevents a developer's local `.env` from changing
"checkout configured" or "delivery enabled" state.

Rules:

1. All tenants, users, customers, accounts, transactions and case records in tests are
   synthetic, created by `tests/setup.ts` or `scripts/seed-e2e.ts`.
2. Use `@test.local`, `test.invalid` and synthetic Ghana phone formats for fixtures — never a
   real customer phone number, statement or document.
3. Never enter a PIN, OTP, password or token into a capture field; the product has no such
   field and tests must not introduce one (`docs/testing/COUNTER-COMPANION-ANDROID-ACCEPTANCE.md` §3).
4. Provider integrations are either mocked or disabled. Test-only values are never copied into
   a committed file, ticket or report.
5. The one recorded account-recovery verification used a synthetic account and an owner-approved
   test mailbox with production Resend configuration (`docs/SECURITY_AND_TEST_REPORT.md` §4).
   Provider acceptance was observed; inbox delivery was not independently confirmed. Do not
   repeat this against a customer account.
6. The shared risk intelligence salt is local-only and Git-ignored; it was generated randomly
   and never printed (`docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §7). Missing salt is a hard
   failure, not a default to copy from tests into production.
7. Browser storage holds no passwords, OTPs, PINs or tokens. Tab session material is scoped per
   tab through the service worker; tests must not broaden this to shared storage.

---

## 3. Rule 3 — environment classification before any run

| Class | Allowed use | Not allowed |
| --- | --- | --- |
| Local disposable SQLite (`tests/test.db`, `tests/e2e.db`) | Unit, integration, browser suites; migration rehearsal | Storing real customer data; pointing at dev/demo/prod files |
| Local disposable PostgreSQL (`maacash_test*` loopback) | PG integration and concurrency tests | Neon/Render host, shared staging, production |
| CI disposable services | Automated gates on PR/push | Live provider credentials; destructive targets |
| Isolated production-equivalent staging (not yet provisioned) | Future authenticated load, active DAST, owner-approved scenarios | Real customer records; unapproved stress/volumetric work |
| Production | Read-only health checks already recorded in reports | Any load, stress, destructive scan, mutation, or credential change without separate written owner approval |

No isolated production-equivalent environment exists today
(`docs/PERFORMANCE_AND_LOAD_TEST_REPORT.md` §2). Local SQLite is not a valid proxy for
PostgreSQL connection limits, lock contention or network latency.

---

## 4. Rule 4 — data lifecycle inside a test

1. `npm test` runs `pretest` → `node scripts/prepare-unit-db.mjs`; `npm run test:e2e` runs
   `node scripts/prepare-e2e.mjs && playwright test`. Do not bypass preparation: a stale file
   produces duplicate-tenant and stale-fixture failures.
2. `tests/setup.ts` cleans tables in foreign-key-safe order via one transaction and seeds a
   deterministic Zeli availability row. Every test creates its own tenant with a random code.
3. Files run sequentially because they share one database. Do not re-enable parallel workers to
   "speed up" a run without first separating the databases; the single-worker setting is a
   documented stability measure, not a weakened test.
4. Drafts and offline queues use fake IndexedDB in unit tests (`fake-indexeddb` in devDependencies)
   and a disposable browser profile in Playwright. Verify a draft cannot be restored into a
   different tenant or account.
5. After a browser run, `test-results/` holds traces, screenshots and videos. Treat them as
   potentially sensitive: sanitise or delete before sharing. Do not commit raw captures containing
   customer-like data.
6. Reports must contain counts, paths and dispositions, not raw HTTP bodies, stack traces or
   provider error text.

---

## 5. Rule 5 — prefill and user-input safeguards stay intact

BloomCore engineering standard requires forms to prefill from existing data, use standard
autofill attributes, remain editable, never invent critical data, and never expose another
tenant's or branch's data. Relevant existing coverage:

- `tests/ux-behaviours.test.ts` — skeleton loading (`aria-busy`) and autofill/financial safeguards;
- `tests/drafts.test.ts` — form drafts and legacy plaintext draft migration;
- `tests/offline-momo-drafts.test.ts` — another worker, another branch and stale-day refusals;
- `tests/counter-companion.test.ts` — masked number, read-back, PIN-like input refusal.

When adding synthetic fixtures for prefill tests, use the caller's own tenant and assignment.
A test that deliberately crosses a boundary must assert denial, not merely avoid the setup.

---

## 6. Evidence and reporting rules

| Requirement | Rule |
| --- | --- |
| Record exact command | Always quote the command as run, including flags and environment class |
| Record tree state | Include branch and HEAD; note if the tree is dirty — historical results may not apply |
| Record environment | Database class, host/database name only for PG, synthetic dataset counts |
| Secrets | Never print, paste or commit secret values, full connection strings or raw tokens |
| Customer data | Never publish real names, phones, statements or evidence files |
| Failure evidence | Reference trace/screenshot path; sanitise before sharing outside the owner group |
| Pass claims | State pass only with a recorded run; E2E is not a pass while five failures remain |
| Scope limits | State what was not run (for example PG in the latest security report, live providers, physical device) |

---

## 7. Gaps and owner actions

1. No verified database snapshot or restore point exists from the audit host
   (`docs/SECURITY_AND_TEST_REPORT.md` §7). A restore rehearsal on a disposable copy is owed.
2. No isolated production-equivalent environment; authenticated load and active DAST are blocked
   on owner-funded infrastructure and written scope.
3. Six live custom-domain browser checks are opt-in and need a deployed origin
   (`docs/testing/E2E-SKIPPED-TESTS-REVIEW.md` §2.1).
4. Physical-device PWA checks, SIM/network behaviour and IndexedDB survival across a browser
   restart remain owner manual tests (`docs/testing/COUNTER-COMPANION-ANDROID-ACCEPTANCE.md` §6).
5. Historical logs (`.tmp-*.log`) are untracked local evidence. Promote a sanitised summary to a
   committed report before relying on it for a release decision, and never commit raw logs that
   may contain customer-like fixture data or provider text.

No environment was modified by this audit. Any change to production settings, credentials or
CI gates requires explicit owner approval.
