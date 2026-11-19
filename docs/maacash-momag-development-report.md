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
