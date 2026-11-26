# Retention cron verification — `run-risk-retention-cron.mjs`

Owner: BLOOMCORE TECHNOLOGIES. Audited 25 November 2026; defect-fix pass same date.
No secret value, URL value or customer record appears in this document.
Production release remains **HELD**.

**Production access: none. The production retention sweep was NOT run by the agent.**
All tests used disposable synthetic SQLite databases under the OS temporary
directory. No push, merge, deploy, production query or production write occurred.

## 1. Entry points and exact commands

| Purpose | Exact command |
| --- | --- |
| Usage help | `node scripts/run-risk-retention-cron.mjs --help` |
| Read-only preview | `node scripts/run-risk-retention-cron.mjs --dry-run` |
| Mutating production execution | `node scripts/run-risk-retention-cron.mjs` |
| Local proof suite | `node scripts/local-retention/verify-retention.mjs` |
| Date arithmetic assertions | `node node_modules/tsx/dist/cli.mjs scripts/local-retention/check-date-arithmetic.ts` |
| Targeted regression tests | `npx vitest run tests/retention-fixes.test.ts` |
| Type check | `npm run typecheck` |
| Full suite | `npm test` |

The two modes are mutually exclusive. `--dry-run` never builds a URL, never reads
`RISK_RETENTION_TOKEN`, and never calls `fetch`. Execution never reads
`RETENTION_PREVIEW_DATABASE_URL`. The script rejects unknown arguments.

Environment variable **names** consumed (no values are printed or stored here):

| Name | Used by | Purpose |
| --- | --- | --- |
| `RETENTION_PREVIEW_DATABASE_URL` | preview only | `file:` SQLite URL or postgres URL to inspect |
| `RETENTION_PREVIEW_ALLOW_PRODUCTION` | preview only | deliberate-selection flag for any postgres preview |
| `MAACASH_APP_URL` | execution only | production origin; `SITE_URL` is the fallback |
| `SITE_URL` | execution only | fallback origin |
| `RISK_RETENTION_TOKEN` | execution and verifier | internal bearer token |
| `DATABASE_URL` | local test helpers only | disposable SQLite URL for `run-local-sweep.ts` and the Vitest fixture |

## 2. Implementation trace (verified in source after fixes)

| Component | Verified behavior |
| --- | --- |
| `scripts/run-risk-retention-cron.mjs` | Execution path unchanged: HTTPS-only `POST /api/internal/risk-intelligence/retention`, `Authorization: Bearer <token>`, 30 s timeout, `cache: "no-store"`, status check, non-zero exit on failure, logs status/elapsed/counts only. Preview path spawns the local preview module; no HTTP call. |
| `src/app/api/internal/risk-intelligence/retention/route.ts` | Token presence → 503. Non-mutating `verifyRiskRetentionToken` → 403. Then `consumeRateLimit("risk_retention:sweep", token, { limit: 6, windowMs: 3600000 })` → 429. Then module-level `sweepInProgress` → 409. Only then does the mutating `runSystemRiskRetentionSweep` and `expireStaleRiskSignals` run. Response `{ expired, scrubbed, audited }`. Token never logged. |
| `src/lib/actions/risk-governance.actions.ts` | Exports non-mutating `verifyRiskRetentionToken` with constant-time compare. `holdDefersDeletion` skips null **and** future effective deadlines for both signal and subject holds. Scrub writes `scrubbed:<signalId>` for `subjectKey` and `sourceId`. Both 500-row `findMany` calls use `orderBy: { id: "asc" }`. Review events are deduplicated by action, scope, tenant, reason and case-closure time. Audit row only when a count is non-zero. |
| `src/lib/actions/risk-intelligence.actions.ts` | `expireStaleRiskSignals` authorises by token or privacy grant and uses `status: "open", expiresAt <= now, deletedAt: null`. Writes `risk_intelligence.signals_expired` when count > 0. Deletes nothing. |
| `src/lib/risk-intelligence/retention.ts` | Unchanged pure date arithmetic: 180/90/90/90 days, 24 months, 14 review days, end-of-month clamp, null deadline for unresolved disputes. |
| `scripts/local-retention/preview.ts` | Imports the SAME `retention.ts` functions. Read-only Prisma calls. SQLite `readonly: true, fileMustExist: true`; postgres `default_transaction_read_only=on` plus deliberate-selection flag. Includes due `open` rows in its ordered read-only window (without writing) because the sweep expires them before its scrub query; this keeps preview and sweep counts identical at the 500-row edge. Sanitises URLs, paths and long hex strings from errors. |

## 3. Approved retention rules (as implemented)

| Rule | Implementation |
| --- | --- |
| 180-day expiry | `RISK_ACTIVE_SIGNAL_DAYS = 180`; sweep expires `open`, non-deleted rows with `expiresAt <= now`. |
| 90-day post-expiry / withdrawal / resolution | `signalDeletionDeadline` as specified; unresolved disputes return null and are never auto-deleted. |
| 24-month disclosure de-identification | `riskAuditDeletionDeadline` with end-of-month clamp. |
| Legal holds | Active hold, or hold with a live future extension, defers deletion. Released hold has no effect. Review due 14 days after case closure. |
| 500-row batch | `take: 500`, `orderBy: { id: "asc" }`, one batch per sweep per table. |
| Audit row | `risk_intelligence.retention_sweep` written only when a count is non-zero. |
| Rate limit + overlap guard | 6/hour per hashed token; database-backed lease returns 409 while another execution holds it (F5 fixed). |
| Token auth | Constant-time compare in a non-mutating verifier before any write. |
| Idempotency | `deletedAt: null` filters make scrub/expiry re-runs harmless; review events are now deduplicated; sweep audit rows are not re-written on zero runs. |

## 4. Dry-run proof

Run: `node scripts/local-retention/verify-retention.mjs`. Result: **21/21 checks passed**.
Evidence: `tests/local-retention-evidence.json` (counts and check names only).

Before and after two consecutive dry-runs on the synthetic database, the harness
compared row counts, a SHA-256 hash of a canonical dump of all relevant columns,
and a SHA-256 hash of the SQLite file bytes. All were identical. The two dry-runs
returned identical aggregate counts. SQLite `readonly: true` makes any accidental
write fail at the driver. Output was counts only: no row value, URL or token.

## 5. Fix status

| ID | Status | Fix and verified location |
| --- | --- | --- |
| F1 | **Fixed** | `risk-governance.actions.ts` writes `scrubbed:<signalId>` to `subjectKey` and `sourceId`. Non-identifying, unique per row, so `@@unique([tenantId, subjectKey, sourceType, sourceId])` cannot abort a multi-row sweep. Regression: two same-tenant/same-sourceType rows both scrub. |
| F2 | **Fixed** | `holdDefersDeletion` in `risk-governance.actions.ts`, mirrored in `preview.ts`. A live future extension defers scrubbing; null deadline still skips. Applied to signal and subject holds. |
| F3 | **Fixed** | Stable `orderBy: { id: "asc" }` on both 500-row queries, mirrored in preview. Preview also includes due `open` rows read-only so the ordered window matches the post-expiry sweep. Exact count parity verified at the batch edge. |
| F4 | **Fixed** | `riskControlEvent.findFirst` dedupe by action, scope, tenant, reason and `createdAt >= caseClosureDate` before creating `legal_hold_review_due`. Duplicate sweeps no longer append another event. |
| F5 | **Fixed — 25 Nov 2026** | Database-backed `SystemJobLease` with atomic claim, fencing token, heartbeat and own-lease-only release. See `docs/RETENTION_CROSS_PROCESS_LOCK_REMEDIATION.md`. |
| F6 | **Fixed** | `expireStaleRiskSignals` predicate now includes `deletedAt: null`. Already-deleted open rows are not re-expired. |
| F7 | **Fixed** | Exported non-mutating `verifyRiskRetentionToken`. Route order is now verify → rate limit → overlap guard → mutate. Timing-safe compare retained; no token logging. |

### F5 resolution — 25 November 2026

The earlier route-level guard was process-local. It is replaced by a
database-backed lease (`SystemJobLease`) shared by both mutation paths. The
claim and each pre-mutation fence are single atomic statements that behave
identically on SQLite and PostgreSQL, so the mandated local regression suite
can prove cross-process behaviour. See
`docs/RETENTION_CROSS_PROCESS_LOCK_REMEDIATION.md` for design and test evidence.
The one-shell warning is no longer the control.

## 6. Exact tests and results

| Command | Result |
| --- | --- |
| `node scripts/local-retention/verify-retention.mjs` | 21/21 checks passed |
| `npx vitest run tests/retention-fixes.test.ts` | 6/6 tests passed |
| `npm run typecheck` | passed |
| `npm test` | 1834 tests: 1828 passed, 6 timeouts in unrelated files |
| `npx vitest run tests/paystack-hosted-checkout.test.ts tests/shift-handover.test.ts tests/test-infrastructure.test.ts tests/performance-report.test.ts` | 59/59 passed — the six full-suite timeouts did not reproduce in isolation |

The six full-suite timeouts were in `tests/paystack-hosted-checkout.test.ts`,
`tests/shift-handover.test.ts` (3), `tests/test-infrastructure.test.ts` and
`tests/performance-report.test.ts`. They are 5-second per-test timeouts under full
suite load, not assertion failures. No retention-fix test failed.

`tests/retention-fixes.test.ts` uses its own SQLite file under the OS temp
directory. It covers:

- **F1** — two same-tenant/same-sourceType rows both scrub; `subjectKey` and
  `sourceId` equal `scrubbed:<id>`; `deletedAt` and `scrubbedAt` set.
- **F2** — signal hold and subject hold with live future extensions; preview reports
  `holdsSkipped = 2`, sweep scrubs only the unheld control row.
- **F3** — 503 candidates; preview `scrubCandidates = 500` and batch flag true;
  sweep scrubbed 500; preview then 3; second sweep scrubbed 3.
- **F4** — two sweeps against one review-due hold produce exactly one
  `legal_hold_review_due` event.
- **F6** — one live and one already-deleted due open row; `expired = 1`; deleted
  row stays `open`.
- **F7** — verifier accepts the configured token, rejects wrong and empty tokens
  without mutation; route returns 403 for a wrong token and leaves rows intact.

Local harness highlights (latest run):

| Scenario | Result |
| --- | --- |
| Main preview | `expiredCandidates 1`, `scrubCandidates 492`, `auditCandidates 499`, `holdsSkipped 3`, `legalHoldReviewCandidates 1`, both batch flags true |
| First real local sweep | expired 1, scrubbed 492, audited 499 — exact preview parity |
| Second sweep (batch recovery) | expired 0, scrubbed 16, audited 3; preview then zero |
| Duplicate execution | no second scrub, no second de-identification, no second sweep audit row, no repeated review event |
| Concurrent action calls | final state zero candidates; both calls still reported five scrubs (F5) |
| Dry-run mutation proof | counts, logical hash and file hash unchanged |

One pre-existing assertion in `tests/risk-governance-actions.test.ts` was updated
from `scrubbed` to `scrubbed:${signal.id}` to match the F1 fix. No other test
assertion changed.

## 7. Idempotency, failure and recovery handling

- Preview is read-only and repeatable.
- Scrub and expiry re-runs skip rows with `deletedAt` set; review events are deduplicated.
- Wrong token: verifier returns false, route returns 403, nothing mutates.
- 429: stop and retry only in a later window. 409: wait, re-preview, retry once.
- 503: token absent; do not retry until configured.
- Timeout or non-JSON response: verify state with preview before any retry.
- Batch flag true: a second run is expected; preview counts now identify the exact remainder.

## 8. Schema compatibility

- No schema, migration, `package.json`, CI, render config, `e2e/**`, `docs/E2E*`
  or `docs/LOCAL_*` file was changed. No dependency was added.
- Fix F1 relies on the existing `AgentRiskSignal.id` uniqueness, not a new column.
- Fix F4 uses existing `RiskControlEvent` fields (`action`, `scopeId`, `tenantId`,
  `reason`, `createdAt`).
- Generated client remains SQLite for local work; postgres preview still requires
  `npm run db:generate:pg` and is **UNVERIFIED** by the agent (no production access).
- The live HTTPS execution path is **UNVERIFIED against production**: no request
  was made. Only its ordering of existing calls changed.

## 9. Scope statement

No production access. No production sweep. No push, merge or deploy.
Production release remains **HELD**. F5 is the only open defect from this pass.
