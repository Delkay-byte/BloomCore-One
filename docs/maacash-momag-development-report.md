# MaaCash — MoMAG Readiness Development Report

**Repository:** `Delkay-byte/BloomCore-One`  
**Production baseline:** `92d6d974e1e41d7b0586e823f9c000a0a7fe0925`  
**Working branch:** `feat/maacash-momag-readiness`  
**Mode:** local development only. Nothing pushed, merged, deployed or run against production payment services.

## Current position

The branch already contains seven capability commits beyond the baseline: MoMo operational ledger, branch cash/float transfers, shifts and handovers, customer statements/receipts, performance reporting, deterministic anomaly monitoring, and customer disputes.

This report starts the new Workstream 0 review and records each feature from here forward.

## Workstream 0 risk register

| # | Risk | Current classification | Evidence and remaining gap |
|---|---|---|---|
| 1 | Aggregated MoMo figures conceal transaction-level discrepancies | **PARTIALLY ADDRESSED / DISCLOSED** | `MomoTransaction` and the per-day `ledgerMode` cutover exist. Workstream 1 adds an explicit verification state, supporting evidence and per-row cash/float effects, so a manual row can never be presented as provider-confirmed. Aggregate days remain supported but are labelled operator-declared and not transaction-proven; performance counts ledger-backed versus aggregate days and an anomaly flags mixed sources. Forcing every business onto the ledger remains a product decision. |
| 2 | Best-effort audit records leave financial actions without evidence | **RESOLVED for money movements; residual control record** | Successful money changes now write audit evidence in the same transaction. `createAuditLog()` remains for non-financial/security events, and the final `finance.approval_applied` summary is still written after the already-audited reversal. |
| 3 | Activity History omits meaningful actor identity | **RESOLVED for actor identity** | Audit rows now snapshot actor name, role and type at write time. Renames and removed accounts do not rewrite history. Device attribution remains part of 0.3. |
| 4 | Offline shared-device recovery creates attribution and replay risk | **RESOLVED for attribution and replay; device trust remains a foundation** | Per-user IndexedDB scope, device ownership checks, global payload-bound idempotency and revoked-device refusal exist. Synced collections now store the verified device and commit with audit evidence. Device attestation/hardware binding is not claimed. |
| 5 | Revenue and profit definitions can mislead | **RESOLVED** | Performance reporting uses operating revenue = commission + other income, discloses every headline definition, and continues to exclude debt recovery and principal volume. Daily screens now call the accountability figure an increase, not profit. |

## Feature 0.1 — Atomic financial audit evidence

**Status:** GREEN  
**Commit:** `bb5e5e5`  
**Test follow-up:** `bce2363` (browser fixture only)

### Existing capability before changes

Financial actions committed their money rows first, then called `createAuditLog()`. That helper catches every error and only logs to the server console. A database or storage failure could therefore leave a contribution, withdrawal, reversal, remittance or daily closing with no durable audit evidence.

### What was implemented

`createAuditLogTx()` is now used inside the same transaction as:

- contribution recording;
- withdrawal processing, including first-withdrawal commission;
- contribution and withdrawal reversals;
- collector remittance recording and reversal;
- daily-account create, save, correction, submit, review and handover confirmation;
- customer/account creation with the initial card fee;
- financial approval request and rejection.

A failed audit insert aborts the transaction. The money row and all side effects roll back.

### Schema and migrations

None. This feature changes transaction boundaries only.

### Tests and results

- New `tests/financial-audit-atomicity.test.ts` installs a SQLite trigger that aborts all `AuditLog` inserts.
- Proven rollback for contribution, withdrawal, contribution reversal and daily-account submission.
- Targeted financial/operational suite: **10 files, 103 tests passed**.
- Full regression suite: **112 files, 1,274 tests passed**.
- TypeScript: clean.
- ESLint on touched files: 0 errors; one pre-existing unused-import warning in `susu-collector.actions.ts`.

### Browser acceptance

`e2e/momo-workflow.spec.ts` — worker opens the seeded daily account, enters a balanced reconciliation, submits it and reaches the submitted state. **1 passed.** The flow now explains a material opening balance when the seeded prior close triggers that control.

### Security and tenant-isolation evidence

- No tenant or session resolution changed.
- Every audit row is written with the already-resolved session tenant and actor.
- No client-supplied actor or tenant is introduced.
- Step-up, dual-control and rate-limit checks precede the financial transaction as before.
- No financial record is overwritten; corrections still create reversal/revision records.

### Known limitations

- Application-level audit rows are durable but not cryptographically immutable.
- The `finance.approval_applied` summary remains a post-execution write. The underlying reversal is already audited atomically, so the money change is not unaudited.
- A single-administrator exception row is still written after the correction transaction. The correction itself carries actor, reason and audit evidence in-transaction.

### External approvals still required

None for this local feature.

### Next dependency

0.2 — complete actor identity and device attribution in Activity History, before offline replay hardening.

## Feature 0.2 — Durable audit actor identity

**Status:** GREEN  
**Commit:** `b34530a`

### Existing capability before changes

Activity History looked up the actor from the current `User` or `Customer` row by `userId`. Renaming an employee changed the displayed actor on old events; removing an account left legitimate historical events unattributed.

### What was implemented

- `AuditLog` now stores `actorName`, `actorRole` and `actorType` at write time.
- Both `createAuditLog()` and `createAuditLogTx()` populate the snapshot. The atomic helper fails closed with the financial transaction if the snapshot cannot be written.
- `/api/audit` prefers the stored snapshot, falls back to the live account for legacy rows, and keeps an explicit unattributed state when neither exists.
- No client-supplied actor identity is accepted.

### Schema and migrations

- `prisma/schema.prisma` and `prisma/schema-pg.prisma`: nullable `actorName`, `actorRole`, `actorType` columns on `AuditLog`.
- Additive migration `20261129_audit_actor_snapshot`.

### Tests and results

- New `tests/audit-actor-attribution.test.ts` proves:
  - rename does not rewrite historical actor name/role;
  - deleting the actor account preserves the snapshot;
  - customer portal actions are attributed as `customer`, not staff.
- Targeted audit suite: **5 files, 28 tests passed**.
- Full regression suite: **113 files, 1,277 tests passed**.
- TypeScript and touched-file ESLint: clean.

### Browser acceptance

Admin → Activity History shows a seeded historical actor snapshot (`Historic Actor · Admin`) after the current account was renamed. **1 passed.**

### Security and tenant-isolation evidence

- Actor lookup remains tenant-scoped through the authenticated session/action context.
- Audit rows keep the existing tenant column and the API still filters by `ctx.tenantId`.
- Snapshot fields are written server-side only; they are not accepted from request input.
- No historical audit rows are updated or deleted.

### Known limitations

- Legacy audit rows created before this migration have no snapshot and still depend on the live account.
- Device identity is not yet stored on the audit row. That belongs to 0.3 and Workstream 1.

### External approvals still required

None.

### Next dependency

0.3 — offline shared-device attribution and replay hardening.

## Feature 0.3 — Offline device attribution and atomic sync

**Status:** GREEN  
**Commit:** `f92cdbc`

### Existing capability before changes

The offline route already bound a queue key to the authenticated user, tenant, device and canonical payload, and rejected cross-tenant/cross-user reuse. However, the resulting `Contribution` carried only the user, not the device. The contribution, offline queue acknowledgement and audit row also committed in separate steps.

### What was implemented

- `Contribution` stores `recordedDeviceId` and `recordedDeviceName` for offline collections only.
- The verified `DeviceEnrollment` is the source of both values; the client cannot supply them.
- Contribution, allocations, actor-snapshotted audit row and `OfflineTransaction` acknowledgement commit in one transaction.
- Audit details include the device identifier and name plus `source: offline_sync`.
- A retry of an already-synced key returns the original result without a second contribution or audit row.
- The existing per-user IndexedDB scope and device-ownership checks are unchanged.

### Schema and migrations

- `Contribution.recordedDeviceId`, `Contribution.recordedDeviceName` in both Prisma schemas.
- Additive migration `20261130_contribution_device_attribution`.

### Tests and results

- New `tests/offline-sync-attribution.test.ts`:
  - verified device and actor snapshot stored on the contribution;
  - one audit row with device evidence;
  - retry remains idempotent with one posting and one audit row;
  - audit-storage failure posts no contribution and does not acknowledge the queue item.
- Offline/security targeted suite: **6 files, 58 tests passed**.
- Full regression suite: **114 files, 1,279 tests passed**.
- TypeScript and touched-file ESLint: clean.

### Browser acceptance

Mobile collector offline status flow: Online → Offline → Online transitions without a false “Offline Active” state. **1 passed.** No offline financial queue was created in the browser test; the server route is covered by the integration tests above.

### Security and tenant-isolation evidence

- Device lookup remains scoped by `deviceId`, `userId` and `tenantId`, with `status = active`.
- The 24-hour offline authorization window and revocation checks remain enforced.
- The global idempotency key remains bound to the original user, device and canonical payload.
- No client-supplied device name or actor identity is trusted.
- No existing queue record is deleted or rewritten beyond its sync acknowledgement.

### Known limitations

- IndexedDB is ordinary browser storage. Per-user scoping prevents normal cross-account access, but it is not hardware-backed secure storage.
- Device identity is recorded, not cryptographically attested. A rooted or instrumented device can still lie about its local clock or UI state.
- Offline `collectionDate` still reflects the server posting time, not a separately verified device capture time. This is recorded as a follow-up for the ledger hardening work.
- PostgreSQL replay tests were updated conceptually by the shared route but were not run locally without a disposable PostgreSQL target.

### External approvals still required

None for local implementation.

### Next dependency

0.4 — revenue/profit definitions and misleading report language.

## Feature 0.4 — Revenue, recovery and accountability definitions

**Status:** GREEN  
**Commit:** `ef19ca7`

### Existing capability before changes

The performance report already calculated operating revenue as commission plus other income and excluded drafts, debt recovery and principal volume. However, the worker daily closing, correction form, admin dashboard, report detail and CSV still labelled the accountability increase as “profit”. That invited readers to treat debt recovery and accountability movement as accounting profit.

### What was implemented

- Daily screens now use **net accountability increase**, **increase retained** and **increase withdrawn / not retained**.
- The daily report and correction form state the formula and that it is not accounting profit or revenue.
- The report CSV header is now **Net Accountability Increase**.
- Performance uses **Operating revenue**, with an expandable definition for revenue, expenses, net operating and cash movement.
- `PerformanceReport.source` now carries those definitions so exports and screens share one explanation.
- Internal compatibility fields such as `profitRetained` remain in the calculation API but are no longer user-facing labels.

### Schema and migrations

None.

### Tests and results

- `tests/financial-definitions.test.ts` guards the terminology across five screens and the CSV header.
- Performance tests assert the disclosed definitions.
- Targeted reports suite passed; full suite: **115 files, 1,282 tests**.
- TypeScript and touched-file ESLint: 0 errors; existing effect warnings only.

### Browser acceptance

Daily report shows the accountability language and the “not accounting profit or revenue” explanation. Performance shows Operating revenue and opens “How each metric is defined”. **1 passed.**

### Known limitations

- Zeli’s conversational intent still recognises the word “profit”; its answer source correctly states that contributions are not profit.
- Accounting profit cannot be calculated from this operational dataset alone because liabilities, receivables and full cost accounts are not present. The UI does not claim it.

### External approvals still required

None.

### Next dependency

0.5 — aggregate-vs-ledger integrity and disclosure.

## Feature 0.5 — Aggregate close disclosure and mixed-source detection

**Status:** GREEN  
**Commit:** `1b7ddba`

### Existing capability before changes

Ledger mode existed per day, but an aggregate day looked the same as a transaction-backed day in reports. Performance did not distinguish the two bases, and an aggregate close with same-day ledger rows had no dedicated finding.

### What was implemented

- Daily report has a **Closing basis** card:
  - Transaction ledger — derived from individual rows;
  - Operator-declared aggregate — only day totals, with an explicit statement that it cannot prove every customer transaction was captured.
- Report CSV includes a **Closing basis** column.
- Performance report counts `ledgerDays` and `aggregateDays` in totals and per branch, displayed and exported.
- New deterministic anomaly `mixed_aggregate_ledger` fires when a confirmed aggregate account has recorded ledger transactions for the same branch and date, including references as evidence.
- No historical aggregate row is converted or back-filled.

### Schema and migrations

None.

### Tests and results

- Performance tests assert ledger/aggregate day counts.
- Anomaly tests assert the mixed-source finding and that a ledger-backed account does not trigger it.
- Terminology tests guard the aggregate disclosure text.
- Full suite: **115 files, 1,283 tests**.
- TypeScript and touched-file ESLint: 0 errors.

### Browser acceptance

Daily report shows the operator-declared aggregate warning; performance shows Aggregate days and the “no transaction-level proof” hint. **1 passed.**

### Known limitations

- Aggregate closing remains available. A business can still choose aggregate mode, so transaction-level completeness is not guaranteed for those days.
- The anomaly identifies mixed sources; it does not decide which source is correct.
- There is no automatic conversion of an aggregate day to ledger mode. Conversion would invent transaction detail and is deliberately prohibited.

### External approvals still required

A product decision is still required on whether new businesses should default to ledger mode and whether aggregate mode should eventually be retired.

### Next dependency

Workstream 1 — strengthen the independent transaction ledger to cover the remaining attribution, verification-state, statement and export requirements.

## Workstream 1 — Independent transaction ledger hardening

**Status:** GREEN  
**Commit:** `29de177`

### Existing capability before changes

A tenant-scoped `MomoTransaction` ledger already existed with unique business references, per-tenant idempotency keys, employee and branch attribution, reversal and correction rows, posting history, a filterable admin screen and CSV export. Every row was described as “operator-recorded”, but the record itself had no explicit verification state, no evidence reference and no device attribution.

### What was implemented

- Every ledger row now carries a server-controlled verification state:
  - **Operator-recorded** — manually captured, not provider-verified;
  - **Imported statement** — reserved for a future statement import;
  - **Provider-confirmed** — reserved for a future verified integration;
  - **Disputed** — reserved for review.
- Manual recording always writes `operator_recorded`. A client cannot promote its own submission to a provider-confirmed row; the value is not accepted from the form.
- Optional **supporting evidence** text stores a receipt number, statement line or other held evidence. The UI states that this is a reference and does not verify the transaction with a network.
- Optional `recordedDeviceId` / `recordedDeviceName` columns are ready for an enrolled offline device. Online web entry leaves them empty rather than inventing a device identity.
- Cash and float effects are exposed per row:
  - deposits: cash up, float down;
  - cash-outs: cash down, float up;
  - reversals carry the opposite effect so the pair nets to zero.
- Reversals and corrections are always operator-recorded, even when correcting an imported or provider-confirmed row. A correction cannot inherit a stronger verification claim.
- The admin ledger list and detail show verification state, effects, device and evidence. The worker ledger shows the verification badge and evidence reference.
- CSV export adds cash effect, float effect, verification, recorded device and supporting evidence.

### Schema and migration

`prisma/migrations/20261201_momo_verification_state/migration.sql` adds, additively:

- `MomoTransaction.verificationStatus` (default `operator_recorded`);
- `recordedDeviceId`, `recordedDeviceName`;
- `supportingEvidence`;
- an index on `[tenantId, verificationStatus]`.

Both SQLite and PostgreSQL Prisma schemas were updated. `prisma validate` passes for both. The SQLite test and E2E databases were pushed successfully. No historical row is rewritten: every existing row correctly defaults to operator-recorded.

### Tests and results

- New tests prove:
  - every manual entry is `operator_recorded`;
  - a client-supplied `provider_confirmed` value is ignored;
  - supporting evidence is stored and returned;
  - cash and float effects are correct for deposits and cash-outs;
  - a reversal carries the opposite effect and nets to zero;
  - the CSV discloses verification and effects.
- `tests/momo-ledger.test.ts`: **25 passed**.
- Full regression suite: **115 files, 1,285 tests passed**.
- TypeScript: clean.
- ESLint on touched files: 0 errors; existing data-loading effect warnings only.

### Browser acceptance

Worker switched the seeded draft day to the ledger, recorded a GH₵120 deposit with supporting evidence, and saw the operator-recorded badge and evidence on the row. The administrator then opened the ledger and saw the same entry with its verification state. **1 passed.**

### Security and tenant-isolation evidence

- Verification state is set by the server action, never trusted from the request.
- Tenant, branch and employee scope are unchanged; all reads remain session-scoped.
- Audit evidence remains atomic and now records the verification state and evidence reference.
- Provider-confirmed remains impossible until a real integration exists, so the ledger cannot overstate certainty.
- CSV escaping still neutralises formula-leading values.

### Known limitations

- No telco, aggregator or bank integration exists. Provider-confirmed and imported-statement states are defined but cannot yet be produced.
- Online web entries do not have an enrolled device identity; device columns remain empty until device enrolment is wired to ledger entry.
- Cash and float effects are derived operational views, not a full double-entry general ledger. They describe the ledger’s own effect model.
- Statement import, reconciliation against a provider file and customer-facing MoMo statements are not implemented in this workstream.
- PostgreSQL migration SQL was validated by schema and migration review, not executed against a live PostgreSQL instance in this session.

### External approvals still required

- MTN MoMo, Telecel Cash and AT Money API access, sandbox credentials and written confirmation of provider reference semantics before any row can be marked provider-confirmed.
- Agreement on statement-import formats and evidence retention if imported statements are to become a supported source.

### Next dependency

Workstream 2 — extend the existing branch cash and float transfer lifecycle with the remaining approval, evidence and reporting requirements.

## Workstream 2 — Branch cash and float transfer lifecycle

**Status:** GREEN  
**Commit:** `3c2a47e`

### Existing capability before changes

The branch transfer lifecycle already supported declared cash and per-network float, request, approval by a different administrator, rejection, dispatch, receipt, variance capture, dispute, investigation resolution, cancellation and append-only events. Transfers were reserved against the declared balance and high-value approvals required step-up.

Two gaps remained:

- The read-then-reserve balance check relied on the database default isolation level. SQLite serialises writes, but PostgreSQL at read committed could let two concurrent requests both pass before either committed.
- The admin **Complete transfer** button set a pending state that the form block deliberately excluded, so a received transfer could not be completed from the screen even though the server action worked.

### What was implemented

- Balance reservation and draft request now run at **Serializable** isolation, with a bounded retry for serialization and write conflicts.
- The admin **Complete transfer** button now calls the completion action directly.
- Dispatch can record a **dispatch evidence** reference (waybill, count sheet, receipt number).
- Receipt can record a **receipt evidence** reference in addition to the counted amount and variance note.
- Both evidence references are stored on the transfer, written into the append-only event/audit trail where applicable, and shown on the transfer detail.
- The evidence fields state that a reference does not confirm a provider balance.

### Schema and migration

`prisma/migrations/20261202_branch_transfer_evidence/migration.sql` adds, additively:

- `BranchTransfer.dispatchEvidence`;
- `BranchTransfer.receiptEvidence`.

Existing rows keep `NULL`, read as “None recorded”. No historical transition is rewritten. Both Prisma schemas were updated and validated; SQLite test and E2E databases were pushed successfully.

### Tests and results

- The lifecycle test now records dispatch and receipt evidence and asserts both are returned on the transfer detail and that dispatch evidence appears in history.
- Existing coverage still proves separation of duties, location roles, variance handling, cancellation release and the concurrent full-balance request result.
- `tests/branch-transfers.test.ts`: **18 passed**.
- Full regression suite: **115 files, 1,285 tests passed**.
- TypeScript: clean.
- ESLint on touched files: 0 errors; existing data-loading effect warning only.

### Browser acceptance

An approved transfer was opened as an administrator. Dispatch was confirmed with `Waybill WB-E2E-1`; receipt was confirmed for GH₵300 with `Count sheet CS-E2E-1`; the transfer was then completed from the screen. Both evidence references and the completed state were visible. **1 passed.**

### Security and tenant-isolation evidence

- Tenant and location scope are unchanged; a worker may only act from their assigned source or destination.
- Approval still requires a different administrator, and step-up is unchanged.
- Evidence is server-side validated at 300 characters or fewer and never treated as provider confirmation.
- Serializable isolation plus retry closes the PostgreSQL over-reservation window that the previous default isolation level left open.

### Known limitations

- Evidence is a free-text reference; file attachments and document storage are not implemented.
- Declared balances remain operator declarations. There is no telco, bank or aggregator balance feed.
- Transfers move internal declared positions only; they do not initiate a real bank or mobile-money movement.
- Serializable retry is bounded. A persistent conflict returns a clean failure rather than retrying indefinitely.
- PostgreSQL serialization behaviour was reasoned from Prisma/database semantics and exercised on SQLite; it was not load-tested against a live PostgreSQL instance in this session.

### External approvals still required

- Bank and telco integration agreements before any transfer can be confirmed against a real provider movement.
- A retention policy for physical waybills and count sheets if evidence references are to be audited externally.

### Next dependency

Workstream 3 — extend shift accountability and handover with the remaining coverage and reporting requirements.

## Workstream 3 — Shift accountability and two-sided handover

**Status:** GREEN  
**Commit:** `dd6201a`

### Existing capability before changes

Shifts were already optional sub-day accountability records with opening carry-forward, an assigned employee, two-sided handover, separate receiver confirmation, variance investigation with step-up, cancellation and a daily-account summary that is deliberately excluded from financial totals. Shift names supported morning, afternoon, evening and a custom option.

### What was implemented

- The outgoing count can only be submitted by the employee assigned to the shift. An administrator can no longer submit a physical count in that employee's name.
- The receiving employee must still be the named receiver and must still be active at confirmation.
- Both sides can record an evidence reference:
  - outgoing: till slip, count sheet or handover evidence;
  - incoming: count sheet, receipt or other evidence held.
- Evidence is stored on the handover, written into the audit event and shown on the worker and administrator views.
- A custom shift can now carry a tenant-defined name in the worker UI instead of always being labelled “Custom shift”. Scheduled start and end remain supported by the action and schema.
- Shift figures remain excluded from daily-account totals, so the same cash is never counted twice.

### Schema and migration

`prisma/migrations/20261203_shift_handover_evidence/migration.sql` adds, additively:

- `ShiftHandover.outgoingEvidence`;
- `ShiftHandover.incomingEvidence`.

Existing handovers keep `NULL`, read as “no evidence recorded”. Both Prisma schemas were updated and validated; SQLite test and E2E databases were pushed successfully.

### Tests and results

- Handover lifecycle now records and returns both evidence references.
- New test proves an administrator cannot submit the outgoing count for an assigned employee.
- New test proves a custom shift name and scheduled window are accepted.
- Existing coverage still proves one person cannot be both sides, the receiver must belong to the branch, the receiver alone confirms, variances need an explanation, step-up is required to resolve, and tenant isolation holds.
- `tests/shift-handover.test.ts`: **15 passed**.
- Full regression suite: **115 files, 1,287 tests passed**.
- TypeScript: clean.
- ESLint on touched files: 0 errors; existing data-loading effect warnings only.

### Browser acceptance

The outgoing worker closed an open shift with GH₵140 cash, GH₵610 float and `Till slip TS-W03`, handing over to a colleague. The receiving employee counted the same amounts, accepted the outstanding operations, recorded `Count sheet CS-W03`, and the shift closed. The administrator detail showed both evidence references. **1 passed.**

### Security and tenant-isolation evidence

- Shift and handover access remains tenant-scoped and location-scoped.
- The outgoing side is now personally attributed to the assigned employee; an administrator cannot impersonate that count.
- The receiver check is enforced server-side and re-checks that the receiver is active.
- A user cannot be both outgoing and incoming, and cannot confirm a handover assigned to someone else.
- Evidence is bounded free text and is not treated as a provider or bank confirmation.

### Known limitations

- Shifts are optional but there is no tenant-level on/off switch or shift-template scheduler. A business can create zero, one or many shifts; nothing forces a shift to exist.
- Shift names remain a fixed set plus a free-text custom label, not a fully managed per-tenant shift catalogue.
- Evidence is a reference, not an uploaded document.
- Shift balances are accountability snapshots and are intentionally not posted into the daily financial close.
- PostgreSQL behaviour was schema-validated and reasoned, not executed against a live PostgreSQL instance in this session.

### External approvals still required

None for the local accountability flow. A future document-storage or biometric/device-attestation feature would need separate retention and privacy approval.

### Next dependency

Workstream 4 — customer receipts, statements and the external messaging foundation.

## Workstream 4 — Customer receipts and messaging foundation

**Status:** GREEN  
**Commit:** `33c9fa2`

### Existing capability before changes

Customers already had a date-filtered statement with opening/closing balance, CSV export, receipt lookup by the original transaction reference, a printable receipt, and a direct route to dispute a record. Receipts were tenant/customer scoped and did not expose a public enumeration endpoint. No SMS or WhatsApp capability existed.

### What was implemented

- A provider-neutral outbound message contract with SMS and WhatsApp channels, E.164 recipient validation, per-channel length limits, and a **mock adapter**.
- The mock adapter never opens a network connection and never reports a message as sent. It returns `simulated`.
- Deterministic receipt text for SMS and WhatsApp built only from the recorded receipt:
  - business, transaction reference, amount and date;
  - customer, account and cycle on WhatsApp;
  - no claim that a contribution is profit or that a balance is provider-confirmed.
- A **Receipt message preview** on every customer and admin receipt:
  - SMS and WhatsApp previews;
  - character count and limit;
  - copy-to-clipboard;
  - an explicit statement that nothing is sent and no delivery receipt exists.
- Recipient masking helper for future logs.

### Schema and migrations

None. The preview is generated from the already-authorized receipt; nothing is stored or transmitted.

### Tests and results

- New `tests/receipt-messaging.test.ts` proves SMS/WhatsApp content, withdrawal wording, channel limits, E.164 validation, PII masking, and that the mock provider returns `simulated` rather than `sent`.
- `tests/receipt-messaging.test.ts`: **3 passed**.
- Full regression suite: **116 files, 1,290 tests passed**.
- TypeScript: clean.
- ESLint on touched files: 0 errors.

### Browser acceptance

The customer opened the seeded contribution receipt, switched between SMS and WhatsApp previews, saw the GHS amount, reference, account and cycle, and saw the “Sandbox only. No SMS or WhatsApp message has been sent” notice. **1 passed.**

### Security and tenant-isolation evidence

- The preview uses the receipt already returned by the customer-scoped action; it does not add a new lookup or enumeration path.
- No phone number, message body or recipient list is persisted by this feature.
- The mock provider cannot deliver, and there is no production messaging credential in the repository.
- Message text is deterministic and cannot describe principal as revenue or a declared balance as provider-confirmed.

### Known limitations

- No SMS or WhatsApp message is sent. There is no provider account, sender ID, template approval or delivery receipt.
- There is no outbox, retry queue, delivery-status table, consent record or opt-out handling yet.
- The preview runs in the browser from data the customer is already allowed to see; it is not an audited messaging event.
- Message localisation is English only.
- The mock adapter validates E.164, but customer phone normalisation remains the existing customer-record rule.

### External approvals still required

- An approved SMS gateway contract, Ghana sender ID/shortcode registration and delivery-report access.
- A WhatsApp Business Platform account, approved message templates and opt-in evidence before any WhatsApp send.
- A consent, opt-out and retention policy approved by the business before real customer messaging is enabled.

### Next dependency

Workstream 5 — customer self-service and dispute hardening on top of the existing portal and dispute records.

## Workstream 5 — Customer self-service and dispute hardening

**Status:** GREEN  
**Commit:** `c7945f8`

### Existing capability before changes

The customer portal already supported sign-in, statement and date filtering, receipt lookup, withdrawal status, profile/settings, and one dispute per recorded contribution or withdrawal. A dispute could be opened by the customer, reviewed by an administrator, paused for customer information, answered by the customer, cancelled before review, and resolved as upheld or declined. Disputes never changed money.

### What was implemented

- A dispute now snapshots the account **cycle number** when opened, so the record remains meaningful after the account moves to another cycle.
- The customer can record an **evidence reference** when opening a dispute (receipt number, statement line or other held evidence).
- The administrator can record the **evidence checked** when resolving.
- Both evidence references are shown to the customer and the administrator, including after closure.
- Customer and administrator audit entries carry the evidence reference and still declare `financialMutation: false`.
- No dispute transition writes a contribution, withdrawal, commission or balance.

### Schema and migration

`prisma/migrations/20261204_dispute_evidence_cycle/migration.sql` adds, additively:

- `CustomerDispute.cycleNumber`;
- `CustomerDispute.customerEvidence`;
- `CustomerDispute.resolutionEvidence`.

Existing rows keep `NULL`, read as “not recorded”. No status, outcome or financial row is rewritten. Both Prisma schemas were validated and the SQLite test/E2E databases were pushed.

### Tests and results

- The lifecycle test now opens with customer evidence, asserts the cycle snapshot, resolves with administrator evidence, and asserts both are visible on the customer view.
- Existing coverage still proves one dispute per transaction, tenant/customer isolation, transition rules, two-sided review and the audit trail.
- `tests/customer-disputes.test.ts`: **6 passed**.
- Full regression suite: **116 files, 1,290 tests passed**.
- TypeScript: clean.
- ESLint on touched files: 0 errors; existing data-loading effect warnings only.

### Browser acceptance

The customer raised a dispute from the contribution receipt with `Office slip OS-W05`. The administrator opened it from the dispute register, started review, and resolved it with `Contribution counterfoil OS-W05`. The customer then saw both evidence references and the cycle on the closed dispute. **1 passed.**

### Security and tenant-isolation evidence

- Customer reads and writes remain scoped by customer, tenant and account ownership.
- Administrator reads remain scoped by tenant and the Susu module guard.
- The subject is re-resolved from the database; the client cannot attach a dispute to another customer's transaction.
- Evidence is bounded free text, not an uploaded file.
- The outcome still changes the review record only. Any correction remains a separate financial action with its own audit evidence.

### Known limitations

- `outcomeReference` is recorded as text. It is not yet validated against an actual reversal/correction row, so an administrator can enter a reference that does not exist.
- Evidence is a reference only; there is no document upload or retention store.
- A dispute remains one-per-transaction. A second concern needs a separate channel or a future linked case.
- No automatic correction is performed when a dispute is upheld; the normal financial control must be used.
- There is no dispute SLA timer or aging alert; the board is reviewed on demand.

### External approvals still required

None for the local review flow. A future evidence-upload feature would need storage, retention and customer-privacy approval.

### Next dependency

Workstream 6 — association foundation: membership, sponsored subscriptions and training records.

## Workstream 6 — Association membership, sponsorship and training foundation

**Status:** GREEN  
**Commit:** `9662595`

### Existing capability before changes

There was no association register. Membership, sponsored packages and training records were not represented anywhere in MaaCash.

### What was implemented

- A tenant-scoped **member register** with member code, business name, contact, phone, email, region, join date and status. Member codes and phone numbers are unique inside a tenant, not globally.
- **Sponsored package records**: sponsor, plan code, amount, currency, period, reference and status. A sponsorship is an agreement record only. It never charges, pays out, activates a Zeli subscription or writes a financial ledger row.
- **Training records**: title, provider, status, completion, expiry, certificate reference and notes. The dashboard counts completed training and certificates expiring within 90 days.
- Status changes for members and sponsorships are audited. Every association audit entry declares `financialMutation: false`.
- A new administrator page at `/admin/association` with summary cards, member registration, sponsorship entry, training entry and the three registers.
- A new “Association” navigation section.

### Schema and migration

`prisma/migrations/20261205_association_foundation/migration.sql` adds:

- `AssociationMember`;
- `AssociationSponsorship`;
- `AssociationTrainingRecord`.

All three are tenant-owned, with member children cascading from the member. Both Prisma schemas were validated; SQLite test and E2E databases were pushed. No existing table or financial row is changed.

### Tests and results

- New `tests/association-foundation.test.ts` proves:
  - member creation and dashboard listing;
  - duplicate member code refused inside a tenant but allowed in another tenant;
  - sponsorship recording leaves MoMo transactions, contributions and Zeli subscriptions untouched;
  - a sponsorship cannot reference another tenant's member;
  - date-order validation and status transitions;
  - training completion/expiry counting and invalid expiry refusal.
- `tests/association-foundation.test.ts`: **6 passed**.
- Full regression suite: **117 files, 1,296 tests passed**.
- TypeScript: clean.
- ESLint on touched files: 0 errors; one existing data-loading effect warning.

### Browser acceptance

The administrator registered `E2E Agents Association`, recorded a GH₵500 sponsorship from `MoMAG Support Fund`, and recorded `Float and fraud awareness` training. All three appeared in their registers. **1 passed.**

### Security and tenant-isolation evidence

- Every action resolves the tenant from the administrator session; no tenant or creator ID is accepted from the client.
- Member, sponsorship and training reads are tenant-scoped.
- A sponsorship or training cannot attach to a member outside the caller's tenant.
- Association records create no money movement, no subscription and no worker/customer access.
- All writes are audited atomically with `createAuditLogTx`.

### Known limitations

- There is no cross-business association dashboard or platform-level association identity. Each tenant sees its own register.
- Membership dues, invoicing, receipts and payment collection are not implemented.
- Bulk import, member self-service, document upload and certificate files are not implemented.
- A training record is not a regulatory certification and does not verify a provider.
- Sponsorship amounts are records of an agreement, not proof of payment.
- PostgreSQL migration SQL was schema-validated but not executed against a live PostgreSQL instance in this session.

### External approvals still required

- Agreement on whether the association is a separate legal tenant or a cross-tenant platform capability.
- Dues/payment rules and receipts if membership becomes chargeable.
- Training-provider and certificate-verification agreements before training is presented as accredited.

### Next dependency

Workstream 7 — BloomCore Identity OIDC readiness review against the existing platform SSO implementation.

## Workstream 7 — BloomCore Identity OIDC readiness review

**Status:** GREEN  
**Commit:** `e762eb3`

### Existing capability before changes

Platform-console single sign-on against BloomCore Identity (Authentik/Control
Center) already existed behind `PLATFORM_OIDC_ENABLED`, default OFF:

- Authorization Code with PKCE (S256), server-side token exchange;
- single-use `state`, `nonce` and verifier in an HMAC-signed, HttpOnly,
  path-scoped flow cookie;
- ID-token signature/issuer/audience/expiry/nonce/verified-email validation
  against the IdP JWKS with RS/PS/ES only;
- native platform session minting, `amr` mapping and MFA enforcement;
- suspended-admin denial, forced-password-reset denial and platform audit
  events;
- refresh-token storage for central revocation and back-channel logout.

### Gap found and fixed

The callback URI was derived from the request origin when
`PLATFORM_OIDC_REDIRECT_URI` was unset. A forged or rewritten `Host` header
could therefore select a redirect the IdP had registered, undermining the
authorization-code boundary.

The login flow now requires an explicit `PLATFORM_OIDC_REDIRECT_URI` and, when
`PLATFORM_OIDC_ALLOWED_REDIRECT_URIS` is set, an exact allowlist match. The
request origin is ignored. A missing or non-allowlisted redirect disables the
interactive login flow (404) but does **not** disable back-channel logout or
central session revocation, which never use a browser redirect.

### Tests and results

- `tests/platform-oidc.test.ts`: **28 passed**, including new cases proving the
  request origin cannot select the callback and that an off-allowlist redirect
  makes the login flow unavailable.
- `tests/platform-session-revocation.test.ts`: **11 passed**, confirming the
  narrower login gate did not disable central revocation.
- Full regression suite: **117 files, 1,298 tests passed**.
- TypeScript: clean. ESLint on touched files: 0 errors.

### Browser acceptance

With a complete, allowlisted OIDC configuration, `/platform/login` rendered the
“Sign in with BloomCore Identity” entry point pointing at
`/platform/login/sso/start`. **1 passed.**

### Security and tenant-isolation evidence

- The redirect URI is server configuration, never client or `Host` input.
- PKCE verifier, state and nonce remain server-side in a signed, single-use,
  path-scoped cookie.
- Platform SSO mints only platform sessions; no tenant, worker or customer
  session is created and no tenant data is read.
- Back-channel logout and central revocation target SSO-derived platform
  sessions of one immutable subject and never a local password session.

### Known limitations

- No live IdP or Control Center was contacted in this session. Validation used
  the existing synthetic RSA/JWKS and fake-IdP tests plus a browser render.
- The feature remains default OFF; production is untouched.
- MFA strength is only as good as the IdP `amr` claim. A password-only IdP
  session is refused only when `MFA_ENFORCEMENT=enforce`.
- Refresh-token revocation applies only when the IdP issues refresh tokens
  (`offline_access`).
- The pending-link confirm step deliberately does not mint a session; one more
  SSO click is required after linking.

### External approvals still required

- Final production issuer, client ID, client secret, redirect URI and allowlist
  from BloomCore Identity.
- A verified-email scope mapping in Authentik.
- Registration of the exact production callback URI in the IdP.
- Agreement on whether platform MFA is enforced at the IdP, locally, or both.

### Next dependency

Workstream 8 — Zeli anomaly detection foundation. The existing deterministic
anomaly monitor remains the baseline; any model-based scoring requires an
approved data set and false-positive review process.
