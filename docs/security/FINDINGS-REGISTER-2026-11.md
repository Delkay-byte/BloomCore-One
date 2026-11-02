# Security Findings Register — November 2026

**Assessment type:** Internal manual review + automated regression testing
**Standard reference:** OWASP ASVS 5.0 Level 2 (engineering reference only)
**Baseline:** `main` at `0a5ba96`
**Branch reviewed:** `feat/bloomcore-ux-offline-reliability`
**Not performed:** independent penetration test, ZAP/DAST scan, formal certification.

Severity reflects exploitability in this codebase with the deployed controls
(MFA, Turnstile when enabled, persistent rate limits, same-origin checks).

## 1. New findings from this work

| ID | Severity | Area | Finding | Evidence | Status |
|---|---|---|---|---|---|
| R-01 | High | Offline data loss | Sign-out deleted every offline database, including unsynchronized financial records. A user who signed out offline lost queued collections permanently. | `src/lib/offline/scope.ts` (`clearCurrentOfflineData`) called from `ConfirmSignOutButton` | **Fixed** — sign-out syncs what it can, then closes without deleting. Records remain in the tenant/user database. Tests: `offline-isolation`, `offline-queue`, `ux-behaviours`. |
| R-02 | Medium | Duplicate synchronization | Two tabs could read the same pending list and submit the same record twice. | `src/lib/offline/sync.ts` | **Fixed** — atomic IndexedDB claim, Web Lock where available, module flag fallback. Server idempotency remains authoritative. Test: `claimTransactionForSync`. |
| R-03 | Medium | Stuck records | A browser closed during a request left a record in `syncing` forever. | same | **Fixed** — `recoverStaleSyncing()` returns claims older than five minutes. |
| R-04 | Medium | Idempotency mismatch | The online contribution action used `CON-<key>` while the offline route used the raw key. A request that committed and then timed out could post twice when the client fell back to the queue. | `susu-contribution.actions.ts`, `api/offline/sync-contribution/route.ts` | **Fixed** — both paths use `CON-<key>`; a unique collision is reconciled to the existing contribution. UI retains the key across retries. Test: `pg-offline-idempotency`. |
| R-05 | Low | API rate-limit semantics | The sync API had no per-user budget and could not return 429. | sync route | **Fixed** — 120/minute per user, literal 429 + `Retry-After`. Test: PostgreSQL route test. |
| R-06 | Low | CSP | `'unsafe-eval'` shipped in production although React/Next.js do not need it. | `next.config.ts` | **Fixed** — development-only. `'unsafe-inline'` remains, assessed in `CSP-ASSESSMENT.md`. |
| R-07 | Low | Secrets hygiene | `.env.pilot` was tracked (placeholders only). | repository | **Fixed** — removed from tracking, replaced by `.env.pilot.example`, `.env.pilot` ignored. No live credential found in history. |
| R-08 | Medium | Offline confidentiality | IndexedDB data is scoped but not encrypted against a device attacker. | offline store | **Accepted risk, documented.** Scoping prevents other accounts in the app from reading it; it does not resist someone with filesystem/browser-profile control. The UI does not claim encryption. |
| R-09 | Medium | Remittance / daily-account correction | No compensating-entry workflow exists for these two record types. | schema and actions | **Open — proposal only.** See §4. |
| R-10 | High | Dependency | `prisma → @prisma/config → deepmerge-ts < 8.0.0` stack-exhaustion advisory. CLI-only path; not reachable from request handling. Fix requires Prisma 7 (breaking). | `npm audit --omit=dev` | **Accepted, tracked.** No uncontrolled Prisma 7 migration in this branch. |
| R-11 | Informational | Draft storage | Local drafts minimize secrets and expire, but may contain customer PII. | `src/lib/offline/drafts.ts` | **Accepted, documented.** |
| R-12 | Informational | Login 429 | Login remains a server action; refusals are structured, not HTTP 429. | auth actions | **Partially fixed** (API surface only). Documented in `HTTP-429-AND-RATE-LIMITS.md`. |

## 2. Previously reported findings — current status

| ID | Area | Status in this branch |
|---|---|---|
| C-01 | Platform read authorization | Fixed previously; unchanged and covered by `platform-auth.test.ts`. |
| C-02 | Reset token disclosure | Fixed previously; unchanged. |
| C-03 | Offline channel trust | Fixed previously; channel and assignment checks remain. |
| H-01/H-02 | Rate limiting / lockout | Fixed previously; persistent counters and progressive cooldown remain. |
| H-03 | Turnstile | Implemented; operational enablement is an owner action. |
| H-04/H-05 | Withdrawal and contribution integrity | Fixed previously; PostgreSQL concurrency tests pass. |
| H-06 | Session revocation | Fixed previously; `SessionRecord` checks remain. |
| H-07/H-08 | MFA and cross-tenant idempotency | Fixed previously; key ownership returns 409. |
| H-09/H-10 | Tenant resolution and session validation | Fixed previously. |
| M-01..M-09 | Validation, audit, device enrolment, origin checks, CSP enforcement, recovery limits | Fixed previously; no regression found. |
| L-01 | `.env.pilot` tracked | Fixed here (R-07). |
| L-02 | Health endpoint exposes commit SHA | Accepted; no secret. |
| L-03 | Audit JSON details, app-level append-only | Accepted; not cryptographically tamper-proof. |
| L-04 | Prisma `deepmerge-ts` | Accepted (R-10). |
| L-05 | Offline cache isolation / static salt | Isolation fixed previously; encryption key is still derived from a session passphrase with a static salt. Treated as obfuscation, not device-compromise protection (R-08). |
| P2-04 | Offline databases deleted on sign-out | Superseded by R-01. |
| P2-06 | Reversals for withdrawals/contributions | Present; remittance/daily account remain (R-09). |
| P2-09 | CSP `unsafe-inline` | Assessed; retained with a migration path. |
| P2-10 | Login 429 | Partially addressed (R-12). |
| P2-12 | Dependency findings | Rechecked (R-10). |

## 3. Controls verified in this assessment

| Area | Verification |
|---|---|
| Authentication / MFA | Existing suites (`mfa-enforcement`, `unified-login`, `platform-auth`, `security-hardening`) pass. Mandatory `amr` enforcement unchanged. |
| Session invalidation | Logout revokes the server record; offline session closure does not revoke the queue. |
| Authorization / tenant isolation | `tenant-isolation`, `staff-status`, `middleware-boundaries`, PostgreSQL suites pass. |
| IDOR | Account, collector, device and idempotency-key ownership checks are tenant scoped. |
| Input validation | Zod schemas and server-side monetary validation unchanged; invalid amounts fail closed. |
| Output encoding / XSS | React escaping, no `dangerouslySetInnerHTML` in changed code, CSP enforced. |
| CSRF | Server actions validate origin; API mutations call `isSameOriginRequest`. |
| SQL injection | Prisma parameterized queries only; no raw SQL in request paths. |
| File uploads | No upload surface in this application. |
| Rate limiting | Persistent DB counters, HMAC keys, fail-closed; new sync budget. |
| Business logic | Whole-day contribution validation, withdrawal balance lock, commission claim, reversal uniqueness. |
| Financial integrity | PostgreSQL concurrency and idempotency tests. |
| Offline synchronization | Claiming, retry, stale recovery, partial batches, 401/429 handling. |
| Error disclosure | Central sanitizer; boundaries never render exception text. |
| Audit integrity | Application-level append-only records; not cryptographic. |
| Sensitive data exposure | No tokens/passwords/secrets in logs or drafts; error payloads sanitized. |

## 4. Remittance and daily-account corrections — proposal

**Finding:** Withdrawals and contributions have compensating reversal entries.
Collector remittances (`CollectorRemittance`) and daily accounts (`DailyAccount`)
do not.

**Why this cannot be implemented safely as a small extension:**

1. **Remittance is a cash-handover observation, not a ledger posting.** Its
   `expectedAmount` is derived from contributions since the previous remittance.
   Adding a negative compensating row would corrupt sums; the correct model is a
   status transition (`reconciled | discrepancy | reversed`) plus exclusion from
   the "last remittance" anchor used to compute the next expected amount.
2. **Daily accounts are unique per location/business date** (`@@unique([locationId,
   businessDate])`). A correction cannot be a second row for the same date
   without changing the uniqueness model. The existing row is a submitted report
   with no `reversedAt`/`supersedesId` fields.
3. Both need new audit actions, permission checks, UI, migration and reporting
   changes. Doing that without a reviewed financial model risks silently
   altering reported cash positions.

**Recommended change (separate branch):**

- Add `reversedAt`, `reversedById`, `reversalReason`, `supersedesId` to
  `CollectorRemittance`; exclude reversed rows from expected-amount anchors;
  add `susu.remittance_reversed` audit.
- Add a `DailyAccountCorrection` (or `supersedesId` + version) model; keep the
  submitted row immutable; make the latest version authoritative; add audit.
- Add PostgreSQL tests for double reversal, permission denial and report totals.
- Obtain owner approval for the reporting semantics before deployment.

## 5. Residual risk statement

- No independent penetration test or authenticated DAST was performed for this
  branch. `PENTEST-READINESS.md` defines the scope and staging needs.
- The application is not OWASP-certified and this register is not a compliance
  certificate.
- The largest residual risks are the unencrypted-at-rest offline database on a
  compromised device (R-08), the Prisma CLI advisory (R-10) and the absence of
  remittance/daily-account corrections (R-09).
