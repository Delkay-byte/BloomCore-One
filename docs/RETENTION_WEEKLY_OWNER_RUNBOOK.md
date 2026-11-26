# Weekly retention runbook — MaaCash owner

Run every **Monday, Africa/Accra time**. Ghana uses UTC+0 with no daylight saving.
No cron job is provisioned. This is a manual weekly action.

The agent that prepared this runbook **did not run the production retention sweep**.
No production record was read, changed or deleted during preparation. All local
proof used disposable synthetic data.

## Checklist — do these in order

1. [ ] Confirmed this is the intended Monday weekly run, not a retry from another day.
2. [ ] Confirmed the deployed release matches this script version.
3. [ ] Confirmed I am deliberately selecting the production target.
4. [ ] Confirmed a current backup or snapshot exists and recorded its evidence.
5. [ ] Confirmed I have access to the production runtime environment.
6. [ ] Confirmed the runtime has the correct retention configuration.
7. [ ] Confirmed no local-test configuration is present in the execution shell.
8. [ ] Ran the read-only preview and read every count.
9. [ ] Checked every stop condition. Escalated anything unexpected.
10. [ ] Ran the execution command once. If a second run is attempted, expect HTTP 409 from the database-backed lease.
11. [ ] Recorded the execution result and re-ran the preview.
12. [ ] Completed the weekly operations log at the bottom.

## What this does, in plain language

MaaCash keeps risk signals for a limited time. Old "open" signals are marked
"expired" after 180 days. Expired, withdrawn or resolved signals have their
identifying details removed 90 days later. Disclosure records are de-identified
after 24 months. A legal hold can stop deletion. Each sweep writes an audit row.

The **preview** only counts what would happen. It changes nothing.
The **execution** applies those changes. It needs a secret token. That token must
never be typed into chat, a document, a ticket or a screenshot.

## Prerequisites

- Access to the MaaCash repository at the deployed release commit.
- Access to the production runtime environment where the retention token is set.
- Node.js 22 or newer and installed dependencies (`npm ci` already done).
- A current backup or snapshot with recorded evidence.
- Permission to make an operational data change. No other staff approval is assumed.

Before the first production preview on a machine, the generated Prisma client must
match the database provider. The script checks this and will print a safe error.
For a postgres preview, generate the postgres client first with
`npm run db:generate:pg`. For local SQLite tests, use `npm run db:generate`.
This regenerates code only; it does not touch data.

## Pre-run checks

| Check | How to satisfy it | Evidence to record |
| --- | --- | --- |
| Intended weekly run | Confirm today is Monday and no sweep has already run this week. | Date and week in the log. |
| Compatible version | The script must be the one documented in `docs/RETENTION_SCRIPT_VERIFICATION.md`. Confirm the deployed commit matches the repository copy. | Commit reference in the log. **UNVERIFIED** by the agent; owner must confirm. |
| Deliberate production selection | A postgres preview requires an explicit deliberate-selection environment flag. Set it only when I intend to inspect the production database. | Time and operator in the log. |
| Backup / snapshot | A usable snapshot or backup must exist before execution. Record its reference and creation time. If no fresh evidence exists, **STOP**. | Snapshot reference and time. The agent did **not** create a fresh snapshot. A prior reference is recorded in `docs/PRODUCTION_ENVIRONMENT_CONFIGURATION.md`; its freshness for this Monday is **UNVERIFIED**. |
| Access | I can reach the production runtime environment and can run the command there. | Operator name. |
| Correct config | The runtime must have `MAACASH_APP_URL` (or `SITE_URL`) and `RISK_RETENTION_TOKEN`. Preview uses `RETENTION_PREVIEW_DATABASE_URL` and, for postgres, the deliberate-selection flag. | Names only. Never record values. Token still valid: **UNVERIFIED** by the agent; format was checked previously only. |
| No local-test config | The execution shell must not be a local SQLite test setup. Do not run the execution command against a `file:` database. Do not reuse test variables for execution. | Confirmation tick. |

## Step 1 — exact preview command

Set the preview target in the shell you use. Use a `file:` SQLite URL only for a
disposable local database. Use the production PostgreSQL URL only for a deliberate
read-only production preview. Never paste either value into chat or documents.

Then run this exact command:

```
node scripts/run-risk-retention-cron.mjs --dry-run
```

Help is available with:

```
node scripts/run-risk-retention-cron.mjs --help
```

The preview prints one line with these counts:

| Field | Meaning |
| --- | --- |
| `expiredCandidates` | Open signals that would be marked expired. |
| `scrubCandidates` | Signal rows that would have identifiers removed. |
| `auditCandidates` | Disclosure rows that would be de-identified. |
| `holdsSkipped` | Rows protected by an active legal hold, including a live extension. These rows are not deleted. |
| `legalHoldReviewCandidates` | Holds needing review after case closure. One notice per closure is generated now. |
| `scrubBatchLimited`, `auditBatchLimited` | True means 500 rows were reached; more remain. The window is now stable, so a second run clears the exact remainder. |

No identifiers, row values, token or URL are printed. Preview makes zero database
writes. This was proven locally; see `docs/RETENTION_SCRIPT_VERIFICATION.md`.

### Stop conditions after preview

Stop and escalate to the engineer/owner; do **not** execute if:

- any count is unexpectedly large or differs sharply from last week;
- `holdsSkipped` is greater than zero: the hold is now honoured correctly, but a
  person must still review it. Do not force deletion. Record the hold reference.
- `legalHoldReviewCandidates` is greater than zero: a person must review the case.
  The duplicate-notice defect is fixed; the review is still a human action.
- either batch flag is `true` without a plan for a second run;
- the command failed, printed an error, or produced no JSON line;
- the target was not the one I intended.

Defects F1, F2, F3, F4, F5, F6 and F7 are fixed and verified in
`docs/RETENTION_CROSS_PROCESS_LOCK_REMEDIATION.md`. A database-backed lease now
serialises executions across processes and instances. A hard-killed process can
leave a lease that becomes claimable after 10 minutes; this is a documented
bound, not an indefinite block.

## Step 2 — exact execution command

Run once, from the production runtime shell, after all pre-run checks pass:

```
node scripts/run-risk-retention-cron.mjs
```

Only one execution can hold the database lease. An overlapping run returns
HTTP 409 and makes no changes; wait, re-run the preview, then retry once. One
command per operator is still the simplest operating practice, but it is no
longer the safety control. The command prints status, elapsed time and three
counts: `expired`, `scrubbed`, `audited`. It does not print the token or URL.
Authorisation now runs before any write (F7).

If the command fails, it exits non-zero and prints only an error class and elapsed
time. Do not retry blindly. Go to failure handling below.

## Step 3 — post-run verification

1. Compare the execution counts with the preview counts. They should now match
   exactly, including at the 500-row batch edge. Any difference needs review.
2. Re-run the read-only preview:
   `node scripts/run-risk-retention-cron.mjs --dry-run`.
   Expected result: `expiredCandidates`, `scrubCandidates` and `auditCandidates`
   are zero. Remaining hold-related counts may still be non-zero.
3. If either batch flag was `true`, a second execution may be needed. Repeat all
   pre-run checks first, then run the execution command again once.
4. Confirm that an audit row for `risk_intelligence.retention_sweep` was written.
   This step is **UNVERIFIED** by the agent: the exact owner-facing audit view was
   not inspected. Needed to verify: an operator query path or admin screen for
   `AuditLog` filtered by that action name.
5. Confirm no financial or ledger record changed. This sweep does not touch them
   in code, but production confirmation is **UNVERIFIED** by the agent.
6. Record the result in the log template below.

## Failure handling

| Observed result | Meaning | Action |
| --- | --- | --- |
| 403 | Token rejected or absent. | Stop. Check configuration in the runtime environment. Never guess a token. |
| 429 | Rate limit reached (6 per hour). | Stop. Wait for a later window. Re-run preview first. |
| 409 | Another execution held the database lease. | Wait. Confirm no second execution is active. Re-run preview, then retry once. |
| 503 | Token not configured on the service. | Stop. Owner must configure it through the managed environment. |
| Non-JSON response or timeout | Unknown outcome. | Do not assume failure or success. Re-run preview to inspect state, then decide. |
| Preview shows unchanged candidates after a successful execution | Data was not applied. | Stop. Escalate to engineer. Do not repeat repeatedly. |

Never delete records by hand to "catch up". Never run production retention from a
local test database path.

## Weekly operations log template

Copy this block into the operations record each Monday. Names only; no values.

```
Week starting (Monday, Africa/Accra):
Operator:
Deployed commit / script version evidence:
Backup or snapshot reference and creation time:
Deliberate production selection confirmed: yes / no
Config names checked (names only):
Local-test config absent: yes / no

Preview result:
  expiredCandidates:
  scrubCandidates:
  auditCandidates:
  holdsSkipped:
  legalHoldReviewCandidates:
  scrubBatchLimited:
  auditBatchLimited:
Stop conditions reviewed: yes / no
Decision: proceed / stop (reason):

Execution result:
  HTTP status:
  elapsedMs:
  expired:
  scrubbed:
  audited:

Post-run preview:
  expiredCandidates:
  scrubCandidates:
  auditCandidates:
  holdsSkipped:
  legalHoldReviewCandidates:

Audit row confirmed: yes / no / UNVERIFIED
Financial records unchanged confirmed: yes / no / UNVERIFIED
Second run needed: yes / no
Exceptions and escalation:
Sign-off:
```

## Scope statement

The agent prepared the preview mode, the local proof suite and these documents.
The agent did **not** run the production sweep, did not access production data,
did not modify production records, and did not push, merge or deploy. The
production release remains **HELD**.
