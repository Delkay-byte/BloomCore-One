# Production release readiness — final engineering addendum

Date: 25 November 2026. Preserves earlier reports; does not rewrite them.
Release remains **HELD** until the owner separately authorises release.

No push, merge, deploy, production migration, production retention execution,
production load test or live provider setting change was performed.

## 1. Verified Git baseline

| Item | Value |
| --- | --- |
| Repository | `https://github.com/Delkay-byte/BloomCore-One.git` |
| Branch | `feat/maacash-momag-readiness` |
| HEAD before changes | `7192f9890df5b1b856b0b0e085c25def9b7e6393` |
| `origin/main` | 0 behind, 90 ahead |
| Working tree | 129 pre-existing dirty entries preserved; new local changes added without discarding work |

## 2. Engineering changes made locally

| Area | Change | Evidence |
| --- | --- | --- |
| Retention F5 | Database-backed `SystemJobLease` with atomic claim, fencing, heartbeat and own-lease-only release; both mutation paths guarded | `docs/RETENTION_CROSS_PROCESS_LOCK_REMEDIATION.md` |
| Export routes | Scoped sustained + burst DB-backed limits on `/api/zeli/analytics/export`, `/api/association/export`, `/api/audit`; uniform 429 + `Retry-After` | `docs/security/EXPORT_ENDPOINT_RATE_LIMIT_REMEDIATION.md` |
| Counter fairness | Atomic increment now returns the caller's own count, preventing concurrent over-blocking | `src/lib/security/rate-limit.ts` |
| Trusted proxy | `CF-Connecting-IP` trusted only with an edge HMAC proof over that exact IP; forged headers fail closed | `docs/security/RENDER_ORIGIN_AND_TRUSTED_PROXY_REMEDIATION.md` |
| Retired `dpo` alias | Removed from active authorization and UI admin counting; historical labels retained | `tests/retired-dpo-role.test.ts` |
| Deployment E2E | Six deployed-origin checks moved to a separate explicitly named suite; local suite has no unexplained skips | `docs/testing/DEPLOYMENT_SMOKE_TEST_MATRIX.md` |
| CI supply chain | Actions pinned to verified SHAs, Gitleaks pinned by digest, dependency-review job, Dependabot config, least privilege | `docs/security/GITHUB_SECURITY_AND_BRANCH_PROTECTION_RUNBOOK.md` |
| Counsel/DPIA/DPO/DPS | Owner-directed removal confirmed in code; historical doc references explicitly superseded | `docs/privacy/COUNSEL_DPIA_DPO_DPS_REMOVAL_ADDENDUM.md` |

## 3. Test results

| Check | Exact command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | pass |
| Lint | `npm run lint` | 0 errors, 151 pre-existing warnings (unchanged) |
| Targeted new regressions | `npx vitest run tests/f5-retention-cross-process-lock.test.ts tests/export-rate-limit.test.ts tests/security-hardening.test.ts tests/security-hardening-round2.test.ts tests/retention-fixes.test.ts` | 5 files, 62 tests passed |
| Retired role guard | `npx vitest run tests/retired-dpo-role.test.ts tests/release-config.test.ts` | 2 files, 8 tests passed |
| Supply-chain pins | `npx vitest run tests/ci-supply-chain-pins.test.ts` | 5 tests passed |
| Full unit suite | `npm test` | 159 files passed, 1 failed file, 1,849 passed / 2 failed tests; both failures are 5 s timeouts in `tests/commercial-lifecycle.test.ts` under full-suite load. Same file passed 18/18 in isolation in 3.02 s. No timeout, retry or assertion was changed. |
| PostgreSQL suite | `npm run test:pg` on disposable PostgreSQL 18.6 | 10 files, 44 tests passed; 70 migrations applied, status up to date |
| Production build | `npm run build` | pass (compiled successfully, full route table emitted) |
| E2E clean run 1 | `CI=1 npm run test:e2e` | 121 passed, 0 failed, 0 flaky, 0 skipped (11.0 min) |
| E2E run 2 | `CI=1 npm run test:e2e` | 120 passed, 1 flaky (first attempt 8 px overflow at 390 px during post-write RSC refresh; passed on retry). No assertion changed. |
| E2E clean run 3 | `CI=1 npm run test:e2e` | 121 passed, 0 failed, 0 flaky, 0 skipped (11.4 min) |

## 4. Remaining open items

- **Deployment smoke suite** — six deployed-origin checks moved to
  `e2e/deployment-smoke.spec.ts` with `npm run test:e2e:deployment`; not executed
  locally by design. `docs/testing/DEPLOYMENT_SMOKE_TEST_MATRIX.md`.
- **Post-write RSC session bounce** — root cause verified, fix not implemented in
  this pass. `docs/security/RSC_SESSION_TRANSPORT_REMEDIATION.md`.
- **1,000 VU on PostgreSQL** — not re-run; only the earlier SQLite result exists
  (50 VUs sustainable). `docs/testing/LOCAL_POSTGRESQL_1000_VU_RESULTS.md`.
- **Provider timeout through the real app transport** — stub prepared, not
  verified end-to-end. `docs/testing/PROVIDER_FAILURE_AND_TIMEOUT_VERIFICATION.md`.
- **Memory soak** — earlier RSS rise did not prove a leak; controlled soak not
  completed. `docs/testing/MEMORY_SOAK_AND_CAPACITY_ANALYSIS.md`.
- **Cloudflare / Render / GitHub live settings** — owner actions only; nothing
  claimed active without live evidence.
- **Neon provider restore** — local drill completed; provider restore unverified.

## 5. Owner-completed items (recorded, not reopened)

- Previously exposed Neon API key revoked.
- MaaCash password-recovery email received.

## 6. Release decision

**ENGINEERING REMEDIATION INCOMPLETE — RELEASE HELD.**

Local fixes are substantial, but a critical UX/session defect, the
PostgreSQL-based capacity evidence and provider-only verification remain open.
The owner must review and separately authorise any release activity.
