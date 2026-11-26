> **Dated addendum — 25 November 2026.** Counsel/DPIA/DPO/DPS approval is not a MaaCash requirement, onboarding gate or release gate. Any below reference to it as outstanding is historical and superseded by `docs/privacy/COUNSEL_DPIA_DPO_DPS_REMOVAL_ADDENDUM.md`.

# Security and test report — MaaCash

Audited: 25 November 2026. Contains no secret values and no fabricated results.

## 1. Test execution summary

| Suite / check | Result |
| --- | --- |
| `npm test` (Vitest, full suite) | **157 files passed, 1828 tests passed, 0 failed** |
| `npm run typecheck` | **pass** |
| `npm run lint` | **pass — 0 errors, 120 pre-existing warnings** (unused variables/imports) |
| `npm run build` | **pass** (Next.js 16 production build) |
| `npm run test:e2e` (Playwright) | see §6 |
| `npm run test:pg` | **not run** — no disposable PostgreSQL URL was available from the audit host |
| Production-host browser checks | **not run** — no second deployment authorised |

Earlier baseline had 2 failures: a stale brand-name assertion (already corrected
in the working tree) and a 5-second timeout in `zeli-chat-provider-header.test.ts`.
Both are absent from the final run.

Four failures in `risk-notification-onboarding.test.ts` were found to be a test
setup defect: global privacy actions require a platform administrator, while the
test mocked only a tenant admin and omitted `tenantId` from the session. The test
mocks were corrected; server-side authorisation was **not** weakened. Those four
tests now pass, and `release-config.test.ts` now matches the live `autoDeploy`
setting.

## 2. DPO/DPS dependency audit

Full sweep across schemas, migrations, actions, API routes, middleware, onboarding,
agreements, notifications, env files, config, docs and tests found **zero**
mandatory DPO/DPS gates. Remaining `dpoReference` columns and `legacy dpo` role
labels are backward-compatible names, not approval steps. No DPO account, login,
session, dashboard review, signature or countersignature exists.

## 3. Security findings and fixes

| File | Severity | Finding | Fix applied |
| --- | --- | --- | --- |
| `src/lib/security/tab-proof.ts` | medium | Nonce replay possible with a client-supplied request id after the 2s cache expired | Nonce is now strictly single-use at the database key; same-request dedupe remains only in the short-lived in-memory cache |
| `src/app/api/internal/risk-intelligence/retention/route.ts` | medium | No rate limit and no overlap control; concurrent sweeps duplicated control events | Added hashed-token rate limit (6/hour) and an in-process overlap guard with 409 response |
| `src/app/api/internal/anomaly/scan/route.ts` | medium | Raw exception messages returned and persisted | Only a fixed message with the error class is stored or returned |
| `src/app/api/auth/selection/route.ts` | low | Selection payload lacked `Cache-Control: no-store` | Added `no-store` |
| `src/app/api/offline/sync-contribution/route.ts`, `offline/enroll/route.ts`, `v1/platform/sessions/revoke/route.ts` | low | `console.error(err)` could log Prisma query metadata | Log error name and Prisma code only |
| Untracked `.tmp-reset-*.ts` scripts | low | Temporary scripts held a plaintext test password | Removed before release staging |

No critical or high-severity finding remained open after these fixes.

Verified clean by review and existing tests: bcrypt cost 12 with dummy-hash timing
equalisation; 32-byte random reset and verification tokens stored as SHA-256;
30-minute reset expiry; single-use tokens consumed transactionally; session
revocation on reset and password change; tenant context derived from the session;
webhook raw-body HMAC with `timingSafeEqual`; evidence path-traversal checks;
timing-safe retention-token comparison.

## 4. Account recovery verification

A synthetic local account (no real customer) was used with the **production
Resend configuration**: verified sender domain `notifications.bloomcoretech.com`,
production API key and the canonical origin. The test recipient was the
owner-approved mailbox `bloomcoretechnologies@gmail.com`.

Observed:

| Check | Result |
| --- | --- |
| Provider accepted the reset email | yes — HTTP 200 and provider message id |
| Reset completed with the delivered token | yes |
| Old password rejected after reset | yes |
| New password accepted | yes |
| Reset link reuse rejected | yes |
| All sessions revoked on reset | implemented; covered by unit tests |

Provider acceptance is not the same as confirmed inbox delivery. The owner
should confirm receipt in the test mailbox. No test email was sent to a real
customer account.

## 5. Regression coverage

The full suite exercises business registration/login, worker creation/login,
agent onboarding, role permissions, financial and transaction workflows,
notifications, agreements, privacy notices, shared risk intelligence, retention,
audit records, offline drafts, CSP, tenant isolation and security hardening.
A second-tenant administrator regression test is present for cross-tenant
privacy actions. DPO removal introduced no regression: all previously passing
suites still pass.

## 6. End-to-end browser tests

`npm run test:e2e` was executed against an isolated SQLite database with
synthetic tenants. The full run reached 125 cases before the 900-second command
ceiling stopped it. Four cases failed: three in
`e2e/maacash-reconciliation.spec.ts` (lines 45, 84, 129) and one in
`e2e/role-workflows.spec.ts` (line 139). All other executed cases passed,
including login, responsive sweeps, CSP, role dashboards and security headers.
A clean full run on a freshly reset E2E database, with `CI=1` and no reused
server, completed in 19.1 minutes: **111 passed, 5 failed, 11 skipped** of 127.
The 11 skips are the live custom-domain checks, which need a deployed origin.
The five deterministic failures are:

| Spec | Failing assertion |
|---|---|
| `maacash-policy.spec.ts:24` | `/Shifts are required/` summary text not present |
| `maacash-reconciliation.spec.ts:45` | import summary and first detail table row not found |
| `maacash-reconciliation.spec.ts:84` | `Nothing was posted to the ledger` and `unmatched` row not found |
| `maacash-reconciliation.spec.ts:129` | `/needs an explanation of at least 10 characters/` not present; submit stays disabled |
| `role-workflows.spec.ts:139` | `Withdrawal processed` role=status not found |

Failure traces, screenshots and videos are in `test-results/`. The assertions
concern UI labels and post-action status surfaces that have drifted from these
specs; fixing them needs deliberate UI/test alignment, not a blind assertion
change. E2E is **not** reported as a pass.

## 7. Residual risks

- Application-level encryption of risk signal notes is not implemented; the
  managed database provider's at-rest controls carry that risk.
- There is no independent privacy officer. Owner accountability is stronger
  with external counsel review, which is still outstanding.
- No verified database snapshot or restore point exists from the audit host.
- No 1,000-user capacity evidence exists; see the performance report.
- Lint warnings are pre-existing and do not block the build.
