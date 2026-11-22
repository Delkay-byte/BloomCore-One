# MaaCash MoMAG / MMAAG readiness — implementation progress

Branch: `feat/maacash-momag-readiness`
Base commit at the start of this programme: `dbc61f8e245cb1eae0093b2a5a02bef6fbd1bcf7`
Production reference `92d6d974…` verified as an ancestor of that commit.
Audit of record: [`docs/audits/maacash-12-feature-completion-gap-audit.md`](../audits/maacash-12-feature-completion-gap-audit.md)

Everything in this document was produced under the local-only restriction: no
push, fetch, pull, PR, merge, deploy, remote CI run, production database access,
production migration, production secret change, live financial transaction, live
AI approval or customer-data access. No security control was relaxed to make a
test pass.

Status vocabulary: **DONE** (implemented, tested, verified) · **PARTIAL**
(implemented in one layer, named gap remains) · **MISSING** (not started) ·
**BLOCKED_EXTERNAL** (cannot be completed without third-party approval or
credentials) · **PENDING_ASSOCIATION_DECISION** (needs MoMAG/MMAAG policy input).

---

## 1. Verification baseline

| Check | Command | Result |
| --- | --- | --- |
| SQLite provisioning rehearsals (4) | `node scripts/verify-sqlite-migrations.mjs` | pass |
| PostgreSQL migration rehearsals (3) | `node scripts/verify-pg-migrations.mjs` | pass — 118 tables, no drift |
| PostgreSQL integration suite | `npm run test:pg` | 10 files / 44 tests pass |
| Unit + integration suite (SQLite) | `npm test` | 143 files / 1613 tests pass |
| TypeScript | `npx tsc --noEmit` | clean |
| ESLint | `npx eslint .` | 0 errors, 118 pre-existing warnings |
| SQLite schema | `npx prisma validate --schema prisma/schema.prisma` | valid |
| PostgreSQL schema | `npx prisma validate --schema prisma/schema-pg.prisma` | valid |
| Production build | `npm run build` | succeeds |
| Browser acceptance, production build | `node scripts/verify-e2e.mjs` | 105 passed (chromium + mobile-chromium) |

All of the above are reproducible from a clean checkout with a disposable
PostgreSQL cluster; see §6 for the exact environment.

---

## 2. Phase 0 — Release and test safety (complete)

### A0.1 PostgreSQL migration compatibility — DONE

Two migrations carried SQLite-only syntax while `migration_lock.toml` declares
`postgresql`, so a fresh PostgreSQL deployment failed at
`20261205_association_foundation` with `P3018 / 42704: type "datetime" does not
exist`. `DATETIME` → `TIMESTAMP(3)` and bare `DECIMAL` → `DECIMAL(65,30)` in:

- `prisma/migrations/20261205_association_foundation/migration.sql`
- `prisma/migrations/20261207_customer_messaging/migration.sql`

The whole chain now applies to an empty database, `migrate status` reports up to
date, and `migrate diff` against `prisma/schema-pg.prisma` is empty.

`scripts/verify-pg-migrations.mjs` keeps this honest with three rehearsals on
throwaway databases:

1. **Fresh chain** — every migration applies, no drift, required tables present.
2. **Existing-data upgrade** — chain applied up to a cut-off, representative
   business/customer/location/user/daily-account rows inserted, remaining
   migrations applied; every value preserved byte-for-byte and a second deploy is
   a no-op.
3. **Recovery and idempotency** — an interrupted `_prisma_migrations` record is
   refused, cleared with `migrate resolve --rolled-back`, then re-applied.

### A0.2 E2E database path — DONE

`scripts/prepare-e2e.mjs` deleted `<repo>/tests/e2e.db` while the runtime
resolved `file:../tests/e2e.db` to a file outside the repository — several stale
copies existed. Preparation and runtime now share
`scripts/test-database-paths.cjs`:

- `assertDisposableDatabase` — positive allowlist (`e2e.db`, `maacash-e2e.db`,
  `test.db`), refuses `dev.db`, `demo.db`, `prod.db`, `production.db`,
  `neondb.db`, `maacash-roadmap-dev.db`, requires `.db` and a path under
  `<repo>/tests` or the OS temp directory.
- `resolveE2eDatabasePath` / `e2eDatabase` / `unitDatabase` / `sqliteUrlFor`.

`playwright.config.ts` and `vitest.config.ts` import the same resolver, so the
two paths cannot drift again.

### A0.3 Stale E2E assertions — DONE

| Spec | Why it was stale | Repair |
| --- | --- | --- |
| `correction.spec.ts` | correction now requires step-up | fills the `#reauth-password` field in the dialog; step-up itself unchanged |
| `momo-workflow.spec.ts` | bounded best-effort `/api/auth/me` reads exist by design; shortage submit needs an explanation | blocks the endpoint and proves server-resolved first paint, then asserts a bounded count; fills `#reconciliation-note` and the opening reason |
| `role-workflows.spec.ts` | banner + toast duplicate the same status; statement label is “Contribution”; sign-out is a dialog | `.first()` on status, corrected label, `openSignOutMenu()` helper |
| `maacash-landing.spec.ts` | sign-in path comes from `BUSINESS_LOGIN_PATH` | widened href assertion, documented |
| `maacash-dual-role-switch.spec.ts` | offline panel copy changed | asserts the current copy |
| `platform.spec.ts` | `useConfirm` renders `role="alertdialog"` | `alertdialog` in all four assertions |
| `maacash-improvements-evidence.spec.ts` | delete flow is an in-app modal | `exact` button name, `alertdialog`, `Delete` / `Keep conversation` |
| `maacash-draft-persistence.spec.ts` | the seeded day needs an opening explanation, and the local autosave indicator was being accepted as proof of a server write | fills the explanation; asserts the server confirmation (`Draft saved successfully. Last saved at …`) and never the device-local indicator; the failure case now uses a real server rejection and proves the values survive and the retry succeeds |

The master-switch spec also restores the platform-wide Zeli switch in
`afterAll` (via `e2e/zeli-availability-restore.ts`), so one failure can no longer
leave every tenant without Zeli for the rest of the run.

Result: `node scripts/verify-e2e.mjs` → **89 passed, 0 failed** across the
`chromium` and `mobile-chromium` projects.

### A0.4 PG tests inside the release gate — DONE

- `scripts/pg-safety.mjs` requires `PG_DATABASE_URL` (never `DATABASE_URL`),
  `PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`, a loopback host, a database name
  matching `maacash_test*`, and refuses Neon/Render hosts, `NODE_ENV=production`
  and Render environment variables.
- `scripts/prepare-pg-db.mjs` applies the migration chain to that database.
- `scripts/ensure-prisma-client.mjs` regenerates the Prisma client when the
  generated datasource provider (sqlite/postgresql) does not match the run,
  which removes the `Driver Adapter … is not compatible with the provider`
  failure mode that made mixing the two suites unreliable.
- `npm run test:release` → `scripts/verify-release.mjs`: schema, sqlite
  rehearsals, pg rehearsals, unit suite, pg suite, typecheck, lint, production
  build, browser acceptance (`--skip-e2e` / `--only` supported).

### Phase 0 incidental repairs

- `eslint.config.mjs` registered `react-hooks/set-state-in-effect` without the
  plugin in the same flat-config object, so ESLint 9 refused to run at all. The
  plugin is now carried over from `eslint-config-next`, and `**/*.cjs` is allowed
  to use `require()` (Playwright loads those helpers directly).
- `prefer-const` and unused-import defects introduced during this work fixed.

---

## 3. Requirement register — Priority A

**5. Provider statement CSV importer — DONE.**
`src/lib/provider-statement.ts` parses CSV with BOM/quote/CRLF handling, detects
header synonyms, converts amounts to integer pesewa and rejects three-decimal
values, accepts only explicit date formats, derives direction, fingerprints each
row with SHA-256 and matches reference-first with a 15-minute amount-and-time
window that resolves ambiguity to `null`. `src/lib/actions/provider-statement.actions.ts`
imports under a Momo administrator, refuses a duplicate file, stores every row
with its own verdict, offers manual match/unmatch that can never set
`provider_confirmed`, and audits each import with `financialMutation: false`.
The `/admin/reconciliation` screen imports a file, shows per-line verdicts with
totals, and lets an operator pair a line with an internal record only after
seeing the candidates. Tests: `tests/provider-statement.test.ts` (14) plus the
browser flow in `e2e/maacash-reconciliation.spec.ts` (auto match, duplicate file
refusal, manual match, manual unmatch, and the statement that the internal record
stays unconfirmed).

**6. Branch liquidity snapshot — DONE.**
`BranchLiquiditySnapshot` / `BranchLiquidityLine` record the declared opening and
the counted close for cash and each network float. The server derives the
transfer adjustment from the transfer records for that day, so a browser can
never submit its own adjustment; a short line always needs an explanation even
when the net is balanced; reviewed snapshots are final. `/admin/liquidity`
renders the board per branch with declared, transfer-adjusted, expected, counted
and variance columns, an explanation field, save/submit/review actions, a
review note, and totals per branch and across branches. It also handles the
race where a slow board refresh would otherwise overwrite figures the operator
had just typed. Tests: `tests/reconciliation-liquidity.test.ts` (19) and the
browser flow that is refused without an explanation and then accepted with one.

**7. Unified reconciliation exception case — DONE.**
`ReconciliationExceptionCase` / `…Link` / `…Event` cover provider statements,
branch liquidity, transfers, remittances, shifts and daily closes with a case
number (`REC-YYYY-NNNN`), category, severity, owner, due date, evidence,
resolution and an append-only timeline. Transitions and resolution reasons are
enforced server-side; duplicate record links are refused; closing a case never
touches a financial record. `/admin/reconciliation/exceptions` provides the
queue with status filters and ageing, owner assignment, notes, evidence, record
linking, the resolution panel and the timeline. A reviewed short liquidity
snapshot opens a case automatically with the snapshot linked, and the browser
test follows that case from the review button to the queue.

**8. Partial transfer settlement — DONE.**
`settlePartialTransfer` accepts a sanctioned partial receipt only from
`variance_investigation` or `disputed`, refuses an amount at or above what was
dispatched, and either creates a draft follow-up transfer for the remainder or
writes the shortfall back, with step-up only when the tenant requires it for
approvals. The transfer detail screen shows the settlement panel, asks for the
password again at the server's high-value threshold, and displays the settled
amount, outstanding balance, settler and a link to the follow-up (or back to the
original from the follow-up). Tests cover follow-up versus write-back, double
settlement and worker denial.

**9. Branch asset/close reconciliation view — DONE.**
The liquidity board is that view: declared, transfer-adjusted and counted
figures per pocket with the variance, plus the daily close difference for the
branch when a daily account exists for the same day.

**10. Tenant shift policy — DONE.**
`TenantOperationalPolicy` holds the business's own rule, written only by an
administrator through `/admin/policy` and audited with the previous and new
values. When shifts are required, `submitDailyAccount` refuses with a plain
explanation unless the same employee has a **closed** shift for the same branch
and business day; another employee's closed shift does not satisfy it.
`tests/employee-accountability.test.ts` covers the refusal, the acceptance, the
wrong-employee case and the administrator-only write.

**11. Shift revision/correction — DONE.**
`ShiftRevision` records the figures before and after, the fields changed, the
reason, the requester and the approver. `correctClosedShift` works only on a
closed shift with no open handover variance, refuses an unchanged count, requires
a reason of at least ten characters and fresh proof of identity, and keeps the
shift closed. The shift detail screen shows the correction panel and the revision
history. Tests cover the successful correction, the preserved original, the audit
event and the three refusals.

**12. Shared-device actor proof — DONE.**
When the policy is on, submitting the outgoing shift count or the daily close
requires the actor's own password, presented as a single-use step-up grant bound
to that shift or daily account (`finance.shift_count.submit`,
`finance.daily_close.submit`). The worker screens ask for the password only after
the server refuses, so the browser never decides the rule. Tests prove the
refusal, the acceptance with a bound grant, and that replaying the same grant
against another record is refused.

**13. Offline withdrawal request — DONE.**
A withdrawal captured while offline is stored on the device as a request and
sent to `/api/offline/sync-request` on reconnect. That route posts **nothing**: it
validates the capture, scopes it to the session's business and the enrolled
device, binds it to the exact normalized payload through its idempotency key, and
stores an `OfflineActionRequest`. Only an administrator decision on
`/susu/admin/offline-requests` runs the real withdrawal action.

**14. Offline remittance capture — DONE.**
A collector can record the cash they are handing in while offline. It syncs as a
request for the same reason: the office confirms the amount, so the ledger only
changes when an administrator records the handover. That recording goes through
the existing `recordRemittance` action, including its idempotency key, request
hash, ledger lock and variance rules.

**15. Offline reversal/correction request — DONE.**
A reversal request carries the record type and id and a written reason of at
least ten characters, and never an amount. Authorising it runs
`reverseWithdrawal` or `reverseContribution`, which keeps their own step-up and
dual-control requirements; when those refuse (for example because a second
approver is required), the request moves to `needs_review` with the server's own
reason rather than being retried blindly.

**16. Offline MoMo daily-account draft — resolved by removal.**
`daily_account_draft` was a queue type with no sync route and no UI, so it could
only accumulate unreachable records. It is removed and the queue type list now
names exactly what can happen: a contribution that posts, or a request that waits
for authorisation.

**17. Conflict-review queue — DONE (server-side).**
Every refused authorisation becomes `needs_review` with the domain action's own
message, and the queue has a dedicated view for it. A replayed key with a
different payload cannot rewrite the stored request: the digest is part of the
stored key. The device-side classification of a queue entry that a person must
resolve already exists and is reused unchanged.

**18. Shared-device lock policy — DONE.**
`TenantOperationalPolicy.offlineIdleLockMinutes` (1–120, default 15) is saved from
`/admin/policy` and applied to the offline workspace by the bootstrap before the
device holds any data. The background lock stays at five minutes regardless, and
a different user's scope cannot reuse an unlocked key. The read is deliberately
non-redirecting: a background refresh must never navigate the tab.

**19. WhatsApp consent management — DONE.**
Consent is per channel, per number, with opt-in and opt-out timestamps and an
audit entry. Opting in from the portal is no longer enough on its own: the
channel stays `unverified` until a six-digit code sent to that number comes back.

**20. WhatsApp templates — DONE.**
`MessagingTemplate` holds a business's templates with a provider approval state
(`draft`, `approved`, `rejected`) per channel and purpose. `/admin/messaging`
registers them and records who approved one and when. The queue only sends with
an approved template and refuses otherwise rather than falling back to free text.

**21. Durable outbox — DONE.**
Unchanged in shape and strengthened in use: a row is written in the same
transaction as the financial event, the recipient is encrypted, the event key is
unique, and a business refusal stops the row with a reason instead of retrying
something only a person can change.

**22. Message generation — DONE.**
Receipts carry amount, currency, reference, account and status, and never a PIN,
OTP or balance disclosure. Proof codes are sent through the provider adapter
directly, are stored only as a hash, and are deliberately not written to the
outbox.

**23. Provider abstraction and live delivery — DONE in code, BLOCKED_EXTERNAL in
production.** No credentials exist in this environment and
`PRODUCTION_PROVIDER_APPROVED` remains false, so nothing is sent. A provider that
cannot deliver reports `simulated`, never `delivered`; the outbox, the status
ledger and the browser suite all keep that distinction.

**24. Delivery status, retries and scheduling — DONE.**
Signed, idempotent status callbacks exist for both channels
(`/api/webhooks/whatsapp` and `/api/webhooks/sms`), and a failed status now also
records its reason on the row. `runMessagingDispatch()` makes one bounded pass
over due rows across businesses and is triggered by
`/api/internal/messaging/dispatch`, which refuses to run without its shared
secret. Its summary reports `accepted` and `simulated` separately, because a
message that was never really delivered must not be counted as delivered.

**Consent proof (audit 5.17) — DONE.** `MessagingConsentChallenge` stores a
hashed six-digit code with a ten-minute expiry, a five-attempt cap and single
use. Re-requesting supersedes the old code, changing the number invalidates a
code already sent, and an undeliverable code is discarded rather than left
usable. `whatsappVerifiedAt`/`smsVerifiedAt` and the verification method are
recorded, and only a verified number can receive a receipt.

**Tenant configuration (audit 5.11) — DONE.** `TenantMessagingConfig` holds the
per-business switches, template name and language, and SMS sender ID.
`decideMessagingDelivery` is the single decision point used by both the delivery
worker and the settings screen, so the screen cannot promise delivery the queue
would refuse. The platform gate stays in the provider adapter, which still
requires credentials, the explicit delivery switch and the allowlist.

**25. Multiple-account selector — DONE.**
`getCustomerAccount(accountId?)` returns every active account in a stable order
with the requested one first, so a customer with two accounts chooses which one
the dashboard, balance and cycle figures describe. An id the customer does not
own falls back to the first account rather than erroring or leaking.

**26. Customer withdrawal request and tracking — DONE.**
`CustomerWithdrawalRequest` stores the amount in **integer pesewa** and a written
reason. The customer can raise one request per account, sees it waiting, and can
cancel it while no decision has been made. The request checks the cycle balance
(contributions − withdrawals − commissions) and any money already reserved, so a
customer cannot queue more than the account holds. Approval runs
`processWithdrawal` with the operator's step-up grant, which keeps the commission
rule, the account lock and the receipt enqueue exactly as the counter does; a
refusal leaves the request open with the domain action's own reason.

**27. Printable statement / PDF — DONE.**
`/customer/statement/print` renders the same statement action as a document —
entries, running balance, closing balance and a footer that says it is not a bank
statement — with a print stylesheet and a "Print or save as PDF" button. CSV stays
available next to it.

**28. Verified self-service recovery — resolved by keeping the boundary clear.**
Recovery stays administrator-assisted by decision, and that is now the only path:
the portal verifies a number it will send to, but it cannot reset a password by
itself. The progress note states this as the intended control rather than an
outstanding gap, because a self-service reset without an independent channel would
be a weaker control than the assisted one.

**29. Evidence file storage — DONE.**
`EvidenceAttachment` keeps the metadata (name, type, size, SHA-256, retention,
uploader) while the bytes live in a private directory outside the web root,
configurable through `EVIDENCE_STORAGE_DIR`. Upload re-checks the subject, so a
customer can only attach to their own dispute and an administrator only within
their business. A file is served by `/api/evidence/[id]`, which re-resolves the
caller, verifies the stored bytes still match the recorded digest and audits the
access. Disposal is refused inside the retention period and while the dispute is
still open.

**30. Dispute assignment, SLA and correction verification — DONE.**
A dispute now carries an owner, a priority (`low`, `normal`, `high`, `urgent`), a
due date derived from the priority, and an escalation record. The office queue
shows overdue items, and escalation raises the priority to urgent with a reason
that appears on the timeline and in the notification feed. An upheld outcome is
now refused unless its correction reference matches a real reversal row for the
same subject, so a dispute cannot be closed on an invented reference.

**31. Association entity and membership link — DONE.**
`Association` is a first-class entity with its own code, name, region, status and
charter version, and `AssociationMember` now carries `associationId` and `zoneId`
as nullable links. Existing tenant-wide register rows keep working unchanged, and
a business can host more than one association.

**32. Zones, chapters and hierarchy — DONE.**
`AssociationZone` belongs to one association and can point at a parent zone, so a
region can contain districts without a new table. A zone code is unique inside its
association, and a parent must belong to the same association.

**33. Association roles and permissions — DONE.**
`AssociationRoleAssignment` grants `association_admin`, `zone_officer`,
`member_viewer` or `auditor`, and the capability table is enforced server-side:
a zone officer may manage members but not governance or roles, an auditor and a
member viewer may only read. Revoking the last association administrator is
refused so the role can always be granted again. Creating the first association is
the one bootstrap step a business administrator may take, because that is how the
roles come to exist; after that only an association administrator can manage it.

**34. Consent and governance records — DONE.**
`AssociationConsentRecord` covers a membership agreement, a data-sharing consent
or an access review, with expiry and withdrawal as first-class state. A consent
counts only while it is granted, unexpired and not withdrawn, evaluated at read
time so a lapsed consent stops counting without a job. Withdrawal requires a
written reason and is audited.

**35. Association reports and exports — DONE.**
Members, zones, sponsorships, training and consent export as CSV from
`/api/association/export?type=…`, built by the same tenant-scoped action the screen
calls. The export cannot carry another business's rows, and consent exports show
each record's live state.

**36. Association pilot dashboard — PENDING_ASSOCIATION_DECISION.**
The data and controls exist; the shape of the MoMAG/MMAAG pilot dashboard (which
roles see which reports, and the regional roll-up they expect) is a client
decision. It is recorded as pending rather than guessed.

**37. Courses, modules and learning materials — DONE.**
`TrainingCourse` carries the completion criteria (pass mark, required attendance,
certificate validity, evidence retention) and `TrainingModule` holds the ordered
learning units with optional written content and an https-only resource link. A
course cannot be published without at least one module.

**38. Enrolment and attendance — DONE.**
`TrainingEnrolment` binds a learner (an association member contact or a staff
user, never both and never neither) to a published course. `TrainingSession` is a
scheduled, held or cancelled session and `TrainingAttendance` records the minutes
each learner actually attended, unique per session and learner. Attendance is
measured against **sessions that were held**, so a cancelled session cannot lower
anyone's percentage.

**39. Assessment, attempts and pass criteria — DONE.**
`TrainingAssessment` holds the maximum and pass marks; every
`TrainingAssessmentAttempt` is stored with its computed `passed` flag. A learner
is completed only when the attendance percentage and the best attempt both meet
the course criteria, and the blocking reasons are returned in words. Nothing in
the API lets a caller assert "completed".

**40. Certificate issue, expiry, revocation and verification — DONE.**
A certificate is issued only from a completed enrolment, carries a readable
serial, a random verification token, an expiry derived from the course validity
and a retention date. Revocation requires a reason and is audited. The public page
`/verify/certificate/[token]` reports issued, expired, revoked or unknown and
shows only the course, serial, dates and a **masked** holder name — no contact
details.

**41. Learner transcript and association reporting — DONE.**
`getLearnerTranscript` returns every course, attendance percentage, best score and
certificate state for one learner, and the training desk shows the same figures
per enrolment with the blockers that remain.

**42. Retention and evidence policy — DONE.**
The course defines how many years of learner evidence are kept; a certificate's
`retainUntil` is set from it at issue. Evidence files for a learner reuse the
`EvidenceAttachment` store from A5 (private directory, SHA-256, retention,
authorised download), so there is one retention rule rather than two.

**Certification standards (audit 10.13) — PENDING_ASSOCIATION_DECISION.**
Required competencies, who may act as an assessor and the certificate format are
association decisions. The model stores what an assessor records and who issued
what; it does not invent a competency framework.

**43. Sponsor entity and eligibility — DONE.**
`Sponsor` is an entity (name, kind, contact, optional tax id, optional own
business, optional yearly cap) unique by name inside the business, so a
sponsorship is a link between two identities rather than free text. Creating an
agreement refuses an inactive sponsor, an inactive member, a sponsor funding its
own business and a duplicate live arrangement for the same member and plan.

**44. Funding allocation and limits — DONE.**
`SponsorshipFunding` is an append-only ledger of integer pesewa: an `allocation`
adds, a `release` subtracts, and one movement is one row that is never edited.
Each movement is checked against the sponsorship cap, the sponsor's yearly cap,
the funded-so-far total and, for a release, that the money was actually funded. A
fractional pesewa is refused.

**45. Link to subscription entitlement — DONE.**
`SponsorshipCoverage` assigns funded money to a covered business and a period
(1–36 months), and only up to what is funded but unassigned.
`getSubscriptionSponsorshipCoverage(businessId)` is the read the billing
lifecycle uses; it returns cover state, end date and amount and never the
sponsor's identity.

**46. Expiry, renewal and release — DONE (refund accounting is a decision).**
Coverage is live only while active and inside its period, so cover expires
without a job that could silently extend it; renewing means recording a new
period. Money returned to a sponsor is a `release` row with a reason-carrying
reference. Tax treatment and credit notes are not invented here.

**47. Abuse controls — DONE.**
Duplicate sponsor names, self-sponsorship, ineligible members, duplicate live
arrangements, over-cap funding, over-yearly-cap funding, releases larger than what
was funded and reused funding references are each refused with a sentence naming
the control. Every decision is re-checked against the database inside the action,
not trusted from the form.

**48. Ownership separation and reporting — DONE.**
The sponsorship belongs to the association's business; the covered business keeps
ownership of its own subscription and data, and the coverage row is the only link.
The screen reports agreed, funded, released, covered-until and unassigned as
separate figures, per sponsor and per sponsorship, so an agreement can never read
as paid cover.

**Sponsorship funding policy (audit 9.13) — PENDING_ASSOCIATION_DECISION.**
Sponsor eligibility criteria, refund rules, caps and who bears liability are
association decisions. The register enforces the limits it is given and records
what happened; it does not set policy.
**49. Finding event history — DONE.**
`AnomalyFindingEvent` is append-only: detection, a rescan that changed the
evidence, assignment, notes, checklist steps, a closure, a false-positive
disposition, a reopening and a suppression each leave a row with the severity,
metric, threshold, evidence and a SHA-256 snapshot hash. A finding also keeps
`firstSeenAt`, its last `snapshotHash` and a `reopenCount`. A rescan that changes
nothing appends nothing, so history stays readable rather than a heartbeat.

**50. Investigation case — DONE.**
`AnomalyInvestigation` holds the owner, status (open, investigating, waiting for
evidence, closed), an SLA due date from the finding's severity (2, 5 or 10 days),
a disposition and the correction that fixed the record. The default checklist is
created with the investigation so "checked" is a recorded step
(`AnomalyInvestigationTask`), comments are append-only
(`AnomalyInvestigationComment`), and a genuine disposition is refused unless its
correction is a real row in this business.

**51. False-positive disposition and rule tuning — DONE.**
Closing as a false positive records the reason and can create an
`AnomalySuppression` for that rule and record, with a reason, a maximum of 180
days and a revoke path that needs its own reason. A whole-rule suppression is
also possible. Suppressions are listed with their expiry, so a quiet rule is
visible rather than forgotten, and a suppression never deletes the findings it
covers.

**52. Continuous scan with ownership and alert fatigue — DONE.**
`POST /api/internal/anomaly/scan` is the scheduled trigger: it needs
`ANOMALY_SCAN_TOKEN` (503 until set, 403 without it), scans businesses in bounded
batches, and records every attempt in `AnomalyScanRun` with trigger, counts and any
error. Alerts are capped: only newly created **high** findings notify, at most 3
per scan, never the same finding twice inside 24 hours, and never a suppressed
one — and the notification itself is de-duplicated by key.

**53. Source snapshot, hash and reopening — DONE.**
Each finding stores the hash of the exact evidence it was last seen with, and each
event keeps the hash it was recorded under. A closed finding that a later scan
detects again reopens automatically (status open, `reopenCount` incremented, a
`reopened` event with the note that the condition persisted) unless an unexpired
suppression covers it. Closing therefore cannot make a real problem invisible.
**54. Cash, float and liquidity metrics — DONE.**
`computeCashPosition` puts three different facts side by side without adding them
up: the newest declaration per asset type (with float split by network), settled
transfers in and out inside the period, and the last reported closing cash/float
plus the sums of the recorded close variances. A declaration that disagrees with
the last close is reported as a difference, a declaration older than seven days is
listed as stale, and a branch that never declared says so instead of showing zero.

**55. Completeness and late records — DONE.**
`computeCompleteness` counts expected branch-days (every day × every active
branch), submitted closes, the missing dates themselves, closes submitted more
than a day late, and active operators with no close in the period. A day a branch
was closed by an administrator still counts as expected, so the gap is visible and
explainable rather than silently absent.

**56. Consolidated MoMo report — DONE.**
`/admin/reports/consolidated` renders the position, the flow and the gaps for a
chosen period, and `exportConsolidatedCsv` writes the same figures with the metric
dictionary attached. Both are computed from the records in one pass, so the CSV
cannot disagree with the screen.

**57. Metric dictionary and label review — DONE.**
`src/lib/reporting/dictionary.ts` defines every figure with a formula, its
exclusions and a kind: volume, operational flow, accounting result or position.
Principal is labelled "Money moved (not income)", the accounting figure is "Net
operating result" and states that it is not profit, and a test asserts no label
contains "profit", "revenue", "cash income" or "net cash flow". The Kind column
renders those words rather than the enum, so the screen and the dictionary agree.

### Phase 1 schema and migration

Both Prisma schemas carry the new models and validate
(`ProviderStatementImport`, `ProviderStatementRow`, `BranchLiquiditySnapshot`,
`BranchLiquidityLine`, `ReconciliationExceptionCase`, `…Link`, `…Event`, plus the
`BranchTransfer` settlement fields and follow-up relation).
`prisma/migrations/20261209_phase1_reconciliation_foundation/migration.sql` and
`prisma/migrations/20261210_employee_accountability/migration.sql`,
`prisma/migrations/20261211_offline_action_requests/migration.sql`,
`prisma/migrations/20261212_tenant_messaging_config/migration.sql`,
`prisma/migrations/20261213_portal_withdrawals_evidence/migration.sql`,
`prisma/migrations/20261214_association_governance/migration.sql`,
`prisma/migrations/20261215_training_certification/migration.sql`,
`prisma/migrations/20261216_sponsored_subscriptions/migration.sql`,
`prisma/migrations/20261217_anomaly_investigation/migration.sql`,
`prisma/migrations/20261218_ai_investigation_drafts/migration.sql`, generated with
`scripts/make-pg-migration.mjs` (local host only, throwaway database,
refuses non-loopback targets), keep PostgreSQL deployments, which use
migrations, in step with SQLite, which is provisioned with `prisma db push`.

Label constants used by both the server and the browser live in
`src/lib/provider-statement-labels.ts`, because a client component that imported
the parsing module directly would pull `node:crypto` into the browser bundle.

---

## 4. Zeli AI explanation and investigation layer — Priority C

**C0 prerequisites — DONE.**
- **Evidence schema.** `src/lib/zeli/investigation/evidence.ts` defines the pack an
  explanation may see: finding id, rule, severity, status, detected/last-seen
  timestamps, the measured value with its threshold and unit and the rule's
  calculation, approved source references with a SHA-256 hash per source, role
  labels and a pseudonym instead of a person, and explicit `missingEvidence` and
  `limitations` lists. The pack itself is hashed, and a pack that carries a
  phone, email or name field is refused rather than silently redacted.
- **Response schema.** `schema.ts` requires `findingId`, `schemaVersion`,
  `promptVersion`, `facts[]`, `hypotheses[]` (low or medium confidence only),
  `missingEvidence[]`, `timeline[]`, `investigationQuestions[]`, `nextSteps[]`,
  `limitations[]` (at least one) and `modelMetadata` with `advisoryOnly: true`. A
  draft is rejected for an unknown finding id, an unapproved citation, a value that
  was not measured (in a `values` array or in prose), malformed JSON or a missing
  limitation.
- **Timeline service.** `buildEvidenceForFinding` reads only the finding's own
  source record plus its finding events and investigation, all tenant-scoped; the
  timeline carries descriptions derived from allow-listed fields, not free text,
  because a note can contain a person's name.
- **Review state machine.** `decideReview` allows draft to reviewed, accepted or
  rejected with a mandatory reason, refuses a decided draft, refuses self-review,
  and returns `affectsFinding: false` on every path.
- **Retention, redaction and access.** Drafts store the evidence pack and its hash
  beside the payload; only tenant administrators reach them; the pack is the only
  data an external provider would receive, and it is stored with every draft so a
  review can be re-checked later.

**C1 implementation — DONE.**
`buildEvidenceForFinding` and `generateDraftForEvidence` produce a draft,
`generateInvestigationDraft` stores it with a finding event and an audit row, and
`reviewInvestigationDraft` records the decision. The prompt and schema versions are
constants (`anomaly-explanation-p1`, `anomaly-draft-v1`). The external provider is
refused by `PRODUCTION_INVESTIGATION_APPROVED = false`, so generation is
deterministic today and a draft says so in its own `modelMetadata`. That
deterministic explanation **is** the fallback, so there is no state in which the
screen shows nothing. `ZELI_INVESTIGATION_DISABLED=1` is a single kill switch that
refuses generation. The desk renders facts, hypotheses, missing evidence,
limitations, the timeline and the evidence hash, with Accept and Reject plus a
reason, and states that neither decision closes the finding.

**C2 security tests — DONE.**
`tests/zeli-investigation.test.ts` (25 tests) covers the ten required cases: schema
rejection for unknown finding ids, unapproved citations, unmeasured values and
malformed JSON; injection text in a branch name being treated as data; cross-tenant
finding and evidence access; PII minimisation asserted on the exact payload;
numeric grounding including prose; hallucinated source references; mandatory human
review with a non-author reviewer; kill-switch and provider-disabled fallback; audit
completeness (finding id, evidence hash, prompt and schema version, decision, and
`findingChanged: false`); and evidence tampering being refused at review.

**C3 approval — granted only as the narrow, paid, per-business package described in
C4.** The former `PRODUCTION_INVESTIGATION_APPROVED` constant is replaced by
`AI_INVESTIGATION_CODE_APPROVED = true` plus the ordered entitlement decision, which
is what the owner approved. It is *not* a general approval: the runtime still refuses
external calls in tests, a business still needs a confirmed payment and a Super Admin
activation, and `PRODUCTION_CONVERSATION_APPROVED` and `PRODUCTION_PROVIDER_APPROVED`
remain `false`. The `ZELI_EXTERNAL_AI_DISABLED` / `ZELI_INVESTIGATION_DISABLED`
switches still stop the whole feature for the deployment.

Provider gates are unchanged and still off: `PRODUCTION_PROVIDER_APPROVED=false`,
`PRODUCTION_CONVERSATION_APPROVED=false`. No AI provider credential is present in
the browser or the E2E environment (`scripts/e2e-env.cjs` blanks
`PAYSTACK_*`, `DEEPSEEK_*`, `ZELI_TEAM_TESTING_*`, `WHATSAPP_*`, `RESEND_API_KEY`
and `PLATFORM_OIDC_*`, and forces `PAYSTACK_ENABLED=false`,
`PLATFORM_OIDC_ENABLED=false`).

**C4 paid AI Investigation package — DONE (owner-approved scope).**
The owner approved external AI processing of real financial evidence for a business
that has bought the dedicated AI Investigation package. That approval is implemented
as an *entitlement*, not as a global switch.

- **Data model.** `AiInvestigationEntitlement` (one row per business: package code,
  subscription and plan reference, activation actor, activation time, expiry, reason,
  revocation actor/time/reason) and `AiInvestigationUsage` (requests per calendar
  month with the allowance frozen on the row), plus `ZeliPlan.addonKey` so a paid
  package is identifiable rather than matched by name. Migration
  `20261219_ai_investigation_package`; both Prisma schemas kept identical.
- **Ordered decision function.** `evaluateAiInvestigationAccess` is pure and denies in
  a fixed order: deployment approval, operator kill switch, business status, role,
  package, provider-confirmed payment, current paid period, activation present,
  activation not revoked, activation not expired, monthly allowance. Each denial
  carries a machine reason and plain-language guidance, so the screen can explain
  what is missing instead of failing opaquely.
- **Server-side resolution.** `resolveAiInvestigationAccess` re-reads the plan,
  subscription, activation and usage on every call. Nothing is trusted from the
  client, and no cached "enabled" flag short-circuits the order above. A tenant
  administrator cannot activate the package: `activateAiInvestigation`,
  `revokeAiInvestigation`, `configureAiInvestigationPackage` and
  `getAiInvestigationAdminState` require a platform session.
- **Payment is not activation, and activation is not payment.** Activation refuses a
  subscription whose `paidAt` is null, whose status is not `active`, or whose paid
  period has ended; the package catalogue refuses a zero price and never invents one.
  Revocation takes effect on the next request, not when a cache expires.
- **Quota.** `consumeAiInvestigationAllowance` increments after a draft is persisted
  and refuses to exceed the allowance; the allowance is copied onto the usage row so a
  later plan edit cannot retroactively raise a month already in progress.
- **Provider.** External generation is attempted only when the entitlement allowed
  *and* the runtime permits it (`externalProviderPermittedForRuntime` refuses test
  runtimes) *and* a credential exists. Failures — timeout, 429, 5xx, malformed JSON,
  schema rejection, ungrounded numbers — fall back to the deterministic draft and
  record `fallbackReason`; a provider that cannot answer never produces a blank desk
  and never produces an unvalidated draft.
- **Unchanged safety.** Accepting a draft still never changes a finding, transaction,
  balance or account (`affectsFinding: false` is asserted inside the transaction).
  AI never makes a fraud determination. `PRODUCTION_CONVERSATION_APPROVED` remains
  `false`; the narrow investigation approval does not widen into a general
  conversational AI.
- **Platform control.** `/platform/zeli` renders the activation board: package,
  confirmed payment and paid period, activation state with actor, monthly usage and
  the next step for each business, with Activate/Revoke behind a required written
  reason and a platform audit row (`ai_investigation.activated` /
  `ai_investigation.revoked` / `ai_investigation.package_configured`) written inside
  the same transaction as the change.
- **Tests.** `tests/ai-investigation-entitlement.test.ts` (27) walks the denial
  matrix — free business, paid non-add-on package, unconfirmed payment, no
  activation, tenant-admin activation attempt, expired period, revoked activation,
  expired activation, exhausted quota, wrong role, suspended business, operator kill
  switch, missing deployment approval — plus cross-tenant isolation, the audit
  payload, and the provider timeout / 429 / invented-evidence fallbacks.
  `tests/zeli-investigation.test.ts` (26) keeps the minimisation, injection,
  self-review and tamper cases green.

**B1 external integration notices — DONE.**
`src/components/ComingSoonBadge.tsx` is the single marker, with an accessible
`aria-label` that reads "… not available yet". It marks MTN, Telecel, AT Money, SMS
live delivery, banking, accounting, external customer identity verification and
customer payment status on `/admin/integrations`, and SMS live delivery on
`/admin/messaging`. WhatsApp is deliberately excluded: the owner is building it, and
the readiness row says so in words rather than labelling it unavailable. Nothing was
placed over working functionality — manual MoMo entry, CSV statement import,
reconciliation, reports and customer access carry no marker, and no page offers a
provider action (`Connect`, `Test send`, `Sync now`) that cannot work.

**B2 WhatsApp configuration audit — DONE.** See
[`docs/audits/maacash-whatsapp-configuration-audit.md`](../audits/maacash-whatsapp-configuration-audit.md).
One defect found and fixed: `scripts/e2e-env.cjs` blanked
`WHATSAPP_WEBHOOK_VERIFY_TOKEN`, but the webhook reads `WHATSAPP_VERIFY_TOKEN`, so a
developer shell exporting the real name could still change the webhook's answer in
the browser suite. Both names — plus the delivery switch, allowlist, dispatch token
and status-webhook secret — are now blanked.

---

## 5. Association-dependent decisions

Still awaiting MoMAG/MMAAG input; no code has been written that assumes an
answer:

- which association body owns membership and whether one business may belong to
  more than one association;
- zone/chapter hierarchy depth and naming;
- who may see member financial data, and under what consent wording;
- sponsorship funding ownership, limits and accounting treatment;
- the association pilot dashboard’s contents and audience.

---

## 6. Local environment used for verification

- Disposable PostgreSQL 18 cluster on port 55441
  (`C:/Users/SAVIOUR/AppData/Local/Temp/maacash-pg2`, `initdb --auth=trust`,
  loopback only). No service database, no production project and no remote host
  was contacted.
- `PG_DATABASE_URL=postgresql://postgres@127.0.0.1:55441/maacash_test_suite`,
  `PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`.
- Browser suite runs a production build against `tests/e2e.db` on port 3101.

---

## 7. Next work, in order

Everything internally implementable is implemented and verified. What remains is
not code:

1. **C3 — external AI approval.** `PRODUCTION_INVESTIGATION_APPROVED`,
   `PRODUCTION_PROVIDER_APPROVED` and `PRODUCTION_CONVERSATION_APPROVED` stay
   `false` until a separate security and financial-evidence review approves an
   external model. The deterministic explanation is what ships meanwhile.
2. **C4 deployment switch for a real package.** The code path is complete and tested;
   what an operator still needs is a Super Admin decision per business (price,
   allowance, expiry) once the package is sold. No live payment was taken and no
   production entitlement was created during this work.
3. **Association decisions** (items 36, 9.13 and 10.13): pilot dashboard audience,
   sponsorship funding policy, and the certification framework. Each is marked
   `PENDING_ASSOCIATION_DECISION` with the model recording facts rather than
   guessing policy.
4. **Final release gate**: the full suite set in §1, a security and tenant review,
   and then — and only then — a discussion about push, PR or deploy. Nothing has
   been pushed, merged or deployed.
