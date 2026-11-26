# MaaCash test strategy — evidence-based audit

**Status:** read-only audit. No application code, test, workflow or configuration was changed.
No test was executed by this audit. No push, merge, deploy, production scan or load test was
performed. No secret value or real customer data is reproduced here.

Repository: `BloomCore-One` (private), branch `feat/maacash-momag-readiness`.
Standard: BloomCore Secure Engineering & Real-World Quality Standard v1.0 (`BC-SEC-STD-001`),
plus `AGENTS.md` in the repository root.

Companion documents:

- [Real-world scenario catalogue](./REAL_WORLD_SCENARIO_CATALOGUE.md)
- [Performance and capacity plan](./PERFORMANCE_AND_CAPACITY_PLAN.md)
- [Security test plan](./SECURITY_TEST_PLAN.md)
- [Test data and environment policy](./TEST_DATA_AND_ENVIRONMENT_POLICY.md)

---

## 1. Evidence policy

Every result below is labelled:

| Label | Meaning |
| --- | --- |
| **VERIFIED (historical)** | A recorded run exists at the cited path. Not re-run by this audit. |
| **OBSERVED (static)** | Read directly from the named file in the current working tree. |
| **UNKNOWN** | No evidence found. Not claimed as pass or fail. |

The working tree was dirty at audit time (`git status --short` showed modified and untracked
source, test, config and documentation files). Historical results therefore describe the tree
at the time of the cited run, **not necessarily the current tree**. Re-run the exact commands
in §3 before relying on them for a release decision.

A green unit suite is not proof of security, capacity or production readiness. This document
states what was tested, what was not, and what remains unverified.

---

## 2. Verified commands from `package.json` (exact)

Read from `package.json`, lines 5–32. These are the project's declared commands; nothing here
adds a dependency or a new script.

| Script | Exact command | Purpose |
| --- | --- | --- |
| `dev` | `next dev --webpack` | Local development server |
| `pilot` | `node scripts/start-pilot.mjs` | Pilot startup |
| `prepare-deploy` | `node scripts/prepare-deploy.mjs` | Deployment preparation |
| `build` | `next build --webpack` | Production build |
| `start` | `next start` | Production-mode local server |
| `lint` | `eslint` | Static lint |
| `typecheck` | `tsc --noEmit` | TypeScript check |
| `test` | `vitest run` | SQLite unit + integration suite |
| `test:watch` | `vitest` | Watch mode |
| `test:coverage` | `vitest run --coverage` | Coverage run |
| `db:generate` | `prisma generate --schema=prisma/schema.prisma` | SQLite client |
| `db:push` | `prisma db push --schema=prisma/schema.prisma` | SQLite schema push |
| `db:migrate` | `prisma migrate dev --config prisma.pg.config.ts` | PostgreSQL dev migration |
| `db:migrate:prod` | `prisma migrate deploy --config prisma.pg.config.ts` | PostgreSQL deploy migration |
| `db:seed` | `tsx prisma/seed.ts` | Seed data |
| `db:studio` | `prisma studio` | Database browser |
| `zeli:expire` | `tsx scripts/zeli-expire.ts` | Zeli expiry sweep |
| `test:security` | `vitest run tests/security-hardening.test.ts tests/financial-security.test.ts tests/admin-recovery.test.ts tests/offline-isolation.test.ts tests/staff-status.test.ts tests/tenant-isolation.test.ts` | Named security subset |
| `test:e2e` | `node scripts/prepare-e2e.mjs && playwright test` | Browser suite, freshly prepared DB |
| `test:e2e:ui` | `node scripts/prepare-e2e.mjs && playwright test --ui` | Browser suite, UI mode |
| `db:generate:pg` | `prisma generate --schema=prisma/schema-pg.prisma` | PostgreSQL client |
| `db:migrate:status` | `prisma migrate status --config prisma.pg.config.ts` | Migration status |
| `test:prepare` | `node scripts/prepare-unit-db.mjs` | Prepare unit DB |
| `pretest` | `node scripts/prepare-unit-db.mjs` | Automatic `npm test` pre-step |
| `test:pg` | `node scripts/prepare-pg-db.mjs && vitest run --config vitest.pg.config.ts` | PostgreSQL integration suite |
| `test:release` | `node scripts/verify-release.mjs` | Full local release gate |

Additional local-only commands discovered outside `package.json`, used as evidence sources:

```
node scripts/verify-e2e.mjs --workers=2
node scripts/verify-release.mjs --skip-e2e
node scripts/verify-sqlite-migrations.mjs
node scripts/verify-pg-migrations.mjs
node scripts/check-accessibility.mjs http://localhost:3111
node scripts/load-test.mjs --url http://127.0.0.1:3100 --users 1000 --connections 100 --duration 60
```

`node scripts/load-test.mjs` is an HTTP probe only. See the capacity plan before running it;
it must never be pointed at production.

---

## 3. Verified run evidence (historical, not re-run)

| Check | Command | Recorded result | Evidence source |
| --- | --- | --- | --- |
| Unit + integration | `npx vitest run` / `npm test` | **1828 passed / 1828**, 157 files, 332.55s | `.tmp-final-test2.log`; `docs/SECURITY_AND_TEST_REPORT.md` §1 |
| TypeScript | `npm run typecheck` | pass | `docs/SECURITY_AND_TEST_REPORT.md` §1 |
| Lint | `npm run lint` | pass — **0 errors, 120 pre-existing warnings** | `docs/SECURITY_AND_TEST_REPORT.md` §1 |
| Build | `npm run build` | pass (Next.js 16 production build) | `docs/SECURITY_AND_TEST_REPORT.md` §1 |
| Browser suite, clean full run | `npm run test:e2e` | **111 passed, 5 failed, 11 skipped**, 19.1 min | `.tmp-e2e-clean.log`; `docs/SECURITY_AND_TEST_REPORT.md` §6 |
| PostgreSQL suite | `npm run test:pg` | earlier report: 10 files / 44 tests pass; latest security report: **not run** (no disposable URL) | `docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §5; `docs/SECURITY_AND_TEST_REPORT.md` §1 |

Earlier local logs show transient failures that were subsequently addressed:
`.tmp-full-test.log` had two failures (stale brand-name assertion; Zeli header test timeout);
`.tmp-final-test.log` had five `risk-notification-onboarding` failures traced to a test setup
defect. `docs/SECURITY_AND_TEST_REPORT.md` §1 records both as absent from the final run.

### 3.1 Browser failures — not a green E2E result

The clean run's five deterministic failures are recorded verbatim in
`docs/SECURITY_AND_TEST_REPORT.md` §6 and `.tmp-e2e-clean.log`:

| Spec | Failing assertion |
| --- | --- |
| `e2e/maacash-policy.spec.ts:24` | `/Shifts are required/` summary text not present |
| `e2e/maacash-reconciliation.spec.ts:45` | import summary and first detail table row not found |
| `e2e/maacash-reconciliation.spec.ts:84` | `Nothing was posted to the ledger` / unmatched row not found |
| `e2e/maacash-reconciliation.spec.ts:129` | explanation-of-at-least-10-characters message not present; submit stays disabled |
| `e2e/role-workflows.spec.ts:139` | `Withdrawal processed` role=status not found |

`e2e/role-workflows.spec.ts:16` also failed once in `.tmp-e2e-retry.log`; it is not in the clean
run's failure list. Treat it as intermittent until a repeated clean run says otherwise.

An earlier run using `node scripts/verify-e2e.mjs --workers=2` reported 116 passed, 11 skipped,
0 failed (`docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §3, §5). That is a different tree and
a different runner. It does not supersede the later clean `npm run test:e2e` result.

**Conclusion:** E2E is **not** reported as passing at the most recent recorded tree.

---

## 4. Test layer model and classification of existing tests

Observed from `vitest.config.ts`, `vitest.pg.config.ts`, `playwright.config.ts`, `tests/**`,
`e2e/**`, `.github/workflows/ci.yml` and `package.json`.

`vitest.config.ts`: node environment, `include: ["tests/**/*.test.ts"]`, excludes `pg-*.test.ts`,
`fileParallelism: false`, `maxWorkers: 1`, disposable SQLite URL supplied by
`scripts/test-database-paths.cjs`. `vitest.pg.config.ts` includes only `tests/pg-*.test.ts` and
reads `PG_DATABASE_URL`. Both configs set test-only JWT and security values and
`ALLOW_LEGACY_COOKIE_SESSIONS` (legacy cookie migration bridge) — not production settings.

Counts observed in the current tree: **167** `tests/*.test.ts` files (157 SQLite-configured,
10 `pg-*`), **29** `e2e/*.spec.ts` files. A source scan found 112 test files that import the
shared Prisma setup or create a Prisma client; the remaining 55 are pure functions or mocked
units. That is a technique split, not a quality score.

| Layer | Coverage in this repo | Representative evidence | Assessment |
| --- | --- | --- | --- |
| **Unit / pure rules** | Present, broad | `tests/shared.test.ts` (`formatCedi`, `formatDate`), `liquidity-forecast.test.ts`, `counter-companion.test.ts`, `momo-reconciliation.test.ts`, `offline-queue.test.ts`, `offline-payload.test.ts`, `csp.test.ts`, `csv-export.test.ts`, `public-routes.test.ts`, `pricing-and-enquiries.test.ts`, `zeli-intents.test.ts`, `zeli-response-format.test.ts` | Strong for deterministic business arithmetic, validation and content rules |
| **Component / UI-unit** | **Absent** | No `@testing-library/*`, no jsdom/happy-dom, no React renderer in `package.json`; no test uses `render(` | GAP: UI logic is only exercised through browser specs or string-level source assertions (`tests/ux-behaviours.test.ts`, `tests/billing-notifications.test.ts`) |
| **Integration / API (SQLite)** | Present, broad | `tests/financial-security.test.ts`, `reauth.test.ts`, `tenant-isolation.test.ts`, `platform-auth.test.ts`, `sms-status-webhook.test.ts`, `paystack-momo.test.ts`, `offline-momo-drafts.test.ts`, `performance-report.test.ts`, risk / Zeli / Susu action tests | Backend authorisation, tenant scope and money rules exercised against a disposable DB |
| **Integration / API (PostgreSQL)** | Present, narrow | `tests/pg-withdrawal-concurrency.test.ts` (two 80.00 withdrawals on 100.00 balance → one posts, balance 10.00; replayed key posts once), `pg-dual-control.test.ts`, `pg-offline-idempotency.test.ts`, `pg-susu.test.ts`, `pg-mfa-replay.test.ts`, `pg-step-up.test.ts`, `pg-financial-corrections.test.ts`, `pg-auth-migration.test.ts`, `pg-maacash-operational.test.ts`, `pg-zeli-analytics.test.ts` | Concurrency and PG-specific invariants exist; latest security report did not run this suite |
| **End-to-end (browser)** | Present, not green | 29 specs: `role-workflows`, `momo-workflow`, `maacash-reconciliation`, `maacash-policy`, `platform`, `zeli`, `tab-sessions`, `security-headers`, `responsive`, `mobile`, `maacash-offline-status`, etc. Playwright: Chromium + Pixel 7, workers 1, retries 1 under `CI`, trace/screenshot/video on failure | Five known failures; 11 environment-gated skips (six live-host, five evidence-capture) |
| **Business scenario** | Present in part | `e2e/role-workflows.spec.ts`, `e2e/momo-workflow.spec.ts`, `tests/momo-two-day-reconciliation.test.ts`, `tests/risk-intelligence-acceptance.test.ts`, `tests/liquidity-forecast-acceptance.test.ts` | Good end-to-end business arithmetic; full role matrix not covered. See scenario catalogue |
| **Security** | Present, broad in unit/integration | `security.test.ts`, `security-hardening*.test.ts`, `security-sec04-06-14.test.ts`, `security-retention-dual-control.test.ts`, `security-release-fixes.test.ts`, `financial-security.test.ts`, `tenant-isolation.test.ts`, `platform-auth.test.ts`, `platform-session-revocation.test.ts`, `tab-proof.test.ts`, `mfa-replay.test.ts`, `paystack-momo.test.ts` (HMAC), `sms-status-webhook.test.ts`, `csrf`/origin tests in `security-hardening-round2.test.ts` | Strong at function/API level; no active authenticated DAST and no independent pentest in this suite |
| **Accessibility** | Partial | `scripts/check-accessibility.mjs` runs axe-core 4.10.2 from CDN on **7 public pages only**; `tests/ux-behaviours.test.ts` and `tests/billing-notifications.test.ts` assert source strings (`aria-busy`, `aria-label`, `aria-modal`, focus lock); Playwright specs assert a few `aria-*` attributes | GAP: no axe run over authenticated role workflows, dialogs, tables or mobile shell in CI |
| **Performance / load** | **Absent as a test** | `scripts/load-test.mjs` is a standalone Node HTTP probe over `/api/health`, `/`, `/pricing`, `/privacy`, `/login` only; `tests/performance-report.test.ts` tests report math, not latency | GAP: no authenticated, sustained or concurrent-load evidence; CI has no load stage |
| **Resilience** | Present as fault-injection units | `zeli-provider-resilience.test.ts`, `paystack-ping.test.ts`, `sms-status-webhook.test.ts`, `offline-connectivity-transition.test.ts`, `offline-deletion-coordination.test.ts`, `maintenance-guard.test.ts`, `payment-intent-attempts.test.ts`, idempotency and replay tests | Provider timeout/malformed/duplicate paths covered at unit/API level; no weak-network browser run beyond offline-status specs |
| **Recovery** | Partial | `admin-recovery.test.ts`, password-reset / recovery-token tests, `release-safety.test.ts`, migration rehearsal scripts (`verify-sqlite-migrations.mjs`, `verify-pg-migrations.mjs`), `offline-deletion-coordination.test.ts` | Account recovery and migration rehearsal covered; **no verified database snapshot/restore** (`docs/SECURITY_AND_TEST_REPORT.md` §7) |
| **Exploratory / UAT** | Manual only | `docs/testing/COUNTER-COMPANION-ANDROID-ACCEPTANCE.md` §6 (13 device steps), `docs/testing/FINAL-REMAINING-DEPENDENCIES.md` §5 | Explicitly owner/manual; no automated device or UAT evidence |

### 4.1 CI pipeline (observed)

`.github/workflows/ci.yml` defines five jobs:

1. `sqlite-verify` — `npm ci`, `npx prisma generate`, `npx prisma db push`, `npm run lint`,
   `npm run typecheck`, `npm audit --audit-level=critical`, `npm test`, `npm run build`.
2. `postgres-verify` — disposable `postgres:16-alpine` service; `prisma generate`,
   `migrate deploy`, `migrate status`, `migrate diff --exit-code`,
   `npx vitest run --config vitest.pg.config.ts`.
3. `mobile-browser` — Playwright Chromium install, `npm run test:e2e -- --project=mobile-chromium`.
4. `secret-scan` — ignore checks plus full-history Gitleaks with `--redact`.
5. `codeql` — CodeQL init/autobuild/analyze; SARIF uploaded as artifact, code scanning not enabled.

No load, accessibility, DAST, authenticated workflow or UAT stage exists in CI. The full
desktop browser suite is not part of the default CI triggers.

---

## 5. Tool assessment (technology-neutral, no new dependencies)

| Tool / mechanism | Present? | Fit | Recommendation |
| --- | --- | --- | --- |
| **Vitest** | Yes, `^4.1.11`; node env, single worker by design | Good fit for pure logic, server actions and disposable-DB integration; one worker is a stability workaround recorded in `docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §5.1 | Keep. Run unit and PostgreSQL suites as separate commands; do not treat a worker-crash result as a test failure or as a green tick |
| **Playwright** | Yes, `@playwright/test ^1.64.1`; two projects, trace/video/screenshot on failure | Good fit for role flows and offline shell; currently not green and not fully in CI | Keep. Fix or re-baseline the five known failures deliberately; do not change assertions to force green. Add the desktop project to CI once stable |
| **axe-core** | Yes, via CDN fetch in `scripts/check-accessibility.mjs`, not a package dependency | Good for public-page WCAG A/AA checks; narrow scope, network-dependent script, no CI stage | Keep as an opt-in check. Extend coverage to authenticated role surfaces and run on a local copy of the axe script before treating it as a gate |
| **k6** | Not installed (`docs/PERFORMANCE_AND_LOAD_TEST_REPORT.md` §1) | Suitable for authenticated workload modelling when an isolated environment exists | Optional. Adopt only with owner-approved paid environment and synthetic data. Do not mandate |
| **`scripts/load-test.mjs`** | Yes, Node built-in HTTP | Honest public-surface smoke probe; explicitly not a capacity test | Keep, labelled as smoke only. Never target production; see capacity plan |
| **OWASP ZAP** | Past use recorded: unauthenticated and authenticated passive baselines in `docs/security/dast/` (0 FAIL / 7–8 WARN); no active scan | Good for passive surface checks; active scan unsafe here because it submits forms that can post money | Treat historical reports as point-in-time evidence. Any active or re-run scan needs an isolated disposable staging copy and written scope |
| **SAST (CodeQL)** | Yes in CI, SARIF artifact only, code scanning disabled | Useful but currently non-gating and unexamined here | Review the SARIF before release. Do not assume zero findings from "job ran" |
| **SCA (`npm audit --audit-level=critical`)** | Yes in CI; `docs/security/CLOSEOUT-2026-11.md` notes high advisories in a CLI-only transitive dependency | Reasonable minimum; critical-only misses high/medium risk | Record current audit output with each release. Consider reviewing non-critical advisories; do not add tooling without owner decision |
| **Secret scanning (Gitleaks)** | Yes in CI, full history, redacted, plus ignore assertions | Good fit | Keep. Never paste findings containing secret material into tickets or docs |

No tool in this section is mandated by this audit. The choice to add k6, broaden axe or enable
CodeQL gating belongs to the owner with a funded, isolated environment.

---

## 6. Coverage gaps (priority order)

1. **E2E not green.** Five known failures across policy, reconciliation and withdrawal re-auth.
   Fix UI/test alignment deliberately; record evidence. See §3.1.
2. **No current-tree verification.** This audit ran nothing, and the tree is dirty. Re-run
   `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:pg` and
   `npm run test:e2e` on a clean, identified tree before release sign-off.
3. **No component-test layer** and no axe coverage of authenticated surfaces.
4. **No capacity evidence.** No authenticated load, no connection-pool or provider-limit
   measurement. See `PERFORMANCE_AND_CAPACITY_PLAN.md`.
5. **Role and scenario matrix incomplete.** No automated anonymous, platform-admin, privacy
   grant-holder, stale-session, cross-branch or duplicate-submission journey set. See
   `REAL_WORLD_SCENARIO_CATALOGUE.md`.
6. **No verified restore point** and no multi-instance sweep coordination evidence.
7. **Six production-host browser checks and physical-device PWA steps remain owner/manual.**
8. **Historical gate instability.** The consolidated gate did not complete reliably in six
   attempts (`docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §5.1); run steps individually.

---

## 7. Release gate recommendation (no changes made)

Run, in this order, on a clean identified tree, and record exact outputs:

```
npm run typecheck
npm run lint
npm test
npm run test:pg
npm run build
npm run test:e2e
```

Use `npm run test:release` only as a convenience wrapper; if it reports a worker-crash
signature or an opaque build-worker error, re-run the individual commands rather than
retrying until green. E2E must be reported with its pass/fail/skip counts, never rounded to
"passed". Load, DAST and accessibility checks remain separate, explicitly scoped activities.

**Final safeguard:** a green suite is not proof that the product is secure or production-ready.
Owner approval is required before deployment. No approval was requested or given in this audit.
