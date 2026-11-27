# Phase 5 — Reconciliation and Exception Management Integration Contract

Status: implemented on `feat/susu-enterprise-phase-5-reconciliation` from baseline
`70735487aa527f0edcab3c4b747a93136d287f77`.

This document is the contract between Phase 5, the existing Susu modules, and
Phase 6 reporting. It describes what the code actually does. It is not a
description of a future design.

## 1. Scope and invariants

Phase 5 adds:

1. Reconciliation sessions and immutable revision history for observed
   differences.
2. Daily collector closing as an operational cash-handover trail.
3. Recommendation-free exception cases with assignment, evidence, due dates,
   escalation, independent approval, resolution, rejection and reopening.
4. Owner and branch visibility over unresolved, overdue, unassigned, escalated
   and pending-sync positions.

Phase 5 does not:

- post, reverse or edit a contribution, remittance, withdrawal, daily account or
  provider-statement row;
- replace the Phase 3 remittance settlement/discrepancy engine;
- approve or pay a Phase 4 withdrawal;
- score a person for fraud. Severity is an operational priority derived from the
  amount at stake, never a risk score;
- close a reconciliation session automatically.

All reads and writes are scoped by tenant on the server. A branch, collector,
owner, case or session id supplied by a client is re-validated against the
database before use.

## 2. Data model

Both `prisma/schema.prisma` (SQLite tests) and `prisma/schema-pg.prisma`
(PostgreSQL runtime) contain the same Phase 5 models and relations. Only the
provider and two PostgreSQL-only indexes differ. The additive migration is
`prisma/migrations/20261229_susu_reconciliation/migration.sql`; no historical
migration was rewritten.

### 2.1 `SusuReconciliation`

| Field | Meaning |
| --- | --- |
| `id`, `tenantId`, `branchId`, `collectorId` | Scope. A null branch is company-wide and only company-wide administrators may operate it. |
| `type` | `daily_close`, `branch_close`, `remittance`, `sync`, `other`. |
| `status` | `open`, `matching`, `matched`, `reviewed`, `case_created`, `closed`. |
| `periodStart`, `periodEnd` | Inclusive UTC business-day bounds. The maximum span is 366 days. |
| `summaryJson` | Financial summary captured by the last run, with `definitionVersion`. |
| `definitionVersion` | `1`. Bump only when a financial definition changes. |
| `runCount`, `lastRunAt`, `lastRunById` | Detection run history. |
| `openedById/At`, `closedById/At`, `closeReason` | Lifecycle actors and reason. A closed session is immutable. |

A session key is the tuple `(tenantId, type, branchId, collectorId,
periodStart, periodEnd)` for a non-closed session. Opening the same key returns
the existing non-closed session instead of creating a duplicate.

### 2.2 `DailyCollectorClosing`

Unique on `(tenantId, collectorId, closingDate)`. `closingDate` is UTC
midnight of the business day.

Lifecycle: `open -> declared -> handed_over -> received -> balanced |
exception`.

Fields:

- `expectedCash`, `contributionsRecorded`: server-recorded, non-reversed
  contributions for the collector on the day.
- `contributionsSynced`: recorded contributions captured offline and accepted
  by the server (`recordedDeviceId` set).
- `contributionsPending`: known amounts still awaiting a successful sync.
- `pendingSyncCount`, `failedSyncCount`: offline transaction and attempt counts
  for the collector/day.
- `declaredCash/At/By`, `declarationNote`, `declarationEvidenceRef`.
- `handoverAmount/At/By`, `handoverEvidenceRef`.
- `receivedAmount/At/By`, `receiptNote`, `receiptEvidenceRef`.
- `varianceExpectedVsDeclared`, `varianceDeclaredVsReceived`,
  `varianceExpectedVsReceived`.
- `outstandingAmount`: `max(expectedCash - receivedAmount, 0)` once received;
  overage is shown separately in the variance.
- `sessionId`, `exceptionCaseId`, `createdById`.

Definitions:

```text
expectedCash              = sum(non-reversed recorded contributions for collector/day)
contributionsSynced       = sum(recorded contributions with recordedDeviceId)
contributionsPending      = sum(known pending/failed offline amounts)
varianceExpectedVsDeclared = expectedCash - declaredCash
varianceDeclaredVsReceived = declaredCash - receivedAmount
varianceExpectedVsReceived = expectedCash - receivedAmount
outstandingAmount          = max(expectedCash - receivedAmount, 0)
balanced                   = abs(expectedCash - receivedAmount) <= 0.005
                             AND pendingSyncCount == 0
```

A daily closing is **not** a Phase 3 remittance. A remittance is a formal
finance-verified settlement instrument with its own declaration, receipt,
verification, discrepancy and reversal workflow. A closing never creates or
edits a remittance, and a remittance never closes a collector day.

### 2.3 `ReconciliationLine`

One observed source record per revision. Unique on
`(sessionId, fingerprint, revision)`.

- `entityType`: `contribution`, `collector_remittance`,
  `remittance_discrepancy`, `daily_closing`, `offline_transaction`,
  `offline_sync_attempt`, `withdrawal_exception`, `other`.
- `expectedAmount`, `declaredAmount`, `physicalAmount`, `receivedAmount`,
  `verifiedAmount`.
- `variance = expectedAmount - (verified ?? received ?? physical ?? declared ??
  0)`. Positive is a shortfall; negative is an overage.
- `status`: `matched`, `unmatched`, `shortfall`, `overage`, `duplicate`,
  `missing_evidence`, `sync_failure`, `pending_sync`, `reviewed`.
- `severity`: `low`, `medium`, `high` from absolute variance/amount.
- `metadataJson`: supporting ids, statuses and previous amounts. Never an
  accusation.
- `reviewedAt/By`, `exceptionCaseId`, `lastSeenAt`.

Idempotency: the fingerprint identifies the business fact. A later detection
run updates an unreviewed, case-free line in place. If the line was reviewed or
linked to a case and the observed amounts changed, a new revision is appended.
Earlier revisions are never overwritten.

### 2.4 `ReconciliationAdjustment`

A record of an observed corrective figure, not a posting. Fields:
`adjustmentType`, `referenceType`, `referenceId`, `declaredAmount`,
`correctedAmount`, `variance`, `status` (`proposed`, `linked`,
`completed`, `rejected`), `reason`, `evidenceRef`, `caseId`,
`proposedById/At`, `linkedById/At`.

Linking an adjustment records which authorised correction/reversal actually
posted the change. Phase 5 does not post it.

### 2.5 `ReconciliationExceptionCase`

This is the shared exception case used by Phase 1 provider statement and branch
liquidity work, extended for Susu. It was not duplicated.

Fields: `caseNumber` (unique per tenant), `branchId`, `collectorId`,
`sourceSessionId`, `category`, `severity`, `status`, `title`,
`description`, `amountAtStake`, `ownerId`, `assignedAt`, `dueAt`,
`evidence`, `escalatedAt`, `escalationLevel`, `reopenCount`,
`resolutionProposedById/At`, `proposedResolutionType/Note`,
`proposedEvidenceRef`, `resolutionApprovedById/At`, `resolutionType`,
`resolutionNote`, `resolvedById/At`, `openedById/At`,
`lastActivityAt`.

Case numbers are `REC-YYYY-NNNN`, allocated inside the transaction under an
advisory lock and backed by `@@unique([tenantId, caseNumber])`.

Categories: `provider_statement`, `branch_liquidity`, `branch_transfer`,
`remittance`, `shift`, `daily_close`, `contribution`, `offline_sync`,
`withdrawal`, `other`.

Line-to-case mapping: daily closing -> `daily_close`; remittance or Phase 3
discrepancy -> `remittance`; offline transaction/attempt -> `offline_sync`;
contribution -> `contribution`; withdrawal exception -> `withdrawal`;
otherwise `other`.

### 2.6 `ReconciliationExceptionLink`

Polymorphic link: `caseId`, `entityType`, `entityId`, `note`,
`createdById`. Supported types are validated server-side:
`contribution`, `collector_remittance`, `remittance_discrepancy`,
`daily_closing`, `susu_reconciliation`, `susu_account`, `collector`,
`withdrawal`, `customer_withdrawal_request`, `provider_statement_row`,
`branch_liquidity_line`, `shift`, `other`.

Linking validates that the target exists in the actor's tenant and, for a
branch-scoped case, that it belongs to the same branch.

### 2.7 `ReconciliationExceptionEvent`

Append-only timeline. Every state change and material action writes one row:
`type`, `actorId`, `actorRole`, `fromStatus`, `toStatus`, `reason`,
`evidenceRef`, `note`, `payload`, `createdAt`.

Event types include `opened`, `assigned`, `reassigned`, `status_changed`,
`note`, `evidence`, `escalated`, `resolution_proposed`,
`resolution_approved`, `resolved`, `rejected`, `reopened`, `link_added`,
`collector_response`, and resolution-proposal rejection.

## 3. Reconciliation types and detection categories

| Type | Detection scope |
| --- | --- |
| `daily_close` | Daily closings, collector contribution totals, missing closings, sync state. |
| `branch_close` | All daily closings and contribution integrity in the branch/period. |
| `remittance` | Phase 3 remittances and their unresolved discrepancies. |
| `sync` | Offline transactions and failed sync attempts. |
| `other` | Contribution integrity and any explicitly selected scope. |

Neutral classifications emitted by detection:

- `matched` — observed amounts agree.
- `unmatched` — a record has no counterpart or has not been received/counted;
  also used for a reversed remittance and a reversed contribution still linked
  to an active remittance.
- `shortfall` — actual cash is below the server-recorded expectation.
- `overage` — actual cash is above the server-recorded expectation.
- `duplicate` — two or more contributions share account + collector + amount +
  business day; remittance allocations exceed the contribution face value.
- `missing_evidence` — a cash difference has no evidence reference; a closing
  has no declaration/receipt; contributions exist with no closing; a reference
  is a placeholder; a Phase 3 discrepancy has no evidence; a daily-close line
  has no cash trail.
- `sync_failure` — an offline transaction or attempt failed synchronization.
- `pending_sync` — an offline transaction is captured but not yet synchronized,
  or a closing has field contributions awaiting sync.

Detection is idempotent per fingerprint. Phase 3 discrepancies are observed as
separate lines and are **not** re-created or duplicated. Phase 4 withdrawals are
not mutated.

### 3.1 Summary definitions

`summarizeLines` produces, from the latest revision of each fingerprint:

- `expectedTotal`, `declaredTotal`, `handedOverTotal`, `receivedTotal`,
  `verifiedTotal`;
- `outstandingTotal`: unresolved expected amounts excluding
  `pending_sync`, `sync_failure` and `duplicate`; includes
  `missing_evidence`;
- `disputedTotal`, `atStakeTotal`, `pendingSyncAmount`;
- counts by status, unresolved count, pending-sync count.

## 4. Case lifecycle and policy

### 4.1 States

`open`, `assigned`, `under_review`, `awaiting_evidence`, `escalated`,
`resolution_proposed`, `resolved`, `rejected`, `dismissed`, `reopened`.
`investigating` is retained for legacy provider-statement cases and behaves
like `under_review`.

### 4.2 Allowed transitions

- `open` -> assigned, under_review, awaiting_evidence, escalated,
  resolution_proposed, resolved, rejected, dismissed.
- `assigned` -> under_review, awaiting_evidence, escalated,
  resolution_proposed, resolved, rejected, dismissed.
- `under_review` / `investigating` -> awaiting_evidence, escalated,
  resolution_proposed, resolved, rejected, dismissed.
- `awaiting_evidence` -> under_review, escalated, resolution_proposed,
  resolved, rejected, dismissed.
- `escalated` -> under_review, awaiting_evidence, resolution_proposed,
  resolved, rejected, dismissed.
- `resolution_proposed` -> resolved, rejected, under_review, escalated,
  dismissed.
- `resolved` / `rejected` / `dismissed` -> reopened only.
- `reopened` -> assigned, under_review, awaiting_evidence, escalated,
  resolution_proposed, resolved, rejected, dismissed.

### 4.3 Due dates and escalation

Default due windows: high 24h, medium 72h, low 168h from opening. A due
extension requires a later date and a reason. The overdue sweep
`escalateOverdueCases` escalates open cases past due and records the event.
Manual escalation requires a reason. Escalation is operational, not a fraud
finding.

### 4.4 Evidence and independent approval

`caseRequiresEvidence` is true when `amountAtStake > 0.004`, severity is high,
or the category is remittance, daily_close, contribution, offline_sync,
withdrawal or branch_liquidity.

`requiresIndependentApproval` is true when severity is high or
`amountAtStake >= 500`. In that case:

- the resolution must be proposed, then approved by a different person;
- the proposer cannot approve their own proposal;
- approval requires finance authority: a company-wide administrator or an
  active `BranchMembership.role = "finance"` in the case's branch;
- a `branch_manager` is not finance authority.

Every case resolution records the resolution type, note, evidence reference and
resolving actor.

## 5. Server actions (API contract)

All actions return `{ success, error?, data? }` unless noted. They are server
actions, not trusted HTTP endpoints; authorization is always resolved from the
session cookie on the server.

### 5.1 Sessions

```ts
openReconciliationSession({ type, branchId?, collectorId?, periodStart, periodEnd })
listReconciliationSessions({ branchId?, collectorId?, type?, status?, from?, to?, limit? })
getReconciliationSession(sessionId)
reconcileSession(sessionId)
reviewReconciliationSession({ sessionId, note? })
closeReconciliationSession({ sessionId, reason })
raiseCasesForSession(sessionId)
reviewReconciliationLine({ lineId, note, evidenceRef?, caseId? })
```

Rules:

- `periodStart` / `periodEnd` are normalized to UTC day bounds; start <= end;
  maximum 366 days.
- A collector may only open `daily_close` for their own profile.
- `daily_close` requires a collector. Its branch is derived from the collector
  and a mismatch is rejected.
- A branch-bound admin cannot open a company-wide session.
- Opening an existing non-closed session key returns that session.
- A detection run can start only from `open`, `matched` or `case_created`.
  The conditional status update is the concurrency guard; PostgreSQL also takes
  an advisory lock.
- Review requires `matched` or `case_created`.
- Close requires a reason (5+ characters) and a `matched`, `reviewed` or
  `case_created` session.
- Reviewing an unresolved line requires a note (5+ characters), and either an
  evidence reference or a case id.

### 5.2 Adjustments

```ts
proposeReconciliationAdjustment({ sessionId, adjustmentType, referenceType,
  referenceId, declaredAmount?, correctedAmount?, reason?, evidenceRef?, caseId? })
linkReconciliationAdjustment({ adjustmentId, referenceType, referenceId })
```

The adjustment records an observed correction. It does not post a financial
mutation. Linking records the correction workflow that did.

### 5.3 Daily closing

```ts
openDailyCollectorClosing({ collectorId?, closingDate? })
declareDailyClosing({ closingId, declaredCash, note?, evidenceRef? })
recordDailyClosingHandover({ closingId, handoverAmount, note?, evidenceRef? })
receiveDailyClosing({ closingId, receivedAmount, note?, evidenceRef? })
closeDailyClosing({ closingId, note? })
getDailyClosing(closingId)
listDailyClosings({ branchId?, collectorId?, status?, from?, to?, limit? })
```

Rules:

- A collector may open/declare/hand over only their own day. Receiving and
  closing require an administrator; the person who declared or handed over
  cannot receive the same cash.
- A future business day cannot be opened.
- A difference from the recorded expectation requires an evidence reference.
- `closeDailyClosing` requires status `received`.
- Balanced close: `abs(expectedCash - receivedAmount) <= 0.005` **and**
  `pendingSyncCount === 0`.
- Otherwise exactly one exception case is created/linked, category
  `daily_close`, amount `max(abs(variance), contributionsPending)`, linked to
  the closing and collector.
- Re-closing a balanced or exception day is idempotent.
- Opening the same collector/day is idempotent under concurrency; PostgreSQL
  serialises it with an advisory lock, and the unique constraint is the final
  backstop.
- Closing the same received day concurrently takes the same per-day advisory
  lock, re-reads the row after the lock, and returns the already-closed row.
  Exactly one `daily_close` case is created for one day's difference.

### 5.4 Exception cases

```ts
openExceptionCase({ category, severity, title, description?, amountAtStake?,
  branchId?, collectorId?, ownerId?, dueAt?, evidence?, links? })
updateExceptionCase({ id, status?, severity?, ownerId?, note?, evidence?,
  evidenceRef?, reason?, resolutionType?, resolutionNote? })
assignExceptionCase({ caseId, ownerId, dueAt?, note? })
reassignExceptionCase({ caseId, ownerId, reason })
addExceptionCaseNote({ caseId, note, evidenceRef? })
extendExceptionCaseDueDate({ caseId, dueAt, reason })
escalateExceptionCase({ caseId, reason })
escalateOverdueCases({ branchId?, limit? })
proposeCaseResolution({ caseId, resolutionType, resolutionNote, evidenceRef? })
approveCaseResolution({ caseId, note? })
rejectResolutionProposal({ caseId, reason })
resolveExceptionCase({ caseId, resolutionType, resolutionNote, evidenceRef? })
rejectExceptionCase({ caseId, reason, evidenceRef? })
reopenExceptionCase({ caseId, reason, evidenceRef })
linkCaseRecord({ caseId, entityType, entityId, note? })
getExceptionCaseOwnerOptions({ branchId? })
listExceptionCases({ branchId?, collectorId?, status?, category?, severity?,
  ownerId?, overdue?, unassigned?, escalated?, search?, dateFrom?, dateTo?,
  limit?, offset? })
getExceptionCase(caseId)
respondToExceptionCase({ caseId, note, evidenceRef })
```

Rules:

- Reassignment requires a reason (5+ characters) and a different owner.
- An owner must be an active company administrator or an active
  `branch_manager` / `finance` member of the case's branch.
- Reopening requires a reason and new evidence.
- A due extension requires a reason and a later date.
- Resolution types: `correction_posted`, `contribution_reversal`,
  `remittance_reversal`, `withdrawal_adjustment`, `cash_recovered`,
  `no_action`, `other`.
- A financial case cannot resolve without evidence.
- A case needing independent approval cannot be resolved directly by its
  proposer; it must be approved by a different finance-authorised person.
- Collectors may only read/respond to cases whose `collectorId` is their own
  profile. They cannot assign, approve, resolve, reject, reopen or close.

## 6. Authorization matrix

| Actor | Session read/write | Daily close | Cases |
| --- | --- | --- | --- |
| Company-wide administrator | All branches | Open/declare/hand over/receive/close any | Full lifecycle, any owner |
| Branch-scoped administrator / branch manager | Own branch only; cannot create company-wide session | Own branch; cannot receive if they declared/handed over | Full lifecycle in branch; not finance approval unless also finance |
| Active `finance` membership | Own branch | Own branch | Full lifecycle; may independently approve |
| Collector | Own `daily_close` session and own closings only | Open/declare/hand over own day only | Read/respond only where `collectorId` is own profile |
| Other authenticated staff | Denied | Denied | Denied |

Branch helpers are reused from `src/lib/branch.ts`
(`resolveUserBranchScope`, `resolveBranchScope`, `hasActiveBranchRole`,
`assertBranchAccess`) and `src/lib/finance/reconciliation-access.ts`. No
duplicate branch-scope helper was added.

Company-wide determination: an active administrator with no branch membership
restriction, or the tenant's primary administrator. A branch-scoped
administrator is confined to their active memberships.

## 7. Owner visibility and UI

Routes:

- `/susu/admin/reconciliation` — workspace, summary cards, sessions, branch and
  collector positions, repeated patterns.
- `/susu/admin/reconciliation/daily-closing` — daily closing list and handover
  trail with declare/handover/receive/close controls.
- `/susu/admin/reconciliation/branches` — branch cards and collector position.
- `/susu/admin/reconciliation/exceptions` — filterable exception queue.
- `/susu/admin/reconciliation/exceptions/[id]` — case detail, assignment,
  evidence, notes, escalation, due extension, resolution, approval, reopening,
  links and full timeline.
- `/susu/admin/reconciliation/sessions/[id]` — session lines with revisions,
  run/review/close/raise-case controls.
- `/collector/reconciliation` — collector's own summary, daily closing and
  cases, with evidence responses.

Visibility data returned by `getReconciliationOverview`:

- `sessions`: counts by status, unresolved;
- `cases`: open, assigned, under review, awaiting evidence, escalated,
  resolution proposed, resolved, rejected, reopened, overdue, unassigned,
  high severity;
- `cash`: expected, received, outstanding, disputed, at stake,
  pending sync amount;
- `pendingSync`: queued transactions, failed attempts, pending contributions;
- `branches`: open/unassigned/overdue cases, outstanding amount;
- `collectors`: same position plus last closing day;
- `patterns`: repeated categories, branches or collectors with unresolved
  cases. Patterns are descriptive counts, not fraud predictions.

UI guarantees: loading skeletons, explicit empty states, server validation
messages, confirmation before receiving cash, closing a day, approving,
resolving, rejecting and reopening, and safe retry (no optimistic financial
change).

## 8. Phase 3 and Phase 4 integration

### 8.1 Phase 3 remittances

- The Phase 3 settlement and discrepancy engine remains authoritative.
- A `remittance` reconciliation session observes `CollectorRemittance` and
  unresolved `RemittanceDiscrepancy` rows.
- Existing discrepancies are mapped to lines; they are not duplicated.
- A remittance line with no received amount is `unmatched`; a reversed
  remittance is `unmatched`; a shortfall/overage uses the same variance sign
  convention.
- Raising a case writes only the case/link/event/audit rows. It never changes
  remittance status, allocations, receipt or discrepancy resolution.
- Resolution may reference `remittance_reversal`; the actual reversal stays in
  the Phase 3 correction workflow, and a `ReconciliationAdjustment` records the
  link.

### 8.2 Phase 4 withdrawals

- Phase 4 `CustomerWithdrawalRequest` approval, rejection and payment remain
  the only withdrawal state machine.
- Phase 5 does not scan, mutate or auto-approve withdrawal requests in this
  phase. It provides the shared exception-case surface for a withdrawal
  exception: category `withdrawal` and links to `withdrawal` or
  `customer_withdrawal_request`.
- A case resolution of type `withdrawal_adjustment` is a reference to a
  downstream correction; it does not move money or change Phase 4 status.
- This boundary is deliberate: automatic withdrawal case creation would
  duplicate Phase 4 controls and is out of scope for Phase 5.

## 9. Audit

Every material mutation writes:

1. The domain row(s) in a transaction.
2. One `ReconciliationExceptionEvent` for case transitions/actions.
3. One `AuditLog` row via `createAuditLogTx` with tenant, branch (when known),
   actor, action (for example `susu.exception_case_assigned`,
   `susu.daily_closing_received`), entity type/id and `financialMutation`
   marker.

Case opening also links the source line/closing and writes the initial event.
The audit log is append-only from the application's perspective; this phase
does not add an update/delete path.

## 10. Phase 6 reporting fields

Phase 6 may read these stable fields without re-deriving financial truth from
mutable records:

- Session: `type`, `status`, `branchId`, `collectorId`, `periodStart`,
  `periodEnd`, `summaryJson`, `definitionVersion`, `runCount`,
  `lastRunAt`, `openedAt`, `closedAt`, `closeReason`.
- Line: `entityType`, `entityId`, `fingerprint`, `revision`, amounts,
  `variance`, `status`, `severity`, `exceptionCaseId`, `reviewedAt`.
- Daily closing: all amount, variance, handover, sync and case-link fields.
- Case: `caseNumber`, `category`, `severity`, `status`, `amountAtStake`,
  `branchId`, `collectorId`, `ownerId`, `openedAt`, `assignedAt`,
  `dueAt`, `escalatedAt`, `escalationLevel`, `reopenCount`,
  `resolutionType`, `resolutionApprovedById/At`, `resolvedAt`,
  `lastActivityAt`.
- Event: full timeline for duration, reassignment count, evidence latency and
  escalation history.

Phase 6 must treat `amountAtStake` as captured at case opening, not recompute
it from a later contribution/remittance value. Reporting must not call
`pending_sync`, `sync_failure` or `duplicate` "fraud"; they are data-quality
states.

## 11. Tests and evidence

SQLite suites:

- `tests/susu-phase-5.test.ts` (17 tests): session idempotency, invalid
  period/type, branch scope, balanced close, shortfall/case link, overage,
  missing evidence, duplicates, offline pending/failure, Phase 3 reuse,
  revision history, review/close, concurrent open/detection, raise-case
  idempotency/concurrency, list/overview, and collector list-filter isolation.
- `tests/susu-phase-5-cases.test.ts` (14 tests): validation/link/audit,
  assignment/reassignment, tenant/branch/collector isolation, collector
  response permissions, evidence-gated resolution, independent approval,
  proposal rejection, due extension/overdue sweep, reject/reopen/resolve,
  cross-tenant link rejection, audit completeness, owner overview,
  concurrent numbering, branch-manager isolation.

PostgreSQL suite:

- `tests/pg-susu-phase-5.test.ts` (4 tests): concurrent daily-closing open
  returns one row; concurrent closing creates one case and a retry returns the
  same closing; concurrent `raiseCasesForSession` creates one linked case;
  concurrent `openExceptionCase` allocates unique sequential case numbers.

All test data is synthetic. PostgreSQL tests require
`PG_DATABASE_URL` to a confirmed disposable `maacash_test*` database and
`PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`.

## 12. Limitations and non-goals

- No automatic Phase 4 withdrawal-case feed (see section 8.2).
- No fraud score, risk ranking or person-level prediction.
- No automatic session close; a human reviews and closes with a reason.
- No mutation of Phase 3 financial records; corrections post through their
  existing authorised workflows.
- No cross-tenant reporting; every query starts from the session tenant.
- Evidence references are text/document references; binary evidence uses the
  existing evidence-attachment service.
