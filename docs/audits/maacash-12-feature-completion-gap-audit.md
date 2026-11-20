# MaaCash 12-feature completion-gap audit

**Audit date:** 20 November 2026  
**Mode:** audit-only. No application source, schema, migration, test, dependency, configuration or environment file was changed.  
**Report path:** `docs/audits/maacash-12-feature-completion-gap-audit.md`

---

## 1. Executive summary

MaaCash has substantial working foundations, but it is **not at 100% internal implementation** across the twelve requested features.

Strictly counting only fully implemented requirements:

- **88 of 154 internally addressable requirements are DONE (57.1%).**
- 39 internal requirements are PARTIAL, 27 are MISSING.
- A further 4 requirements are genuinely BLOCKED_EXTERNAL and 3 are PENDING_ASSOCIATION_DECISION.
- Weighted completion, counting PARTIAL as half, is **69.8% of internal scope**.
- Across all 161 requirements, including external and association-dependent ones, 88 are DONE (54.7%).

The strongest areas are daily MoMo reconciliation, branch cash/float transfers, two-sided shift handovers, offline Susu contribution capture, customer disputes, deterministic anomaly rules and tested BI aggregation.

The largest internal gaps are:

1. **Association-sponsored subscriptions**: only an agreement register exists; there is no sponsor funding, allocation, eligibility, expiry, refund or subscription-link workflow.
2. **Training and certification**: only a training record register exists; no courses, enrolment, attendance, assessment, completion criteria, certificate issue or verification.
3. **Offline operations outside Susu contributions**: withdrawals, reversals, remittances and MoMo close workflows are not offline-capable.
4. **Zeli AI investigation layer**: anomaly triage is deterministic, but there is no AI explanation/evidence/timeline workflow, no structured AI output schema and no finding-provenance validation.
5. **Multi-association structure**: the current model is tenant-scoped membership records, not an association entity with zones, branches, governance or multiple separate associations.
6. **Provider statement import and live provider evidence**: `statement_imported` and `provider_confirmed` are defined states but are unproducible.
7. **Customer identity ownership verification**: portal authentication works, but phone/email ownership is not independently verified.
8. **Messaging operations**: outbox and adapters exist, but there is no delivery scheduler, no SMS status webhook, no tenant-level configuration and no verified opt-in.

Two release-safety findings are material:

- **PostgreSQL migration risk:** the two latest migrations use SQLite `DATETIME` syntax. PostgreSQL schema validation passes, but the migration chain is not proven applicable to PostgreSQL.
- **E2E harness drift:** `scripts/prepare-e2e.mjs` deletes the repository-local `tests/e2e.db`, while the runtime resolves `file:../tests/e2e.db` outside the repository. Repeated preparation can therefore fail on an existing database. Six of 30 desktop browser checks also fail on stale test assumptions.

**Release recommendation: NOT READY** for the 100% internal-completion programme. The branch is suitable for controlled demonstrations of the implemented workflows, not for a claim that all twelve features are complete.

---

## 2. Actual repository, branch, HEAD and working tree

| Item | Observed value |
| --- | --- |
| Repository | Local `BloomCore-One` checkout |
| Branch | `feat/maacash-momag-readiness` |
| HEAD | `dbc61f8e245cb1eae0093b2a5a02bef6fbd1bcf7` |
| HEAD subject | `docs: add DeepSeek, Zeli and fraud-intelligence acceptance audit` |
| Working tree | Clean at start and after verification |
| Production reference | `92d6d974e1e41d7b0586e823f9c000a0a7fe0925` |
| Production reference exists locally | Yes |
| Production reference is ancestor of HEAD | Yes (`git merge-base --is-ancestor` exit 0) |
| Remote operations | None performed |

The historical values supplied in the brief were accurate for this checkout: branch, HEAD, production base and divergence all matched. They were still verified from Git rather than assumed.

No tracked file was modified by this audit. The only new file created is this report. Generated build output, test-results and the disposable E2E database are outside tracked source and were removed or left ignored. The local pre-existing E2E database was backed up before a clean production-build test and restored afterwards.

---

## 3. Commit-distance verification

Commands and observed output:

```text
git rev-parse --abbrev-ref HEAD
feat/maacash-momag-readiness

git rev-parse HEAD
dbc61f8e245cb1eae0093b2a5a02bef6fbd1bcf7

git rev-parse 92d6d974e1e41d7b0586e823f9c000a0a7fe0925
92d6d974e1e41d7b0586e823f9c000a0a7fe0925

git rev-list --left-right --count 92d6d974e1e41d7b0586e823f9c000a0a7fe0925...HEAD
0       62

git merge-base --is-ancestor 92d6d974e1e41d7b0586e823f9c000a0a7fe0925 HEAD
exit 0
```

This means:

- **62 commits ahead** of the production reference.
- **0 commits behind** it.
- The production commit is an ancestor of the local branch, so this is a forward-only local line, not a divergent rewrite.
- Nothing was pushed, fetched, merged, rebased or deployed during the audit.

---

## 4. Overall completion assessment and calculation method

### 4.1 Requirement enumeration

The twelve features were decomposed into **161 meaningful requirements**. A requirement was counted only where it represented a distinct user-visible or data-integrity capability, not a file, route or database table by itself.

Status meanings used:

- **DONE** — working end-to-end through the real application path, with server-side authorization and at least one relevant automated or browser test where practical.
- **PARTIAL** — a real foundation exists and some behaviour works, but at least one necessary part of the requested requirement is absent, not enforced, not exposed or not verified.
- **MISSING** — no working implementation for the stated requirement.
- **BLOCKED_EXTERNAL** — the remaining work genuinely requires a third party, credential, agreement, provider documentation or approval. Internal prerequisites are still reported separately.
- **PENDING_ASSOCIATION_DECISION** — the requirement cannot be finalised without an association policy or dashboard decision.

A screen, table, interface or mock alone was not treated as DONE.

### 4.2 Calculation

Internal scope excludes BLOCKED_EXTERNAL and PENDING_ASSOCIATION_DECISION requirements:

```text
Total requirements                         161
DONE                                        88
PARTIAL                                     39
MISSING                                     27
BLOCKED_EXTERNAL                             4
PENDING_ASSOCIATION_DECISION                 3

Internal scope = 161 - 4 - 3               154
Strict internal completion = 88 / 154       57.1%
Weighted internal completion
  (DONE = 1, PARTIAL = 0.5) = 107.5 / 154   69.8%
All-scope DONE = 88 / 161                   54.7%
```

The weighted figure is shown only to distinguish progress from strict completion. It is **not** a claim of release readiness. A feature is only complete when no requirement in its internal scope is PARTIAL or MISSING.

### 4.3 Feature-level result

No feature reaches 100% internal completion.

| # | Feature | Total | DONE | PARTIAL | MISSING | BLOCKED | PENDING | Internal DONE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Intelligent reconciliation | 14 | 10 | 2 | 1 | 1 | 0 | 76.9% |
| 2 | Advanced cash and float | 13 | 9 | 3 | 0 | 1 | 0 | 75.0% |
| 3 | Employee accountability | 12 | 9 | 2 | 1 | 0 | 0 | 81.8% |
| 4 | Offline operations | 16 | 10 | 2 | 4 | 0 | 0 | 83.3% |
| 5 | WhatsApp and SMS | 17 | 9 | 4 | 2 | 2 | 0 | 60.0% |
| 6 | Customer portal | 15 | 9 | 5 | 1 | 0 | 0 | 64.3% |
| 7 | Customer disputes | 11 | 8 | 3 | 0 | 0 | 0 | 72.7% |
| 8 | Association management | 11 | 5 | 3 | 2 | 0 | 1 | 50.0% |
| 9 | Sponsored subscriptions | 13 | 1 | 3 | 8 | 0 | 1 | 8.3% |
| 10 | Training and certification | 13 | 2 | 2 | 8 | 0 | 1 | 16.7% |
| 11 | Fraud and anomaly monitoring | 12 | 6 | 6 | 0 | 0 | 0 | 50.0% |
| 12 | Business intelligence | 14 | 10 | 4 | 0 | 0 | 0 | 71.4% |
| **Total** |  | **161** | **88** | **39** | **27** | **4** | **3** | **57.1%** |

---

## 5. Twelve-feature scorecard

| Feature | Status | Why |
| --- | --- | --- |
| 1. Intelligent reconciliation | PARTIAL | Strong daily accountability, ledger, reversal and remittance logic; no provider statement import/confirmation and no unified branch asset reconciliation. |
| 2. Advanced cash and float | PARTIAL | Full internal transfer lifecycle and concurrency controls; declared balances only, no provider balances, no formal branch opening/closing snapshot. |
| 3. Employee accountability | PARTIAL | Shifts and two-sided handovers work; no tenant rule making shifts optional/mandatory and limited correction of closed shift records. |
| 4. Offline operations | PARTIAL | Protected, idempotent offline Susu contribution path works in a production build; other financial workflows are absent offline. |
| 5. WhatsApp and SMS | PARTIAL | Good outbox/webhook/provider abstraction; opt-in not verified, no scheduler, no tenant configuration, no live SMS adapter. |
| 6. Customer portal | PARTIAL | Read access, statements, receipts, disputes and preferences work; ownership verification, multiple-account UX, self-service recovery and payment initiation are incomplete. |
| 7. Customer disputes | PARTIAL | End-to-end two-sided dispute lifecycle with no financial mutation; evidence is free text and escalation is notification-only. |
| 8. Association management | PARTIAL | Tenant-scoped member/sponsorship/training registers exist; no association entity, zones, governance or multi-association isolation. |
| 9. Sponsored subscriptions | MISSING | The sponsorship row is an agreement register, not a funding or subscription workflow. |
| 10. Training and certification | MISSING | Only a record of training exists; no course, enrolment, attendance, assessment or certificate lifecycle. |
| 11. Fraud and anomaly monitoring | PARTIAL | Deterministic rules and review work; evidence attachment, investigation timeline and false-positive disposition are incomplete. |
| 12. Business intelligence | PARTIAL | Tested, tenant-scoped aggregate BI and CSV export; MoMo cash/float, data completeness and some operational proxy metrics are incomplete. |

---

## 6. Feature-by-feature audit

### 6.1 Intelligent reconciliation

**Status: PARTIAL**

**Implementation references**

- `src/lib/momo-reconciliation.ts` — `calculateReconciliation`, `resolveStoredDifference`, `encodeReconciliationStatus`, `parseReconciliationStatus`.
- `src/lib/momo-ledger.ts` — transaction definitions, `summariseLedger`, `projectLedgerPosition`, `decideOpeningCarryForward`, idempotency and reference validation.
- `src/lib/momo-ledger-service.ts` — `latestPriorDailyAccount`, `resolveOpeningCarryForward`, ledger summaries.
- `src/lib/actions/momo-ledger.actions.ts` — record, reverse, correct, ledger cutover, opening carry-forward, admin/worker views.
- `src/lib/actions/daily-account.actions.ts` and worker/admin daily-account screens — save, submit, review, correct.
- `src/lib/momo-reconciliation.ts` and `src/lib/performance-report.ts` — expected/actual and variance presentation.
- `prisma/schema.prisma` — `DailyAccount`, `MomoTransaction`, `Expense`, `DailyAccountRevision`, `CollectorRemittance`, `Contribution`, `Withdrawal`.
- Migrations: `20261108_momo_accounting_correction`, `20261109_momo_simplified_daily_account`, `20261124_momo_operational_ledger`, `20261102_financial_corrections`, `20261102_financial_reversals`, `20261130_contribution_device_attribution`, `20261201_momo_verification_state`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 1.1 | MoMo operational transaction ledger with cash/float effects | DONE | `MomoTransaction`; `MOMO_TRANSACTION_DEFINITIONS`; transaction ledger UI; tests. |
| 1.2 | Daily opening and closing cash/E-cash accountability | DONE | `DailyAccount`; integer-pesewa `calculateReconciliation`; balanced/shortage/positive states. |
| 1.3 | Expected versus actual balance | DONE | Opening capital floor, expected close, actual close and difference. |
| 1.4 | Shortage/surplus identification | DONE | Deterministic status and UI labels. |
| 1.5 | Susu contribution/withdrawal reconciliation | DONE | Statements, cycles and remittance variance; tested. |
| 1.6 | Remittance expected-versus-remitted reconciliation | DONE | `CollectorRemittance`; `remittanceVariance`; admin review. |
| 1.7 | Corrections and reversals with immutable history | DONE | Append-only successor/reversal rows; `DailyAccountRevision`; `MomoTransaction` links. |
| 1.8 | Audit history and actor identity | DONE | Atomic `createAuditLogTx`; actor snapshot migration. |
| 1.9 | Branch and multi-business isolation | DONE | Tenant and location scoping throughout services/actions. |
| 1.10 | Transaction-level versus daily aggregate reconciliation | DONE | Explicit `ledgerMode`; `mixed_aggregate_ledger` anomaly; no silent back-fill. |
| 1.11 | Provider statement import workflow | MISSING | `statement_imported` is a label only; no CSV/file importer, mapping, matching or import audit. |
| 1.12 | Provider-confirmed transaction evidence | BLOCKED_EXTERNAL | Requires telco/aggregator API or signed statement. `provider_confirmed` is intentionally unproducible. |
| 1.13 | Exception handling and unresolved discrepancy workflow | PARTIAL | Anomaly acknowledge/resolve and remittance review exist; no unified reconciliation exception case with owner, age and closure evidence. |
| 1.14 | Branch asset balances reconciled to daily cash/float close | PARTIAL | `BranchAssetBalance` is a separate declaration; no branch expected-vs-counted reconciliation tying declarations, daily closes and transfers together. |

**Completed functionality**

- Cash and E-cash are treated as two pockets of the same business money.
- Customer principal movements never enter the accountability formula.
- Commission precedence is explicit: day-total rows override per-transaction commission; the two are never added.
- Reversal/correction rows preserve the original and prevent double counting.
- Opening carry-forward only occurs from a reviewed, balanced prior close.
- Ledger cutover is explicit and historical aggregates are not rewritten.
- Integer-pesewa arithmetic avoids binary floating-point drift.

**Partial/missing**

- No provider statement importer, column mapper, duplicate matching or import reconciliation report.
- No branch-level reconciliation across declared asset balances, transfers and daily close.
- No single exception case record for unresolved reconciliation differences.
- Actual telco transaction evidence cannot be obtained.

**Security/integrity risks**

- Manual declarations can be mistaken for verified provider balances unless labels remain prominent.
- A correct daily close can exist without proof of the underlying customer transactions.
- Two migration files contain SQLite `DATETIME` syntax, which blocks a clean PostgreSQL migration claim.

**Tests**

```text
npx vitest run tests/momo-ledger.test.ts tests/momo-reconciliation.test.ts \
  tests/momo-two-day-reconciliation.test.ts tests/financial-corrections.test.ts \
  tests/financial-definitions.test.ts tests/operational-integrity.test.ts
6 files passed, 70 tests passed.
```

Relevant coverage includes commission precedence, reversal/correction, opening carry-forward, stored legacy differences, and financial definitions.

---

### 6.2 Advanced cash and float management

**Status: PARTIAL**

**Implementation references**

- `src/lib/branch-transfers.ts` — asset definitions, lifecycle transitions, `transferAdjustmentFor`, `assetPosition`, variance and step-up rules.
- `src/lib/actions/branch-transfer.actions.ts` — declare balance, create/request/approve/reject/dispatch/receive/complete/cancel/dispute/resolve.
- `src/app/admin/(workspace)/transfers/page.tsx`, `[id]/page.tsx`; `src/app/worker/(workspace)/transfers/page.tsx`.
- `src/components/momo/TransferStatusBadge.tsx`.
- `prisma/schema.prisma` — `BranchAssetBalance`, `BranchTransfer`, `BranchTransferEvent`.
- Migrations `20261125_branch_cash_float_transfers`, `20261202_branch_transfer_evidence`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 2.1 | Branch-level declared cash and float balances | DONE | `BranchAssetBalance` unique per tenant/location/asset. |
| 2.2 | Cash/float movements between branches | DONE | `BranchTransfer` with asset type and network derivation. |
| 2.3 | Transfer requests | DONE | Draft/requested lifecycle and idempotency key. |
| 2.4 | Approval with separation of duties and high-value step-up | DONE | Requester cannot approve; high-value approval uses step-up grant. |
| 2.5 | Dispatch with evidence | DONE | Dispatcher must belong to source location; evidence text recorded. |
| 2.6 | Receipt with actual amount and variance | DONE | Receiver at destination records actual amount; variance opens investigation. |
| 2.7 | Rejection and cancellation | DONE | Reasons required; reservation released. |
| 2.8 | Partial transfers and failed handovers | PARTIAL | Short receipt and variance investigation exist; no split settlement or remaining-balance transfer. |
| 2.9 | Audit history and accountability | DONE | Immutable `BranchTransferEvent` plus audit log and actor fields. |
| 2.10 | Opening/closing branch balances | PARTIAL | Daily close exists; branch asset declarations are ad hoc and not a formal opening/closing snapshot. |
| 2.11 | Liquidity visibility and reporting | PARTIAL | Declared balance plus transfer adjustment only; no real-time network position or consolidated liquidity report. |
| 2.12 | Concurrency and duplicate-operation protection | DONE | Serializable transactions, retry and unique idempotency/reference keys; tested. |
| 2.13 | Provider-confirmed network float | BLOCKED_EXTERNAL | Requires MTN/Telecel/AT Money access. |

**Completed functionality**

- Transfer availability is reserved at request time and released on rejection/cancellation.
- Declared balances carry a source label: manual declaration, declaration plus transfers, or no declaration.
- Dispatch and receipt roles are location-scoped.
- High-value approvals require step-up.
- Transfer totals move value between locations, never create business money.

**Partial/missing**

- "Partial transfer" means a variance on receipt, not a sanctioned partial settlement.
- No formal branch opening/closing declaration for every business day.
- No liquidity dashboard combining cash, all three network floats and pending transfers.
- No live provider float.

**Security/integrity risks**

- A declared balance can be stale; the system cannot detect a real provider movement.
- Evidence is free text, with no file storage or attachment hash.
- Branch declarations are not linked to daily closes, so conflicting figures can coexist.

**Tests**

```text
npx vitest run tests/branch-transfers.test.ts
1 file passed, 18 tests passed.
```

Covers reservation, lifecycle, self-approval refusal, insufficient balance, no declaration, cancellation/rejection release, concurrent full-balance requests, location roles, variance, step-up, tenant isolation and idempotency.

---

### 6.3 Employee accountability

**Status: PARTIAL**

**Implementation references**

- `src/lib/shifts.ts` — shift statuses, transitions, `computeHandoverVariance`, opening-carry rules and schemas.
- `src/lib/actions/shift.actions.ts` — create/open/close/cancel shift, confirm handover, resolve variance, worker/admin boards.
- `src/app/admin/(workspace)/shifts/page.tsx`, `[id]/page.tsx`; `src/app/worker/(workspace)/shifts/page.tsx`.
- `src/components/momo/ShiftStatusBadge.tsx`.
- `prisma/schema.prisma` — `Shift`, `ShiftHandover`.
- Migrations `20261126_shift_two_sided_handover`, `20261203_shift_handover_evidence`, `20261129_audit_actor_snapshot`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 3.1 | Shift creation with employee and branch assignment | DONE | Admin/worker creation with location and assigned user validation. |
| 3.2 | Opening and closing responsibility | DONE | Only assigned employee opens/closes; administrator cannot submit the employee's count. |
| 3.3 | Two-sided handover | DONE | Outgoing declaration immutable; incoming employee records their own count. |
| 3.4 | Cash/float responsibility | DONE | Separate cash and E-cash counts and variances. |
| 3.5 | Variance explanation | DONE | Receiver must explain a non-zero variance. |
| 3.6 | Manager review and resolution | DONE | Administrator resolves open variance with step-up and note. |
| 3.7 | Employee activity history and actor identity | DONE | Shift board, handovers, audit actor snapshots. |
| 3.8 | Role enforcement | DONE | Worker/admin/location checks in actions and detail view. |
| 3.9 | Shared-device behaviour | PARTIAL | Device attribution exists for recorded MoMo/offline entries; shift handover has no additional per-actor device proof. |
| 3.10 | Business configuration: shifts optional or mandatory | MISSING | No tenant setting; shifts are always available but never enforced by policy. |
| 3.11 | Audit-event reliability | DONE | State changes and audits share transactions. |
| 3.12 | Correction of closed shift records | PARTIAL | Variance resolution exists; shift counts are immutable with no formal correction/revision path comparable to `DailyAccountRevision`. |

**Completed functionality**

- Shift balances never sum into the daily account, preventing double counting.
- Only the assigned employee may submit the outgoing count.
- The receiving employee must be different and at the correct branch.
- A prior shift only seeds the next opening after both sides agree.
- Variances remain open until an administrator resolves them.

**Partial/missing**

- No tenant rule requiring or disabling shifts.
- No shift-level correction/revision record after closure.
- Shared-device identity is based on the session and device attribution, not a fresh device-bound employee check.

**Security/integrity risks**

- A branch can operate entirely without shifts while the product presents shift accountability as available.
- Closed shift figures cannot be corrected through a dedicated audited revision.
- Shared-device use relies on correct sign-in/sign-out discipline.

**Tests**

```text
npx vitest run tests/shift-handover.test.ts tests/audit-actor-attribution.test.ts
2 files passed, 18 tests passed.
```

Covers two-sided counting, carry-forward only after agreement, variance/step-up, no administrator submission, same-person refusal, cross-branch refusal, manual opening explanation, tenant isolation, custom labels, duplicate names, worker restriction, state transitions, non-double-counting and actor attribution.

---

### 6.4 Offline operations

**Status: PARTIAL**

**Implementation references**

- `src/lib/offline/store.ts` — IndexedDB queue, scoped database, transaction/customer/draft stores.
- `src/lib/offline/crypto.ts` — PBKDF2-SHA-256, AES-256-GCM, passphrase/recovery envelope.
- `src/lib/offline/unlock.ts`, `device-store.ts`, `preparation.ts`, `scope.ts`, `session.ts`.
- `src/lib/offline/sync.ts` — claim, sync, retry, auth-expiry pause, backoff.
- `src/lib/offline/payload.ts` — canonical payload, digest and idempotency-key validation.
- `src/app/api/offline/enroll/route.ts`, `src/app/api/offline/sync-contribution/route.ts`.
- `src/app/collector/(workspace)/dashboard/CollectorDashboardClient.tsx`.
- `src/components/OfflineSyncStatus.tsx`, `OfflineUnlockGate.tsx`, `OfflineSessionPrompt.tsx`, `OfflineBootstrap.tsx`, `OfflineDataSettings.tsx`.
- `prisma/schema.prisma` — `DeviceEnrollment`, `OfflineTransaction`.
- Migrations `20260824_add_offline_device_enrollment`, `20260825_offline_security`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 4.1 | Offline Susu contribution capture | DONE | Collector dashboard queues contribution with idempotency key. |
| 4.2 | Offline queue persistence | DONE | IndexedDB transactional store with status/retry metadata. |
| 4.3 | Encryption and device protection | DONE | Required passphrase unlock for prepared offline access; AES-GCM envelopes; recovery code; tested. |
| 4.4 | Idempotency and duplicate prevention | DONE | Payload digest, unique key, server reservation, replay result. |
| 4.5 | Synchronisation and recovery | DONE | Stale `syncing` recovery, partial-success preservation, retry policy. |
| 4.6 | Conflict handling | PARTIAL | Payload mismatch and concurrent duplicate are handled; no general field-level conflict resolution or reviewer queue. |
| 4.7 | Failed-sync retry | DONE | 5 attempts, backoff, 429 handling, session-expiry pause, manual retry state. |
| 4.8 | Device enrolment/revocation | DONE | Tenant/user/device-scoped enrollment; admin revoke/reactivate; revoked device blocked. |
| 4.9 | Connectivity transition behaviour | DONE | Offline/online state reconciliation and tests. |
| 4.10 | Production-build offline behaviour | DONE | Production build tested on Android-sized viewport; prepare/reload/offline unlock/recovery passed. |
| 4.11 | Offline withdrawals | MISSING | No queue type or server route. |
| 4.12 | Offline reversals/corrections | MISSING | No offline workflow. |
| 4.13 | Offline remittances | MISSING | No offline workflow. |
| 4.14 | Offline MoMo workflows | MISSING | `daily_account_draft` exists only as a local store type; no end-to-end server sync or UI flow. |
| 4.15 | Shared-device security risks | PARTIAL | Scoped DB, passphrase, tab/session controls and revoke exist; an unlocked browser remains usable by anyone with the device until lock/sign-out. |
| 4.16 | Clear distinction between local cache and financial truth | DONE | UI labels prepared/offline states; sync status separates pending, failed and acknowledged. |

**Completed functionality**

- The offline queue is not localStorage; it is a scoped IndexedDB store with indexes.
- Local records are protected only after required passphrase setup, not silently stored in plaintext.
- Sync uses the same idempotency key on retry.
- A revoked device or expired authorization pauses the queue instead of marking records permanently failed.
- The production build passes the offline prepare/reload/recover flow.

**Partial/missing**

- Only Susu contributions are genuinely offline end-to-end.
- No offline cash-out/withdrawal, reversal, remittance or MoMo close.
- `daily_account_draft` is a type without a corresponding server sync route/action.
- No conflict-review UI for records changed online while queued.

**Security/integrity risks**

- An unlocked shared device exposes decrypted customer and queue data until session/lock controls act.
- Offline operations outside contributions may tempt users to record work in uncontrolled external notes.
- A queued financial action can be materially stale by the time it syncs; only payload equality is enforced.

**Tests**

```text
npx vitest run tests/offline-attention.test.ts tests/offline-connectivity-transition.test.ts \
  tests/offline-deletion-coordination.test.ts tests/offline-isolation.test.ts \
  tests/offline-module-scope.test.ts tests/offline-payload.test.ts \
  tests/offline-preparation.test.ts tests/offline-queue.test.ts \
  tests/offline-status-state.test.ts tests/offline-sync-attribution.test.ts \
  tests/offline-unlock-hardening.test.ts
11 files passed, 110 tests passed.
```

Production-build browser evidence:

```text
npm run build                                      PASS
E2E_BASE_URL=http://localhost:3101 playwright test e2e/mobile.spec.ts \
  --project=mobile-chromium
3 tests passed, including collector offline prepare/reload/unlock.
```

The earlier development-server failure was not reproduced against the production build.

---

### 6.5 WhatsApp and SMS

**Status: PARTIAL; live delivery BLOCKED_EXTERNAL**

**Implementation references**

- `src/lib/messaging/provider.ts` — channel interface, bounds, mask, mock provider.
- `src/lib/messaging/whatsapp.ts` — Meta Cloud config, `MetaWhatsAppCloudProvider`, allowlist, template-only send, signature verification, error sanitisation.
- `src/lib/messaging/sms.ts` — SMS interface, config surface, `MockSmsProvider` with `delivers: false`.
- `src/lib/messaging/receipts.ts` — receipt content and template parameters.
- `src/lib/messaging/outbox.ts` — consent selection, encrypted recipient, unique event key, delivery, retry, status-event idempotency.
- `src/lib/actions/customer-messaging.actions.ts` — customer preference read/write and audit.
- `src/lib/actions/susu-contribution.actions.ts`, `susu-withdrawal.actions.ts` — enqueue receipt inside financial transaction; queue delivery after commit.
- `src/app/api/webhooks/whatsapp/route.ts` — GET challenge and signed POST status processing.
- `src/components/customer/MessagingPreferencesCard.tsx`.
- `prisma/schema.prisma` — `CustomerMessagingPreference`, `CustomerMessageOutbox`, `CustomerMessageStatusEvent`.
- Migration `20261207_customer_messaging`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 5.1 | WhatsApp consent management | PARTIAL | Preferences and opt-in/opt-out timestamps exist; status becomes "verified" on customer assertion, without OTP/ownership proof. |
| 5.2 | WhatsApp templates | PARTIAL | One environment-configured template name/language; no tenant template registry or approval state. |
| 5.3 | Durable outbox | DONE | Unique event key; encrypted recipient; status/attempts/next attempt. |
| 5.4 | Message generation | DONE | Receipt content with amount/reference/account/status, no PIN/OTP. |
| 5.5 | Provider abstraction | DONE | `WhatsAppProvider` and `SmsProvider`; Meta adapter and mock SMS. |
| 5.6 | Signed webhook verification | DONE | HMAC-SHA256 over raw body with timing-safe comparison and configured secret. |
| 5.7 | Delivery status processing | DONE | Idempotent status event ledger and monotonic status handling. |
| 5.8 | Retry and idempotency | PARTIAL | Outbox retry/backoff exists; no scheduler, so an old pending row retries only when another receipt triggers a delivery run. |
| 5.9 | Error handling | DONE | Provider errors sanitised; no provider body or token logged. |
| 5.10 | Customer preferences | DONE | WhatsApp/SMS numbers, preferred channel, opt-out and audit. |
| 5.11 | Tenant configuration | MISSING | Provider/template settings are global environment values, not per business. |
| 5.12 | Disable-by-default safeguards | DONE | WhatsApp needs configured credentials + explicit enable + allowlist; SMS is mock only. |
| 5.13 | SMS generation/outbox/consent | DONE | Shared receipt outbox and consent; mock SMS. |
| 5.14 | SMS delivery status | PARTIAL | No SMS provider webhook or status adapter; only WhatsApp statuses are processed. |
| 5.15 | Live WhatsApp delivery | BLOCKED_EXTERNAL | Needs Meta WABA, token, approved template, webhook and production enablement. |
| 5.16 | Live SMS delivery | BLOCKED_EXTERNAL | No provider selected or contracted; no real adapter. |
| 5.17 | Consent proof | MISSING | No double opt-in/OTP or provider-verified number ownership. |

**Completed functionality**

- A receipt outbox row is created in the same transaction as the financial event.
- Duplicate confirmations cannot create duplicate messages.
- Recipient numbers are encrypted at rest and only masked in ordinary views.
- Delivery failure never rolls back a contribution/withdrawal.
- WhatsApp status webhooks are signed and idempotent.
- A Meta adapter exists behind multiple explicit gates.

**Partial/missing**

- No scheduled delivery worker; no tenant-scoped template/config.
- No verified opt-in.
- No SMS adapter/status callback.
- No campaign/statement/dispute-update delivery beyond receipt purpose, despite the type supporting it.
- No provider account, approved template or live credential.

**Security/integrity risks**

- A self-asserted number can receive a receipt intended for another person.
- A pending message may remain unsent indefinitely without another receipt event.
- Global configuration prevents one business from using a different template/language safely.
- A mock must never be presented as proof of delivery.

**Tests**

```text
npx vitest run tests/customer-messaging.test.ts tests/receipt-messaging.test.ts \
  tests/sms-messaging.test.ts tests/customer-payment-messaging.test.ts
4 files passed, 25 tests passed.
```

Coverage includes consent selection, duplicate event key, encrypted recipient, mock `simulated` status, signed webhook, status idempotency, bounded retries, SMS mock and no financial rollback.

---

### 6.6 Customer portal

**Status: PARTIAL**

**Implementation references**

- Customer routes under `src/app/customer/(portal)/*`: dashboard, payments, statement, withdrawals, profile, settings, disputes, receipt, error.
- `src/app/customer/login`, `first-login`, `forgot-password`; shared `src/app/login`.
- `src/lib/auth.ts` — `requireCustomer`, `getCustomerSession`, session/tokenVersion checks.
- `src/lib/tenant.ts` — `requireTenantCustomer`, `resolveCustomerTenant`.
- `src/lib/actions/auth.actions.ts` — `resolveCustomerAuth`, customer password change, login throttling and MFA.
- `src/lib/actions/susu-customer.actions.ts` — dashboard/account, payments, withdrawals, statement, receipt, profile.
- `src/lib/actions/account-recovery.actions.ts` — administrator-assisted recovery for customers.
- `src/lib/actions/customer-messaging.actions.ts`.
- `src/lib/susu-statements.ts`.
- `prisma/schema.prisma` — `Customer`, `SusuAccount`, `SusuCycle`, `Contribution`, `Withdrawal`, `Commission`, `CardFee`, `CustomerDispute`, `CustomerMessagingPreference`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 6.1 | Portal authentication | DONE | Account number or phone + password; generic errors; lockout; optional MFA; tab-scoped session. |
| 6.2 | Phone/email ownership verification | MISSING | No customer OTP or email-verification challenge; account creation by staff is the only identity proof. |
| 6.3 | Customer isolation | DONE | Customer ID from session; every query scoped by customerId and tenantId. |
| 6.4 | Account access | DONE | Active account/cycle resolved server-side. |
| 6.5 | Multiple accounts | PARTIAL | Schema supports many accounts; dashboard/profile/cycles use the first active account, while statements aggregate across accounts. No selector. |
| 6.6 | Balances and contribution history | DONE | Dashboard, payments, cycles, statement. |
| 6.7 | Withdrawal and payment workflows | PARTIAL | History and receipt exist; customer cannot initiate or track a withdrawal request, and payments are operator-recorded contributions. |
| 6.8 | Statements and receipts | DONE | Date-filtered statement with running balance; receipt document and customer-scoped lookup. |
| 6.9 | Download/print | PARTIAL | Statement CSV and receipt print exist; no printable statement/PDF statement. |
| 6.10 | Customer profile | DONE | Read-only identity, account, collector and cycle information. |
| 6.11 | Communication preferences | PARTIAL | Preference screen works; verification is self-asserted. |
| 6.12 | Account recovery | PARTIAL | Administrator-assisted recovery and password reset exist; no verified self-service recovery. |
| 6.13 | Mobile usability | DONE | Responsive portal; mobile E2E covers customer/portal and menu. |
| 6.14 | Error and empty states | DONE | Portal error boundary, loading skeletons and explicit empty states. |
| 6.15 | Authorisation and abuse protections | DONE | Turnstile, login throttling, tab-bound sessions, tokenVersion, forced password change, MFA. |

**Completed functionality**

- Customer identity cannot be supplied by the browser; it is resolved from the session.
- Statements and receipts are customer- and tenant-scoped.
- The statement includes contributions, withdrawals, commissions and card fees with a running balance.
- Receipts and statements expose no other customer's data.
- Account recovery is deliberately administrator-assisted and audited.

**Partial/missing**

- No ownership verification of a phone or email.
- No multiple-account selector; first-account assumptions.
- No customer-initiated withdrawal request.
- No printed/PDF statement.
- No self-service recovery.
- No profile editing (read-only profile).

**Security/integrity risks**

- A wrong phone number attached to a customer can receive a receipt or be used as a login identifier.
- Multiple accounts can make dashboard totals ambiguous.
- Administrator-assisted recovery depends on staff identity checks outside MaaCash.

**Tests**

```text
npx vitest run tests/customer-portal.test.ts tests/customer-dashboard-mapping.test.ts \
  tests/susu-statements.test.ts
3 files passed, 27 tests passed.
```

Browser: customer portal workflow is covered in `e2e/role-workflows.spec.ts`, but one assertion is stale (`Payment` label no longer appears on the statement).

---

### 6.7 Customer disputes

**Status: PARTIAL**

**Implementation references**

- `src/lib/customer-disputes.ts` — categories, statuses, transitions, validation schemas.
- `src/lib/actions/customer-dispute.actions.ts` — customer open/respond/cancel; admin review/request-information/resolve.
- `src/app/customer/(portal)/disputes/*`; `src/app/susu/admin/disputes/*`.
- `prisma/schema.prisma` — `CustomerDispute`, `CustomerDisputeEvent`.
- Migrations `20261128_customer_disputes`, `20261204_dispute_evidence_cycle`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 7.1 | Dispute creation and customer ownership | DONE | Customer can dispute only own tenant-scoped contribution/withdrawal. |
| 7.2 | Supported transaction types | PARTIAL | Contributions and withdrawals only; no MoMo transaction/remittance dispute. |
| 7.3 | Evidence submission | PARTIAL | Free-text evidence reference and resolution evidence; no file upload/hash/store. |
| 7.4 | Status transitions | DONE | Open → review → awaiting customer → resolved upheld/declined; cancellation only while open. |
| 7.5 | Two-sided review | DONE | Customer responses and admin notes in an event timeline. |
| 7.6 | Management escalation | PARTIAL | Tenant notification on open/resolve; no assignee, priority, SLA or explicit escalation action. |
| 7.7 | Audit history | DONE | `CustomerDisputeEvent` plus atomic audit log for each transition. |
| 7.8 | Duplicate disputes | DONE | Unique `(tenantId, subjectType, subjectId)`. |
| 7.9 | Tenant isolation | DONE | Tenant/customer scoping in every customer and admin query. |
| 7.10 | Resolution and closure | DONE | Upheld/declined with mandatory note and evidence reference. |
| 7.11 | Financial correction/reversal boundary | DONE | Resolution records `financialMutation: false`; no financial row changes; outcome reference points to separate correction. |

**Completed functionality**

- A dispute is a review record, never a financial posting.
- Customer and administrator both contribute to an immutable event timeline.
- An upheld outcome instructs staff to perform a separate financial correction and record its reference.
- Duplicate disputes and cross-tenant access are blocked.

**Partial/missing**

- Evidence is a text pointer only.
- No MoMo/remittance dispute.
- No assignment/SLA/escalation workflow.
- No automatic link verification between `outcomeReference` and an actual reversal/correction.

**Security/integrity risks**

- A text evidence reference can be fabricated or point outside MaaCash.
- An upheld dispute can be closed without a real correction existing.
- No file retention/chain-of-custody.

**Tests**

```text
npx vitest run tests/customer-disputes.test.ts tests/association-foundation.test.ts
2 files passed, 12 tests passed.
```

Dispute coverage includes ownership, duplicate prevention, status transitions, tenant isolation, audit and no financial mutation.

---

### 6.8 Association management

**Status: PARTIAL; dashboard requirements PENDING_ASSOCIATION_DECISION**

**Implementation references**

- `src/lib/association.ts` — member/sponsorship/training statuses and validation.
- `src/lib/actions/association.actions.ts` — dashboard, member creation/status, sponsorship record/status, training record.
- `src/app/admin/(workspace)/association/page.tsx`.
- `prisma/schema.prisma` — `AssociationMember`, `AssociationSponsorship`, `AssociationTrainingRecord`.
- Migration `20261205_association_foundation`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 8.1 | Membership records | DONE | Member code, business/contact, phone/email, region, status, join date, notes. |
| 8.2 | Zones and regional structures | PARTIAL | Free-text `region`; no zone entity, hierarchy, assignment or reporting. |
| 8.3 | Membership status | DONE | Invited/active/suspended/withdrawn. |
| 8.4 | Sponsorship register | DONE | Sponsor name, plan code, amount, dates, status, reference. |
| 8.5 | Training register | DONE | Title, provider, status, completion/expiry, certificate reference. |
| 8.6 | Access control | DONE | `requireTenantAdmin`; tenant isolation. |
| 8.7 | Reporting | PARTIAL | Counts and dashboard values only; no export, zone/member report or training/sponsorship detail report. |
| 8.8 | Consent and governance | MISSING | No consent record, data-sharing agreement, association charter or governance role. |
| 8.9 | Multiple separate associations | MISSING | No association entity; records belong to one business tenant. |
| 8.10 | Association-level versus business-level isolation | PARTIAL | Tenant isolation exists; no association scope above or across businesses. |
| 8.11 | Association pilot administrator dashboard | PENDING_ASSOCIATION_DECISION | Cannot define roles, reports, zones or permissions without MoMAG/MMAAG consultation. |

**Completed functionality**

- Administrative member, sponsorship and training registers work.
- All writes are tenant-admin-only, audited and marked `financialMutation: false`.
- A sponsorship is explicitly an agreement record, not a payment.

**Partial/missing**

- No association entity or multiple-association model.
- No zones, chapters or regional hierarchy.
- No governance, consent or data-sharing controls.
- No association-facing dashboard or export.

**Security/integrity risks**

- Calling the current register "association management" would overstate the model.
- A single tenant boundary may not match an association with many member businesses.
- Contact data has no consent/provenance record.

**Tests**

```text
npx vitest run tests/association-foundation.test.ts
1 file passed, 6 tests passed (run with disputes above).
```

Covers register creation, status changes, tenant isolation and non-financial audit.

---

### 6.9 Association-sponsored subscriptions

**Status: MISSING**

**Implementation references**

- `src/lib/association.ts`, `associationSponsorshipSchema`.
- `src/lib/actions/association.actions.ts`, `createAssociationSponsorship`, `updateAssociationSponsorshipStatus`.
- `prisma/schema.prisma` — `AssociationSponsorship`; existing `ZeliSubscription`/`ZeliPlan` are unrelated.
- `src/lib/actions/zeli-billing.actions.ts`, `zeli-commerce.actions.ts` — existing direct tenant subscription lifecycle.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 9.1 | Sponsorship agreement record | DONE | Sponsor, member, plan code, amount, dates, status, reference, notes. |
| 9.2 | Sponsor identity | PARTIAL | Free-text `sponsorName`; no sponsor entity, contact, tax/identity or account. |
| 9.3 | Sponsored business/member eligibility | MISSING | No eligibility rule, approval or member-to-tenant link. |
| 9.4 | Funding allocation | MISSING | No allocation, budget, drawdown or credit ledger. |
| 9.5 | Subscription lifecycle linkage | MISSING | Sponsorship is not connected to `ZeliSubscription`, entitlement or payment. |
| 9.6 | Expiry and renewal | MISSING | Dates are recorded but no expiry job, renewal or entitlement change. |
| 9.7 | Funding limits | MISSING | No cap, period budget or over-sponsorship control. |
| 9.8 | Payment and refund accounting | MISSING | No charge, settlement, refund, liability or sponsor statement. |
| 9.9 | Audit trails | PARTIAL | Record/status changes audited; no funding or allocation events. |
| 9.10 | Abuse prevention | MISSING | No duplicate-sponsor, self-sponsor, funding-limit or eligibility checks. |
| 9.11 | Reporting | PARTIAL | Dashboard counts/value of active sponsorships; no utilisation or liability report. |
| 9.12 | Separation of sponsor funding and member ownership | MISSING | No ownership/entitlement distinction. |
| 9.13 | Association funding policy | PENDING_ASSOCIATION_DECISION | Sponsor eligibility, refunds, caps, ownership and renewal policy require association agreement. |

**Completed functionality**

- The agreement register is honest and explicitly non-financial.
- It can capture who agreed to sponsor which member for which plan and period.

**Partial/missing**

- Everything that would make it a functioning sponsorship/funding workflow is absent.
- Existing subscription billing cannot be reused merely by adding a `sponsorshipId`; entitlement ownership, funding liability and refunds need design.

**Security/integrity risks**

- A sponsorship record can be mistaken for paid subscription cover.
- No control prevents a sponsor funding ineligible members or exceeding limits.
- No accounting treatment exists for sponsor funds.

**Tests**

Only register tests exist; there is no funding/subscription test because no workflow exists.

---

### 6.10 Training and certification

**Status: MISSING**

**Implementation references**

- `src/lib/association.ts` — `ASSOCIATION_TRAINING_STATUSES`, `associationTrainingSchema`.
- `src/lib/actions/association.actions.ts` — `createAssociationTraining`.
- `src/app/admin/(workspace)/association/page.tsx` — training record form/table.
- `prisma/schema.prisma` — `AssociationTrainingRecord`.
- Migration `20261205_association_foundation`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 10.1 | Training register | DONE | Title, provider, status, completion/expiry, certificate reference. |
| 10.2 | Courses or learning materials | MISSING | No course, module, content, document or version model. |
| 10.3 | Enrolment | MISSING | No learner/course enrolment record. |
| 10.4 | Attendance | MISSING | No session, attendance or participation record. |
| 10.5 | Assessments | MISSING | No questions, attempts, scores or pass criteria. |
| 10.6 | Completion criteria | MISSING | Status is manually chosen; no rule engine. |
| 10.7 | Certification issue | MISSING | `certificateReference` is free text; no issued certificate record. |
| 10.8 | Certificate verification | MISSING | No public/private verification endpoint or QR/token. |
| 10.9 | Training history | PARTIAL | Rows provide a basic history; no course lifecycle or learner transcript. |
| 10.10 | Association reporting | PARTIAL | Basic counts; no completion, expiry or certificate report. |
| 10.11 | Permissions | DONE | Tenant-admin write, tenant-scoped read. |
| 10.12 | Data retention | MISSING | No retention/expiry policy for training evidence or certificates. |
| 10.13 | Certification standards | PENDING_ASSOCIATION_DECISION | Required competencies, assessors, validity periods and certificate format require association agreement. |

**Completed functionality**

- A training record can be stored and audited.
- It does not falsely claim to grant a licence.

**Partial/missing**

- This is not a learning or certification system. It is a register of manually entered training events.
- No content, enrolment, attendance, assessment, certificate generation or verification.

**Security/integrity risks**

- A manually entered certificate reference is not proof of certification.
- No expiry enforcement or revocation.
- No evidence retention or assessor accountability.

**Tests**

Only register creation/validation is covered by `tests/association-foundation.test.ts`. No training/certification workflow test exists.

---

### 6.11 Fraud and anomaly monitoring

**Status: PARTIAL**

**Implementation references**

- `src/lib/anomaly-rules.ts` — 14 named deterministic rules and thresholds, `evaluateAnomalies`.
- `src/lib/actions/anomaly.actions.ts` — `runAnomalyScan`, `getAnomalyBoard`, `acknowledgeAnomaly`, `resolveAnomaly`.
- `src/app/admin/(workspace)/anomalies/page.tsx`.
- `src/lib/zeli/anomaly-detection.ts` — deterministic grouping/attention briefing; `modelUsed:false`, `externalModel:false`.
- `src/lib/actions/zeli-anomaly.actions.ts` — read-only tenant briefing.
- `prisma/schema.prisma` — `OperationalAnomaly` with unique `(tenantId, fingerprint)`.
- Migration `20261127_deterministic_anomaly_monitoring`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 11.1 | Deterministic finding generation | DONE | 14 threshold rules; same input produces same output. |
| 11.2 | Evidence quality | PARTIAL | Metric/threshold/reference/evidence JSON exist; evidence is summary text plus limited references, not immutable source snapshots. |
| 11.3 | Severity and prioritisation | DONE | High/medium/low plus fixed attention weights for review order. |
| 11.4 | False-positive handling | PARTIAL | Acknowledge/resolve with note; no false-positive reason, tuning workflow or suppression rule. |
| 11.5 | Acknowledgment and resolution | DONE | State transitions with actor, note, timestamp and audit. |
| 11.6 | Finding history | PARTIAL | `lastSeenAt`/evidence are overwritten on rescan; prior values survive only in audit logs, not a finding timeline. |
| 11.7 | Investigation workflow | PARTIAL | No assignee, comments, checklist, attachments, SLA or linked correction. |
| 11.8 | Duplicate finding prevention | DONE | Stable fingerprint and tenant/fingerprint unique key; idempotent upsert. |
| 11.9 | Tenant boundaries | DONE | `requireTenantAdminMomo`; all reads/writes tenant-scoped. |
| 11.10 | Evidence traceability | PARTIAL | Entity type/id and selected references; no guaranteed link to source row version or hash. |
| 11.11 | Monitoring coverage | PARTIAL | Manual on-request scan; no scheduler/continuous monitoring; rules cover selected MoMo/shift/transfer risks only. |
| 11.12 | Tests and operational safety | DONE | Rule, persistence, duplicate, ack/resolve, tenant isolation and triage tests. |

**Completed functionality**

- Every finding comes from a named rule with a fixed threshold.
- A rescan updates the same finding rather than duplicating it.
- Acknowledgment/resolution is audited, and neither changes a financial record.
- Deterministic triage groups findings by employee/branch and labels the score as attention, not probability.
- The UI explicitly states that no AI or scoring model is used.

**Partial/missing**

- No investigation case with assignment/comments/evidence attachments.
- No finding event history beyond audit log.
- No scheduler.
- No false-positive disposition or rule tuning.
- No guaranteed source snapshot/hash.

**Security/integrity risks**

- A resolved finding stays resolved even if the condition persists; there is no automatic reopen.
- Evidence can be changed by a later rescan, weakening historical reproducibility.
- Manual scan frequency can leave a real issue undetected for days.

**Tests**

```text
npx vitest run tests/anomaly-monitoring.test.ts tests/zeli-anomaly-detection.test.ts
2 files passed, 13 tests passed.
```

Coverage includes each major rule, clean period, duplicate prevention, acknowledgment/resolution, tenant isolation and deterministic triage.

---

### 6.12 Business intelligence

**Status: PARTIAL**

**Implementation references**

- `src/lib/zeli/intelligence/metrics.ts` — `buildAnalyticsSnapshot`, `aggregateRange`, `refreshAnalyticsRange`, branch/collector/customer metrics.
- `src/lib/zeli/intelligence/period.ts` — period presets, validation and equal-length comparison.
- `src/lib/zeli/intelligence/insights.ts` — deterministic patterns/recommendations.
- `src/lib/zeli/intelligence/compose.ts` — fact/interpretation/action/hypothesis labels.
- `src/lib/actions/zeli-analytics.actions.ts`; `src/app/admin/(workspace)/zeli-analytics/*`.
- `src/app/api/zeli/analytics/export/route.ts`; `src/lib/csv.ts`.
- `src/lib/performance-report.ts`, `src/lib/actions/performance.actions.ts`, admin/worker performance screens.
- `src/app/admin/(workspace)/reports/page.tsx`, `reports/[id]/page.tsx`; `src/app/susu/admin/reports/page.tsx`.
- `prisma/schema.prisma` — `ZeliAnalyticsDaily`, `ZeliAnalyticsRefresh`, `ZeliEntitlement`.
- Migrations `20261103_zeli_business_intelligence`, `20261104_zeli_commerce_and_provider_control`, `20261120_zeli_tenant_access_and_scheduled_plan`.

**Requirement checklist**

| ID | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| 12.1 | Owner dashboard | DONE | Tenant-admin analytics workspace with KPIs, charts and insights. |
| 12.2 | Multi-branch summaries | DONE | Branch performance and filters; inactive/foreign branch handled as no data. |
| 12.3 | MoMo reports | PARTIAL | Daily-close reports and performance report exist; no consolidated cash/float/liquidity report. |
| 12.4 | Susu reports | DONE | Admin/collector reports, statements, remittances and cycles. |
| 12.5 | Revenue, expenses and commission | PARTIAL | Definitions carefully separate principal volume, commission/other income, expenses and net operating; some Zeli labels use "cash income"/"net cash flow" proxies. |
| 12.6 | Cash and float metrics | PARTIAL | Operational cash/float movement and variance exist; branch declared float is not in Zeli BI. |
| 12.7 | Remittance and variance metrics | DONE | Expected/remitted/variance with reversed rows excluded. |
| 12.8 | Performance trends | DONE | Daily series, branch/collector performance, customer engagement. |
| 12.9 | CSV exports | DONE | Ledger, MoMo reports, statements and Zeli analytics use shared `csvCell`. |
| 12.10 | Data completeness | PARTIAL | Elapsed-day completeness warning and freshness/stale handling; no back-fill, no late-record reconciliation, no operator coverage report. |
| 12.11 | Reporting correctness | DONE | Deterministic snapshot figures verified against seeded source totals in prior and current tests. |
| 12.12 | Time-period boundaries | DONE | Validated presets/custom dates, UTC day buckets, equal-length previous period. |
| 12.13 | Access control | DONE | `requireTenantAdmin` + entitlement check before query; CSV API same guard. |
| 12.14 | Displayed figures reconcile to source records | DONE | Tests compare contribution/withdrawal/remittance/expense totals and branch/collector figures. |

**Completed functionality**

- BI is server-computed and tenant-scoped.
- Reversed records are excluded; completed withdrawals only; remittances exclude reversed rows.
- Period comparisons are equal-length and null when the baseline is not meaningful.
- CSV export excludes customer names, phone numbers, account numbers and transaction IDs.
- The performance report does not call principal volume profit or revenue.
- Analytics aggregates are idempotently refreshed and can serve a stale aggregate with a warning.

**Partial/missing**

- No branch liquidity/float metric.
- No consolidated MoMo cash/float report.
- No data-completeness/back-fill reconciliation for missing operator days.
- Some "net cash flow" figures are operational flows, not accounting cash flow; labels must remain explicit.
- No scheduled aggregation beyond page/refresh triggers.

**Security/integrity risks**

- A stale aggregate can be shown after refresh failure; warning exists but must not be hidden.
- Branch attribution depends on the recording user/collector's assigned location, not a transaction-level branch field.
- A zero day can mean no activity or missing records; completeness warnings are essential.

**Tests**

```text
npx vitest run tests/zeli-analytics.test.ts tests/zeli-analytics-access.test.ts \
  tests/zeli-advanced-insights.test.ts tests/performance-report.test.ts tests/csv-export.test.ts
5 files passed, 27 tests passed.
```

Covers aggregation, reversals, period boundaries, branch attribution, entitlement, exports, insight labels and elapsed-day completeness.

---

## 7. Zeli AI architecture audit and safeguard matrix

### 7.1 What exists

**Conversation and provider layer**

- `src/lib/zeli/service.ts` — `runZeliTurn`; tenant/user identity; local deterministic path; external orchestration only when policy permits; persisted conversation metadata.
- `src/lib/zeli/tools.ts` — read-only tenant-scoped tools and context builder.
- `src/lib/zeli/business-tools.ts` — 11 allow-listed read-only tools with role restrictions and structured facts.
- `src/lib/zeli/providers/tool-orchestrator.ts` — bounded history, tool-call rounds, numeric grounding validation, usage audit, circuit breaker.
- `src/lib/zeli/providers/deepseek-conversation.ts` — synthetic/team-testing provider, bounds, sanitisation, disclosure.
- `src/lib/zeli/providers/conversation-policy.ts` — separate conversational gate; production code constant false.
- `src/lib/zeli/provider-control.ts` — global provider state, emergency disable, tenant authorization, team-testing gates.
- `src/lib/zeli/provider-audit.ts` — hashed identifiers, usage, daily limits, circuit state.
- `src/lib/zeli/gateway.ts`, `provider-policy.ts`, `provider-reasoning.ts`, `insight-package.ts` — aggregate explanation package and legacy policies.
- `src/lib/zeli/anomaly-detection.ts` — deterministic anomaly triage only.
- `src/lib/actions/zeli-anomaly.actions.ts` — read-only anomaly briefing.
- `src/lib/zeli/response-format.ts`, `src/components/zeli/ZeliAnswerView.tsx` — structured human-readable answer sections.
- `src/lib/zeli/title.ts`, history actions and thinking indicator — conversation UX.

**What the AI layer currently does**

- Answers locally from deterministic records.
- Can use external AI only for synthetic/team-testing or a separately locked approved mode.
- External conversational production is disabled by `PRODUCTION_CONVERSATION_APPROVED = false`.
- External aggregate production is disabled by `PRODUCTION_PROVIDER_APPROVED = false`.
- The external tool orchestrator can explain tool facts and validates numeric tokens against those facts.
- The anomaly page can show a deterministic triage briefing with fixed weights.

**What it does not do**

- It does not explain an individual anomaly finding with an AI-generated evidence narrative.
- It does not build an investigation timeline from approved source records.
- It does not identify contradictory or missing evidence.
- It does not produce a structured AI response schema with finding IDs and source references.
- It does not run AI over anomaly evidence in production or Team Testing.
- It does not provide an AI investigation review queue or human approval step.

### 7.2 Intended capability checklist

| ID | AI investigation capability | Status | Evidence / gap |
| --- | --- | --- | --- |
| AI.1 | Explain an existing deterministic finding | MISSING | No AI anomaly tool/prompt; deterministic triage only groups findings. |
| AI.2 | Summarise exact supporting evidence | MISSING | Evidence remains in `OperationalAnomaly.evidence`; no AI evidence renderer. |
| AI.3 | Identify missing or contradictory evidence | MISSING | No comparison against an evidence specification. |
| AI.4 | Build a timeline from approved source records | MISSING | No timeline builder, no approved source-record pack. |
| AI.5 | Suggest investigation questions/next steps | MISSING | Deterministic recommendations exist, but not AI-generated per-finding questions. |
| AI.6 | Distinguish facts from hypotheses | PARTIAL | BI composer has typed statement kinds; no AI anomaly output. |
| AI.7 | Identify uncertainty and limitations | PARTIAL | Deterministic triage limitations exist; not per-finding AI uncertainty. |
| AI.8 | Reference finding and source evidence | PARTIAL | Triage references counts/group labels; no AI citations/finding-ID contract. |
| AI.9 | Produce a structured, validated response | PARTIAL | Numeric text validator for BI chat; no JSON schema for investigation output. |
| AI.10 | Preserve human review and decision-making | PARTIAL | Anomaly ack/resolve is human; no AI draft review workflow. |

**Capability result:** 0 DONE, 5 PARTIAL, 5 MISSING.

### 7.3 Safeguard matrix

| ID | Mandatory safeguard | Status | Evidence / gap |
| --- | --- | --- | --- |
| S.1 | AI never creates/edits/deletes/reverses financial records | DONE | All AI tools/actions are read-only; no write tool exists. |
| S.2 | AI never independently approves transactions | DONE | Approval actions require human server actions and step-up. |
| S.3 | AI never independently resolves/closes an anomaly | DONE | `resolveAnomaly` is human-admin-only; no AI call. |
| S.4 | AI never freezes customers/employees/accounts | DONE | No AI account-status action exists. |
| S.5 | AI never makes a final fraud determination | DONE | Prompts/policies state advisory; deterministic triage labels attention, not probability. |
| S.6 | AI must not invent transactions/evidence/figures | PARTIAL | BI numeric validator checks figures against tool facts; no anomaly evidence validation and no transaction-level provenance. |
| S.7 | Only authorised users access evidence | PARTIAL | Admin tenant guards exist; no dedicated investigation permission/role. |
| S.8 | Minimise personal data in AI context | PARTIAL | Known-tenant identifier redaction and input bounds exist; no anomaly evidence minimiser or PII schema. |
| S.9 | Prevent cross-tenant leakage | DONE | Identity/tenant is resolved server-side; tool queries tenant-scoped; tests cover isolation. |
| S.10 | Validate AI output against a strict schema | MISSING | No AI investigation response schema. |
| S.11 | Protect against prompt injection in descriptions/untrusted content | PARTIAL | System prompt treats content as data; sanitisation and one injection test exist; no anomaly-evidence injection tests. |
| S.12 | Preserve finding IDs and evidence provenance | MISSING | No AI response contract containing finding/source IDs; anomaly evidence can be overwritten by rescan. |
| S.13 | Record AI requests and human decisions appropriately | PARTIAL | Provider usage rows and anomaly audit exist; no AI-investigation request/decision record. |
| S.14 | Keep production AI approval disabled | DONE | Production provider and conversation constants are false; provider is disabled by default. |
| S.15 | Human review remains mandatory | PARTIAL | Human review exists for anomalies, but no AI draft review/approval gate. |

**Safeguard result:** 7 DONE, 6 PARTIAL, 2 MISSING; strict 46.7%.

### 7.4 Required tests before any AI investigation layer is enabled

1. Schema rejection for unknown finding IDs, unsupported claims, missing sources and malformed JSON.
2. Prompt-injection cases embedded in transaction notes, customer names, merchant references and evidence text.
3. Cross-tenant evidence request attempts through every tool and direct action.
4. PII minimisation assertions on the exact AI request payload.
5. Numeric grounding against evidence values, including zero, negative, rounded and repeated values.
6. Hallucinated transaction/evidence tests.
7. Human approval required before any AI draft can influence a finding.
8. Provider timeout/rate-limit/outage fallback to deterministic evidence only.
9. Audit tests proving the finding ID, model, prompt version, evidence hash and reviewer decision are retained.
10. A kill switch and emergency-disable test.

---

## 8. Priority A work backlog

Priority A is every internally implementable gap. Order is by dependency and risk, not by feature number.

### A0 — Release and test safety

1. **Fix PostgreSQL migration compatibility.** Replace SQLite `DATETIME` in `20261205_association_foundation` and `20261207_customer_messaging` with the PostgreSQL type used by the rest of the chain, then apply all 53 migrations to a clean PostgreSQL database. Add a migration smoke test to CI.
2. **Fix the E2E database path.** `scripts/prepare-e2e.mjs` deletes `BloomCore-One/tests/e2e.db`, but `DATABASE_URL=file:../tests/e2e.db` resolves outside the repository at runtime. Make preparation and runtime use one explicit absolute/temp path, and fail if the target is not the disposable database.
3. **Repair stale E2E assertions.** Correction now needs step-up password; shortage submission needs an opening explanation; collector/admin success statuses duplicate banner + toast; customer statement label changed; MoMo workspace now makes three `/api/auth/me?module=momo` calls. Update tests without weakening security assertions.
4. **Add migration and e2e checks to the release gate.** `npm test` excludes all ten `tests/pg-*.test.ts`; the release gate must run them against PostgreSQL.

### A1 — Reconciliation and cash/float

5. **Provider statement CSV importer.** File upload/parse, column mapping, validation, duplicate matching, import batch, reconciliation report, audit and no automatic financial posting.
6. **Branch liquidity snapshot.** Formal branch opening/closing declaration for cash and each network float, linked to daily close and transfer adjustments.
7. **Unified reconciliation exception case.** Owner, age, linked source rows, evidence, notes, resolution and audit.
8. **Partial transfer settlement.** Record a sanctioned partial receipt and either return/close the balance or open a linked follow-up transfer.
9. **Branch asset/close reconciliation view.** Show declared vs transfer-adjusted vs counted close and explain differences.

### A2 — Employee accountability

10. **Tenant shift policy.** Add an explicit business setting for shifts optional/mandatory and enforce it in daily-close readiness.
11. **Shift revision/correction.** Audited correction after closure, preserving the original and requiring manager step-up.
12. **Shared-device actor proof.** Optional per-action PIN/re-auth for sensitive counts on shared devices.

### A3 — Offline operations

13. **Offline withdrawal request** or explicitly restrict offline to contributions in product copy and controls.
14. **Offline remittance capture** with same idempotency/sync guarantees.
15. **Offline reversal/correction request** that cannot post without online authorization.
16. **Offline MoMo daily-account draft** end-to-end, or remove the unused `daily_account_draft` type.
17. **Conflict-review queue** for records changed online while an offline action was pending.
18. **Shared-device lock policy.** Configurable idle lock and immediate re-auth on user switch.

### A4 — Messaging

19. **Consent verification.** Double opt-in or OTP; do not label a self-asserted number “verified”.
20. **Delivery scheduler.** Durable worker/cron with bounded retries and monitoring.
21. **Tenant messaging configuration.** Provider/template/language/allowlist per business.
22. **SMS adapter and status callback** behind explicit gates, or truthful product limitation.
23. **Template registry/approval state.** Track template name, language, status and provider approval.
24. **Delivery operations report.** Pending age, failures, simulated counts, no false “sent”.

### A5 — Customer portal and disputes

25. **Multiple-account selector** and per-account dashboard/statement context.
26. **Customer withdrawal request and tracking**, with authorization and audit.
27. **Printable statement/PDF** in addition to CSV.
28. **Verified self-service recovery**, or clearly retain administrator-only recovery.
29. **Evidence file storage** with hash, retention and access control for disputes and anomalies.
30. **Dispute assignment/SLA/escalation** and verification that an upheld outcome references an actual correction.

### A6 — Association foundation

31. **Association entity and membership link.** Separate association from business tenant; support multiple associations and member businesses.
32. **Zones/chapters/regional hierarchy** with assignment and reporting.
33. **Association roles and permissions.** Association administrator, zone officer, member-viewer, auditor.
34. **Consent and governance records.** Data-sharing consent, membership agreement, access review.
35. **Association reports/exports.** Membership, sponsorship, training, consent and activity.
36. **Association dashboard decisions.** Defer exact dashboard to MoMAG/MMAAG consultation.

### A7 — Training and certification

37. **Course/module model and learning materials.**
38. **Enrolment and attendance.**
39. **Assessment/attempt/pass criteria.**
40. **Certificate issue, expiry, revocation and verification.**
41. **Learner transcript and association reporting.**
42. **Retention and evidence policy.**

### A8 — Sponsored subscriptions

43. **Sponsor entity and eligibility.**
44. **Funding allocation/credit ledger with limits.**
45. **Link sponsorship to subscription entitlement and renewal.**
46. **Expiry/renewal/refund and accounting treatment.**
47. **Abuse controls:** duplicate sponsor, self-sponsor, over-limit, ineligible member.
48. **Sponsor/member ownership separation and reporting.**

### A9 — Anomaly investigation

49. **Finding event history.** Preserve each scan’s evidence/metric/severity rather than overwriting.
50. **Investigation case.** Assignee, status, comments, attachments, checklist, linked correction.
51. **False-positive disposition and rule tuning.**
52. **Scheduler/continuous scan with ownership and alert-fatigue controls.**
53. **Source snapshot/hash and reopening rule** when a resolved condition persists.

### A10 — Business intelligence

54. **Cash/float/liquidity metrics** from branch declarations, transfers and daily closes.
55. **Data completeness/back-fill report** for missing operator days and late records.
56. **Consolidated MoMo report** across daily close, ledger, expenses and float.
57. **Metric dictionary and label review** to keep operational flow separate from accounting revenue/profit.

---

## 9. Priority B external-dependency register

| External capability | Internal readiness | What is blocked | Required external input |
| --- | --- | --- | --- |
| MTN operational integration | No connector. `mtn` is a ledger/asset label only. Declared float and manual transactions work. | Real transaction feed, balance, statement import and provider confirmation. | MTN approval, API/aggregator agreement, credentials, technical docs, sandbox, certification. |
| Telecel operational integration | No connector. `telecel` is a ledger/asset label only. | Same as MTN. | Telecel approval/API or aggregator, credentials, docs. |
| AT Money operational integration | No connector. `at_money` is a ledger/asset label only. | Same as MTN. | AT Money approval/API or aggregator, credentials, docs. |
| WhatsApp production delivery | Adapter, outbox, signed webhook, status processing and allowlist gates exist. | Live template delivery and real status events. | Meta Business/WABA, phone number, permanent token, approved utility template, app secret, verify token, webhook registration. |
| SMS live delivery | Interface, mock, outbox and consent model exist; no real adapter. | Actual SMS delivery and delivery reports. | Selected provider, sender ID, contract, credentials, API docs, status callback. |
| Banking/accounting integrations | No bank feed or accounting connector. CSV export exists. | Bank statement import, reconciliation, accounting sync. | Bank/aggregator and accounting platform agreements, credentials, mapping. |
| Customer identity verification | Portal username/password, lockout, MFA and staff-assisted recovery exist. | Independent phone/email ownership proof and self-service recovery. | SMS/email OTP provider or identity service; approved identity policy. |
| Paystack | Existing hosted checkout/subscription code and webhook tests; not part of the 12 features. | Not applicable to association sponsorship until funding policy is decided. | Existing merchant account, approved use, production keys if ever enabled. |

**Important distinction:** the existence of an adapter or interface does not make an integration complete. MTN, Telecel, AT Money, bank and SMS have no working live connector. WhatsApp has a real transport adapter but no configured production account or approved template.

---

## 10. Priority C AI implementation backlog

### C0 — Prerequisites

1. Define an **AnomalyInvestigationEvidence** schema containing only:
   - finding ID, rule key, severity, status, detected/last-seen timestamps;
   - measured value, threshold, unit and calculation;
   - approved source references and evidence hashes;
   - branch/employee pseudonyms or role labels, not unnecessary PII;
   - allowed limitations and missing-evidence flags.
2. Define a **strict response schema**:
   - `findingId`, `facts[]`, `hypotheses[]`, `missingEvidence[]`, `timeline[]`, `investigationQuestions[]`, `nextSteps[]`, `limitations[]`, `modelMetadata`.
   - Reject unknown finding IDs, unsupported numeric values and empty provenance.
3. Build a **source-record timeline service** with allow-listed event types and tenant-scoped queries.
4. Define a **human review state machine** for AI drafts: draft → reviewed → accepted/rejected, with reviewer and reason.
5. Define retention, redaction and access policy for AI prompts/responses.

### C1 — Implementation

6. Add an anomaly explanation tool that receives a single finding ID and returns the minimised evidence pack.
7. Add a prompt version and schema version.
8. Add an AI draft generator behind a disabled provider interface.
9. Add deterministic fallback: if AI is unavailable, show existing finding evidence only.
10. Add UI for evidence, timeline, missing evidence, questions, limitations and human decision.
11. Add AI request/decision audit.
12. Add a global kill switch and per-tenant authorization.

### C2 — Security tests required

13. Prompt injection in transaction notes, customer names, references and evidence.
14. Cross-tenant finding/evidence access.
15. Hallucinated finding, transaction, amount and date.
16. Unknown finding ID and unsupported claim rejection.
17. PII minimisation payload assertions.
18. Numeric/citation validation.
19. Provider outage/timeout/rate-limit fallback.
20. Human approval cannot be bypassed.
21. Audit completeness and immutability.
22. Emergency disable.

### C3 — Approval

The AI investigation layer must remain disabled in production until a separate security and financial-evidence review is complete. The current `PRODUCTION_PROVIDER_APPROVED = false` and `PRODUCTION_CONVERSATION_APPROVED = false` constants are correct and must not be changed as part of this audit programme.

---

## 11. Association-dependent decisions

These should not be invented. They require MoMAG/MMAAG consultation:

1. Is one MaaCash tenant an association, a member business, or both?
2. How many associations must one deployment support, and how are they isolated?
3. What are the zone/regional/chapter structures and reporting levels?
4. Who may create/suspend a member, and who approves reinstatement?
5. What consent is required to share member data with an association?
6. What reports may an association see about a member business?
7. What is the sponsor eligibility rule (association, bank, NGO, government, member)?
8. Can a sponsor fund part of a subscription, multiple members, or renew automatically?
9. What happens to unused sponsorship funds, refunds, arrears and expired cover?
10. Are sponsorships entitlements, credits, invoices or direct provider payments?
11. What training is mandatory, who assesses it, and what certificate is recognised?
12. How long are training, certificate and dispute evidence retained?
13. What constitutes a fraud escalation to the association, and who decides?
14. What dashboard roles and exports do association officers need?
15. What pilot success measures and reconciliation reports are required?

---

## 12. Regression and release risks

### Critical

1. **PostgreSQL migration chain is not proven.** Two migrations use SQLite `DATETIME`; only schema validation passed. A production PostgreSQL deploy cannot be recommended.
2. **No 100% internal completion.** 27 requirements are MISSING and 39 are PARTIAL; several are core to the association proposition (sponsorship funding, training/certification, offline breadth, AI investigation).
3. **E2E reset is non-deterministic.** The preparation script and runtime resolve different relative database paths.
4. **Six desktop E2E failures remain.** They appear to be stale expectations, but they are unresolved evidence and must not be dismissed.

### High

5. Provider-confirmed and statement-imported evidence cannot be produced.
6. Association sponsorship can be mistaken for paid subscription cover.
7. Training records can be mistaken for certification.
8. Messaging opt-in is self-asserted; a wrong number can receive a receipt.
9. No scheduler for anomaly scans or message delivery.
10. Anomaly evidence can be overwritten on rescan; no investigation timeline.
11. Offline is contribution-only; users may improvise for other workflows.
12. Multiple customer accounts are not represented coherently in the portal.

### Medium

13. BI labels mix operational flow and accounting concepts; the performance report is more precise than some Zeli wording.
14. Branch attribution depends on user/collector location, not a transaction-level branch field.
15. Evidence is free text; no file hash/retention.
16. Resolved anomalies do not reopen automatically.
17. PG tests are excluded from the default suite.
18. The E2E suite is not fully current with recent UI/security changes.

### Low

19. Some tests contain unused variables (96 lint warnings, 0 errors).
20. The `ZeliProviderControl` schema comment uses legacy mode names (`disabled|synthetic|approved`) while code also supports `team_testing`.
21. `store.ts` contains an older comment saying offline storage is not encrypted, although a required unlock path now protects prepared access; the comment should be corrected when code changes are allowed.

---

## 13. Test results with exact commands

### 13.1 Full unit/integration suite

Command:

```text
npx vitest run
```

Result:

```text
Test Files  127 passed (127)
Tests       1356 passed (1356)
```

The default Vitest configuration excludes `tests/pg-*.test.ts`. Ten PostgreSQL test files were therefore **not run**:

- `pg-auth-migration.test.ts`
- `pg-dual-control.test.ts`
- `pg-financial-corrections.test.ts`
- `pg-maacash-operational.test.ts`
- `pg-mfa-replay.test.ts`
- `pg-offline-idempotency.test.ts`
- `pg-step-up.test.ts`
- `pg-susu.test.ts`
- `pg-withdrawal-concurrency.test.ts`
- `pg-zeli-analytics.test.ts`

### 13.2 Targeted feature suites

| Command | Result |
| --- | --- |
| `npx vitest run tests/momo-ledger.test.ts tests/momo-reconciliation.test.ts tests/momo-two-day-reconciliation.test.ts tests/financial-corrections.test.ts tests/financial-definitions.test.ts tests/operational-integrity.test.ts` | 6 files, 70 tests passed |
| `npx vitest run tests/branch-transfers.test.ts` | 1 file, 18 tests passed |
| `npx vitest run tests/shift-handover.test.ts tests/audit-actor-attribution.test.ts` | 2 files, 18 tests passed |
| `npx vitest run tests/offline-attention.test.ts tests/offline-connectivity-transition.test.ts tests/offline-deletion-coordination.test.ts tests/offline-isolation.test.ts tests/offline-module-scope.test.ts tests/offline-payload.test.ts tests/offline-preparation.test.ts tests/offline-queue.test.ts tests/offline-status-state.test.ts tests/offline-sync-attribution.test.ts tests/offline-unlock-hardening.test.ts` | 11 files, 110 tests passed |
| `npx vitest run tests/customer-messaging.test.ts tests/receipt-messaging.test.ts tests/sms-messaging.test.ts tests/customer-payment-messaging.test.ts` | 4 files, 25 tests passed |
| `npx vitest run tests/customer-portal.test.ts tests/customer-dashboard-mapping.test.ts tests/susu-statements.test.ts` | 3 files, 27 tests passed |
| `npx vitest run tests/customer-disputes.test.ts tests/association-foundation.test.ts` | 2 files, 12 tests passed |
| `npx vitest run tests/anomaly-monitoring.test.ts tests/zeli-anomaly-detection.test.ts` | 2 files, 13 tests passed |
| `npx vitest run tests/zeli-analytics.test.ts tests/zeli-analytics-access.test.ts tests/zeli-advanced-insights.test.ts tests/performance-report.test.ts tests/csv-export.test.ts` | 5 files, 27 tests passed |
| `npx vitest run tests/zeli.test.ts tests/zeli-conversation.test.ts tests/zeli-tool-orchestration.test.ts tests/zeli-deepseek-conversation.test.ts tests/zeli-provider-control.test.ts tests/zeli-provider-resilience.test.ts tests/zeli-privacy-gateway.test.ts tests/zeli-team-testing.test.ts tests/zeli-response-format.test.ts tests/zeli-history.test.ts` | 10 files, 106 tests passed |

### 13.3 Static and schema checks

```text
npx tsc --noEmit
exit 0

npm run lint
0 errors, 96 warnings

npx prisma validate --schema=prisma/schema.prisma
valid

npx prisma validate --schema=prisma/schema-pg.prisma
valid
```

### 13.4 Production build

```text
npm run build
BUILD_EXIT=0
```

The build produced the full route table and left the tracked working tree clean.

### 13.5 Browser E2E

**Production build, mobile project:**

```text
E2E_BASE_URL=http://localhost:3101 playwright test e2e/mobile.spec.ts \
  --project=mobile-chromium
3 passed, including collector offline prepare/reload/unlock.
```

```text
E2E_BASE_URL=http://localhost:3101 playwright test \
  e2e/maacash-offline-status.spec.ts e2e/maacash-auth-security.spec.ts \
  --project=mobile-chromium
12 passed.
```

**Production build, desktop subset:**

```text
E2E_BASE_URL=http://localhost:3101 playwright test \
  e2e/zeli.spec.ts e2e/analytics.spec.ts e2e/momo-workflow.spec.ts \
  e2e/correction.spec.ts e2e/role-workflows.spec.ts e2e/responsive.spec.ts \
  --project=chromium
24 passed, 6 failed.
```

The six failures:

1. `correction.spec.ts` — expects the old success message; the current form requires step-up password after confirmation.
2. `momo-workflow.spec.ts` — expected zero `/api/auth/me?module=momo` requests; observed three, while the endpoint still returns `cache-control: no-store`.
3. `momo-workflow.spec.ts` — shortage submission now requires an opening-balance explanation; the test does not fill it.
4. `role-workflows.spec.ts` — collector success `role=status` matches both banner and toast (strict-mode locator collision).
5. `role-workflows.spec.ts` — customer statement no longer contains the expected “Payment” label.
6. `role-workflows.spec.ts` — withdrawal success `role=status` matches both banner and toast.

These are best classified as **acceptance-suite drift**, not proof of a functional regression. They still fail the release gate and must be resolved.

### 13.6 E2E preparation defect observed

The first `node scripts/prepare-e2e.mjs` run failed with a unique tenant-code error because an old `../tests/e2e.db` outside the repository was still in use. The script deletes `tests/e2e.db` relative to the script, not the runtime database resolved by `file:../tests/e2e.db`.

After stopping the old dev server and deleting the actual runtime database, preparation and the production-build tests passed. This is a test-infrastructure defect, not an application-code failure, but it makes repeated E2E runs non-deterministic.

---

## 14. Proposed implementation sequence

### Phase 0 — Safety and evidence

1. Fix PostgreSQL migration typing and prove all migrations on a clean PostgreSQL database.
2. Fix the E2E database path/reset and run PG tests in the release gate.
3. Repair the six stale E2E scenarios without loosening security assertions.
4. Add an implementation evidence matrix to the release checklist.

### Phase 1 — Reconciliation and cash/float

5. Provider statement CSV import and reconciliation batch.
6. Branch opening/closing liquidity snapshot.
7. Unified exception case and branch asset/close reconciliation.
8. Partial receipt settlement and follow-up transfer.

### Phase 2 — Employee and offline

9. Tenant shift policy and mandatory-close enforcement.
10. Audited shift correction.
11. Offline withdrawal/remittance/reversal/MoMo scope decision and implementation.
12. Conflict-review queue and shared-device re-auth.

### Phase 3 — Customer and messaging

13. Verified opt-in/OTP and self-service recovery.
14. Delivery scheduler and tenant messaging configuration.
15. Multiple-account portal, withdrawal request, printable statement.
16. Evidence file storage and dispute escalation.

### Phase 4 — Association foundation

17. Association entity, multiple-association isolation, zones and roles.
18. Consent/governance and association reports.
19. Association dashboard only after MoMAG/MMAAG consultation.

### Phase 5 — Training/certification and sponsorship

20. Course/enrolment/attendance/assessment/certificate lifecycle.
21. Sponsor entity, eligibility, funding limits, allocation ledger.
22. Subscription linkage, expiry/renewal/refund and sponsor reporting.
23. Abuse controls and accounting treatment.

### Phase 6 — Anomaly and AI investigation

24. Finding event history and investigation case.
25. Minimised evidence pack and strict AI response schema.
26. Disabled AI draft adapter, human review queue and audit.
27. Prompt-injection, PII, provenance, numeric and cross-tenant tests.
28. External security/financial-evidence review before any production gate change.

### Phase 7 — BI completion

29. Cash/float/liquidity reporting.
30. Data completeness/back-fill reporting.
31. Consolidated MoMo report and label review.
32. Final full regression and production-build acceptance run.

---

## 15. 100% completion acceptance checklist

A feature can be marked complete only when all applicable boxes are true.

### Repository and verification

- [ ] Branch and HEAD recorded and clean.
- [ ] Full unit/integration suite passes.
- [ ] PostgreSQL tests run against PostgreSQL, not skipped.
- [ ] TypeScript clean.
- [ ] Lint has zero errors.
- [ ] Both Prisma schemas validate.
- [ ] All migrations apply to a clean SQLite database.
- [ ] All migrations apply to a clean PostgreSQL database.
- [ ] Production build succeeds.
- [ ] Production-build E2E suite passes with no stale expectations.
- [ ] E2E preparation resets the actual database used by the app.

### Feature 1 — Reconciliation

- [ ] Internal recordkeeping and daily close reconciled.
- [ ] Branch asset declarations reconciled to daily close.
- [ ] Provider statement import tested with duplicates and unmatched rows.
- [ ] Provider confirmation remains correctly unavailable without external access.
- [ ] Every unresolved exception has an owner, age and closure evidence.

### Feature 2 — Cash and float

- [ ] Branch opening/closing declarations exist.
- [ ] Transfer lifecycle, partial receipt and follow-up settlement tested.
- [ ] Liquidity view explains declared vs transfer-adjusted vs counted.
- [ ] Concurrency and duplicate tests pass.
- [ ] Provider balance remains labelled unavailable.

### Feature 3 — Employee accountability

- [ ] Shift policy is explicit per business.
- [ ] Two-sided handover and variance resolution pass.
- [ ] Closed-shift correction is audited.
- [ ] Shared-device re-auth or policy is tested.
- [ ] No employee figure can be submitted by another role.

### Feature 4 — Offline

- [ ] Every supported offline workflow has a server sync path.
- [ ] Unsupported workflows are blocked and disclosed.
- [ ] Encryption, device revoke, idempotency, retry and conflict tests pass.
- [ ] Production-build offline flow passes.
- [ ] Shared-device lock/re-auth is tested.

### Feature 5 — Messaging

- [ ] Opt-in ownership is verified.
- [ ] Delivery is scheduled and observable.
- [ ] Tenant configuration exists.
- [ ] WhatsApp and SMS adapters are honestly labelled.
- [ ] No mock status is ever shown as delivered.

### Feature 6 — Customer portal

- [ ] Phone/email ownership verified.
- [ ] Multiple accounts usable.
- [ ] Withdrawal request/tracking implemented.
- [ ] Statement print/PDF available.
- [ ] Recovery path verified.
- [ ] Isolation and mobile tests pass.

### Feature 7 — Disputes

- [ ] Evidence storage/hash exists.
- [ ] All supported transaction types are defined.
- [ ] Escalation/assignment exists.
- [ ] Outcome reference is verifiably linked to a correction.
- [ ] No dispute resolution changes money.

### Feature 8 — Association

- [ ] Association entity and multiple associations exist.
- [ ] Zones/regions and roles exist.
- [ ] Consent/governance recorded.
- [ ] Association-level isolation tested.
- [ ] Dashboard agreed with associations.

### Feature 9 — Sponsored subscriptions

- [ ] Sponsor and eligibility model exists.
- [ ] Funding allocation and limits exist.
- [ ] Subscription lifecycle is linked.
- [ ] Expiry/renewal/refund/accounting tested.
- [ ] Sponsor/member ownership is separated.
- [ ] Abuse tests pass.

### Feature 10 — Training and certification

- [ ] Courses/materials exist.
- [ ] Enrolment/attendance/assessment exist.
- [ ] Completion criteria are enforced.
- [ ] Certificates are issued, expiring and verifiable.
- [ ] Retention and reporting exist.

### Feature 11 — Anomaly monitoring

- [ ] Every finding has immutable event history.
- [ ] Investigation case supports assignment/comments/evidence.
- [ ] False-positive disposition and tuning exist.
- [ ] Scheduler and ownership exist.
- [ ] Source provenance is reproducible.
- [ ] No AI makes a final determination.

### Feature 12 — Business intelligence

- [ ] Cash/float/liquidity metrics exist.
- [ ] Data completeness/back-fill is visible.
- [ ] Consolidated MoMo reporting exists.
- [ ] Every metric has a tested definition.
- [ ] Access control and CSV export pass.
- [ ] Displayed figures reconcile to source.

### Zeli AI investigation layer

- [ ] Evidence schema is minimised and tenant-scoped.
- [ ] Strict output schema rejects unknown IDs/claims.
- [ ] Finding IDs and source provenance are mandatory.
- [ ] Prompt-injection and PII tests pass.
- [ ] Human review is mandatory.
- [ ] Production gates remain false until separate approval.
- [ ] Emergency disable tested.

---

## 16. Release recommendation

## NOT READY

The branch is not ready for a claim of 100% implementation of all internally completable functionality.

It is ready for:

- a controlled, read-only demonstration of daily reconciliation, branch transfers, shifts, offline Susu contribution capture, disputes, deterministic anomalies and BI on synthetic data;
- continuation of the implementation programme described in Priority A.

It is not ready for:

- a production PostgreSQL migration;
- association-sponsored subscription commitments;
- a training/certification commitment;
- a claim of association-level multi-tenancy;
- a claim of AI fraud investigation;
- live WhatsApp/SMS delivery;
- a fully reliable E2E release gate.

The next implementation action should be **Phase 0: fix PostgreSQL migration compatibility and the E2E database-reset path**, then complete the reconciliation/cash-float backlog. Those two technical foundations must be stable before adding association funding, training/certification or the AI investigation layer.
