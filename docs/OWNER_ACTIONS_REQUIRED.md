> **Dated addendum — 25 November 2026.** Counsel/DPIA/DPO/DPS approval is not a MaaCash requirement, onboarding gate or release gate. Any below reference to it as outstanding is historical and superseded by `docs/privacy/COUNSEL_DPIA_DPO_DPS_REMOVAL_ADDENDUM.md`.

# Owner actions required — MaaCash release readiness

Dated follow-up: 25 November 2026. Original final reports are preserved. No item
below has been performed by the agent. No secret value or customer record appears
here. Production release remains **HELD**.

## Recorded as completed — do not repeat

| Item | Status |
|---|---|
| Password-recovery email receipt | **Owner confirmed received.** Not an outstanding action. |
| Previously exposed Neon API key | **Owner confirmed revoked.** Not an outstanding action. No replacement credential was requested or used. |

The counsel/DPIA item is outside this task's scope and is not listed here.

## Genuinely outstanding

### 1. Weekly manual retention sweep — every Monday, Africa/Accra

Use `docs/RETENTION_WEEKLY_OWNER_RUNBOOK.md`. Do not provision paid cron. Do not
run two shells at once (finding F5 remains open). Start with the read-only preview,
review every count and stop condition, then run the single execution command once.
Verify the audit row and record the weekly operations log. The agent did **not**
run the production sweep.

### 2. Hosting-capacity decision after reviewing local load evidence

Evidence: `docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md`. Local SQLite environment
sustained **50 VUs** with 0 failures; 1,000 VUs were scheduled but not sustained
(3.3% HTTP 200, mass `ECONNREFUSED`). The generator was not saturated. SQLite
writes and the local server were the bottleneck; this is not a Neon or Render
finding. Options for the owner, with no purchase made:

| Option | Cost implication | What it gives |
|---|---|---|
| Keep current Render free plan, single instance | none | Continue pilot-scale use only; make no 1,000-user claim. |
| Approved isolated PostgreSQL rehearsal before any capacity claim | existing local Docker image; no paid service used by this task | Tests connection pooling, locks and query behaviour absent from SQLite. |
| Paid Render plan / multiple instances | recurring cost, not authorised | Would need owner approval and a new controlled test before any capacity conclusion. |

No production plan, instance count, database setting or provider limit was changed.

### 3. Release authorisation

Review `docs/PRODUCTION_RELEASE_READINESS_ADDENDUM.md` and the supporting reports.
Separately authorise any push, merge or deployment. Nothing in this local work
authorises a release. Current decision: **ENGINEERING REMEDIATION INCOMPLETE —
RELEASE HELD**.

### 4. Residual engineering decisions arising from this work

| Item | Why owner attention is needed | Reference |
|---|---|---|
| F5 retention overlap guard is route-level only; simultaneous direct action calls can both scrub | Keep one execution shell at a time, or approve a DB-backed lock with a reviewed migration | `docs/RETENTION_SCRIPT_VERIFICATION.md` |
| Post-write RSC refresh can bounce a real user to `/admin/dashboard` after a successful action | No auth bypass or data exposure, but workflow position is lost. Needs coordinated per-tab session/router work, not an E2E-only change | `docs/E2E_FAILURE_REMEDIATION_REPORT.md` §2 |
| Six deployed-origin E2E checks remain skipped | They require a real deployed origin; they are not critical business/security tests but must be run after any authorised deployment | `docs/E2E_FAILURE_REMEDIATION_REPORT.md` §4 |
| Provider timeout path unverified | No injectable provider endpoint exists; add a staging-only stub if certification is needed | `docs/REAL_WORLD_CONCURRENCY_AND_FAILURE_TEST_REPORT.md` |
| Memory growth during local soak (RSS to ~785 MB) | Profile session/proof cleanup on a longer isolated soak | `docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md` §7 |

## Not outstanding

- No request for credentials, API keys or tokens.
- No request to revoke or rotate the Neon API key.
- No request to confirm password-reset email receipt.
- No request to implement counsel/DPIA work in this task.
- No payment, infrastructure purchase or production change is pending agent action.
