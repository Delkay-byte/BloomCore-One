# Production release readiness addendum — 25 November 2026

Companion to the preserved 25 November final reports. This addendum records the
local remediation performed after those reports. **Release remains HELD.**
No push, merge, publish, deploy, production setting change, production migration,
production load test or production retention sweep was performed.

## 1. Baseline verification

| Item | Verified value |
|---|---|
| Branch | `feat/maacash-momag-readiness` |
| HEAD | `7192f9890df5b1b856b0b0e085c25def9b7e6393` |
| Relationship to `origin/main` | 0 behind, 90 ahead |
| Working tree | Pre-existing modified/untracked work preserved; no unrelated work discarded |
| Final reports | Present; their E2E and capacity status is superseded by this addendum |
| Isolated local run | Achievable with SQLite; no production target used |
| k6 | Not installed; documented protocol-level equivalent used |
| Docker | v29.9.2 available; PostgreSQL 16 image present but not used (see §4) |

Owner-completed items recorded: password-recovery email receipt confirmed;
previously exposed Neon API key revoked. Neither is reopened here. Counsel/DPIA is
out of scope for this task and is not reintroduced.

## 2. E2E remediation

All five failures reproduced deterministically. Root cause was not UI-label drift:
a successful Server Action calls `revalidatePath`, the following Next.js RSC
refresh omits the tab-session headers, `requireTenantContext()` fails closed, and
the tab is redirected through `/admin/login` to `/admin/dashboard`. Traces and
HAR entries confirm this. Application labels matched the specs.

Fixes asserted persisted server state after reload/navigation instead of the
transient banner; CSV bytes are unique per run so retries cannot collide; manual
match rows are located by provider reference; the collector workflow guards
against double-posting. No assertion was weakened, no test deleted, no retry count
increased, and no permission or business rule changed. A synchronous helper moved
out of a `"use server"` module made `npm run build` pass again.

Final E2E results, two clean runs from freshly prepared disposable databases:

| Run | Passed first attempt | Failed | Flaky | Skipped |
|---|---:|---:|---:|---:|
| Clean run 1 | 121 | 0 | 0 | 6 |
| Clean run 2 | 121 | 0 | 0 | 6 |

Of the original 11 skips, five evidence tests were enabled and pass. Six remain:
they require a real deployed custom domain or legacy transition host. None is a
critical business, financial, security or tenant-isolation test. See
`docs/E2E_FAILURE_REMEDIATION_REPORT.md`.

## 3. Isolated environment and load test

Local-only setup: Next.js on `127.0.0.1:3101`, disposable SQLite, synthetic
tenants/roles/records, blanked provider credentials, separate DB from E2E.
Safety preflight rejected non-local base URLs and non-local database URLs.
Protocol-level generator: 8 workers, role-weighted sessions, ~85/15 read/write
mix, realistic think times. k6 absent; equivalent harness in `scripts/local-load/`.

Hardware: i7-12700H, 14 cores/20 logical, 15.69 GiB RAM, Windows 11 Pro, Node
22.23.2. Generator was not saturated (max CPU/wall ratio 0.106).

| Result | Value |
|---|---|
| Highest sustainable local concurrency | **50 VUs** — 890 requests, 19.78 RPS, p95 877 ms, 0 failures |
| 1,000-VU peak | 37,161 requests, 309.68 RPS, only 1,228 HTTP 200 (3.3%), 33,317 `ECONNREFUSED`, 2,608 timeouts |
| Write failures at peak | 7,862 of 8,219 attempted offline writes |
| App RSS at peak | up to 785 MB |
| Database | SQLite synchronous writes and listener refusal, not Neon behaviour |

1,000 VUs were scheduled but **not sustained**. No production capacity claim is
made. See `docs/LOCAL_1000_VU_LOAD_TEST_PLAN.md` and
`docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md`.

## 4. Real-world failure scenarios

`docs/REAL_WORLD_CONCURRENCY_AND_FAILURE_TEST_REPORT.md`: 17 scenarios matched
expected existing behaviour; 1 (provider timeout) remains unverified because no
injectable provider endpoint exists; 0 unexpected outcomes. No duplicate financial
record, cross-tenant access, unauthorised state change or lost write was observed
in the executed local cases. An initial SSR build defect (`InvariantError`, 500s
on some protected pages) was resolved by a clean rebuild; add a post-build
protected-route smoke before release.

## 5. Retention verification and owner runbook

Script: `scripts/run-risk-retention-cron.mjs`. Preview entry point:
`node scripts/run-risk-retention-cron.mjs --dry-run` (read-only, aggregate counts,
no token, no HTTP). Execution entry point:
`node scripts/run-risk-retention-cron.mjs` (mutating authenticated HTTPS POST;
unchanged production path). Owner runbook:
`docs/RETENTION_WEEKLY_OWNER_RUNBOOK.md`. Verification evidence:
`docs/RETENTION_SCRIPT_VERIFICATION.md`.

Local proof: dry-run made zero mutations (row counts, logical hash and SQLite file
hash identical before/after); 21/21 verification checks and 6/6 regression tests
passed. Fixed defects: F1 unique non-identifying scrub keys, F2 live legal-hold
extension defers scrubbing, F3 stable batch ordering, F4 deduplicated hold-review
events, F6 `deletedAt: null` on stale-signal expiry, F7 authorise before mutate.
F5 (action-level overlap) remains open; keep one execution shell at a time.

**The agent did not run the production retention sweep.** The owner performs it
weekly on Monday in Africa/Accra using the runbook.

## 6. Regression results

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | 0 errors, 151 pre-existing warnings |
| `npm run build` | pass (verified after the helper move) |
| Full `npm test` | **158 files passed, 1834 tests passed, 0 failed** (fresh disposable SQLite, 368.98 s) |
| E2E `CI=1 npm run test:e2e` | 121 passed, 0 failed, 0 flaky, 6 skipped in each of two clean runs |
| Retention local proof | 21/21 checks; 6/6 `tests/retention-fixes.test.ts` |
| Load/failure harness | executed locally; see §3–4 |

An earlier full-suite run during remediation showed six timeouts in unrelated
files that did not reproduce in isolation; the final full run had **zero timeouts**
and is recorded above.

## 7. Remaining risk register

| Severity | Finding | Status |
|---|---|---|
| Medium | F5: overlap guard route-level only; simultaneous direct action calls can both scrub | open; one-shell rule |
| Medium | Post-write RSC refresh can bounce a user to the dashboard after a successful action | open; no auth bypass/data exposure |
| Medium | 1,000 VUs not sustained locally; no production-equivalent capacity evidence | open; owner decision |
| Medium | Six deployed-origin E2E checks remain skipped | open until an authorised deployment exists |
| Low | Provider timeout path unverified; local soak memory growth to ~785 MB | open; controlled follow-up needed |
| Low | CodeQL SARIF not centrally enforced; WAF/DDoS and origin bypass evidence gaps from earlier audit | unchanged from prior report |
| Informational | Owner-confirmed email receipt and Neon key revocation | **completed**, not outstanding |

No Critical or High code-level vulnerability was demonstrated in this work.

## 8. Release decision

**ENGINEERING REMEDIATION INCOMPLETE — RELEASE HELD.**

All five E2E failures are resolved and all skips accounted for; retention dry-run
and runbook are verified locally; load and failure scenarios were executed.
Remaining risks in §7 and the absence of production verification prevent a
production-ready claim. Owner review and separate authorisation are required for
any push, merge, deployment or production capacity change.
