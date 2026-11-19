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
| 1 | Aggregated MoMo figures conceal transaction-level discrepancies | **PARTIALLY ADDRESSED / FOUNDATION** | `MomoTransaction` and the per-day `ledgerMode` cutover exist. Aggregate days remain the default, so an operator can still close a day from totals without individual transactions. Next: 0.5 aggregate-vs-ledger integrity. |
| 2 | Best-effort audit records leave financial actions without evidence | **RESOLVED for money movements; residual control record** | Successful money changes now write audit evidence in the same transaction. `createAuditLog()` remains for non-financial/security events, and the final `finance.approval_applied` summary is still written after the already-audited reversal. |
| 3 | Activity History omits meaningful actor identity | **PARTIALLY ADDRESSED** | Customer actors are now resolved in `/api/audit`; staff names and roles are shown. Legacy/orphaned actor IDs and device attribution still need a full pass. Next: 0.2. |
| 4 | Offline shared-device recovery creates attribution and replay risk | **PARTIALLY ADDRESSED / FOUNDATION** | Per-user IndexedDB scope, device ownership checks, server idempotency and revoked-device refusal exist. Device identity is not yet carried onto every financial ledger row, and shared-device recovery needs a dedicated replay test. Next: 0.3. |
| 5 | Revenue and profit definitions can mislead | **PARTIALLY ADDRESSED** | Performance reporting separates revenue (commission + other income) from principal volume and excludes drafts. Older daily/report screens still use “profit” for net increase. Next: 0.4. |

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
