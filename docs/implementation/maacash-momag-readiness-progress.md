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
| PostgreSQL migration rehearsals (3) | `node scripts/verify-pg-migrations.mjs` | pass — 108 tables, no drift |
| PostgreSQL integration suite | `npm run test:pg` | 10 files / 44 tests pass |
| Unit + integration suite (SQLite) | `npm test` | 139 files / 1529 tests pass |
| TypeScript | `npx tsc --noEmit` | clean |
| ESLint | `npx eslint .` | 0 errors, 97 pre-existing warnings |
| SQLite schema | `npx prisma validate --schema prisma/schema.prisma` | valid |
| PostgreSQL schema | `npx prisma validate --schema prisma/schema-pg.prisma` | valid |
| Production build | `npm run build` | succeeds |
| Browser acceptance, production build | `node scripts/verify-e2e.mjs` | chromium + mobile-chromium, all tests pass |

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

**43–48. Sponsored subscriptions — MISSING.**
**49–53. Anomaly investigation — MISSING.**
**54–57. Business intelligence — MISSING.**

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
`prisma/migrations/20261215_training_certification/migration.sql`, generated with
`scripts/make-pg-migration.mjs` (local host only, throwaway database,
refuses non-loopback targets), keep PostgreSQL deployments, which use
migrations, in step with SQLite, which is provisioned with `prisma db push`.

Label constants used by both the server and the browser live in
`src/lib/provider-statement-labels.ts`, because a client component that imported
the parsing module directly would pull `node:crypto` into the browser bundle.

---

## 4. Zeli AI explanation and investigation layer — Priority C

**C0 prerequisites — MISSING.**
**C1 implementation — MISSING.**
**C2 security tests — MISSING.**
**C3 approval — remains not granted.**

Provider gates are unchanged and still off: `PRODUCTION_PROVIDER_APPROVED=false`,
`PRODUCTION_CONVERSATION_APPROVED=false`. No AI provider credential is present in
the browser or the E2E environment (`scripts/e2e-env.cjs` blanks
`PAYSTACK_*`, `DEEPSEEK_*`, `ZELI_TEAM_TESTING_*`, `WHATSAPP_*`, `RESEND_API_KEY`
and `PLATFORM_OIDC_*`, and forces `PAYSTACK_ENABLED=false`,
`PLATFORM_OIDC_ENABLED=false`).

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

1. A8 sponsored subscriptions.
2. A9 anomaly investigation, which is also the prerequisite for C0–C2.
3. A10 BI completion.
4. Final release gate: full suites, production-build browser acceptance, security
   and tenant review, then — and only then — discuss push/PR/deploy.
