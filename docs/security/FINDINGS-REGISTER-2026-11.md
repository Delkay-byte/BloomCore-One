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
| R-13 | High | Idempotency payload binding | The offline sync route checked key ownership but returned/continued an existing key without proving the retry carried the same transaction. A changed amount, account or channel could reuse the key. | `api/offline/sync-contribution/route.ts` | **Fixed** — payload normalized and validated before the key lookup; SHA-256 canonical digest compared for every state; mismatch returns 409; identical retries reconcile. No schema change. Tests: `offline-payload`, `pg-offline-idempotency`. |
| R-14 | High | Deletion fail-open | Explicit deletion counted only `pending_sync` and treated an unreadable queue as empty. A failed/syncing record could be erased, and a blocked delete was reported as success. | `lib/offline/session.ts`, `scope.ts` | **Fixed** — pending + syncing + failed all block; syncing cannot be acknowledged away; read errors block; `onblocked` rejects and the UI reports failure. Tests: `offline-isolation`. |
| R-15 | Medium | Cross-tab account switch | A second login in another tab changed the shared cookie while an old tab kept rendering the previous user's authenticated shell and could access the old offline scope. | `components/TabSessionGuard.tsx` | **Fixed** — BroadcastChannel session signal, server identity revalidation, offline-scope close, per-tab flag clear and fail-closed blocked state. Two-tab online/offline scenario verified in a real browser; unit tests in `cross-tab-session`. |

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
| Financial integrity | PostgreSQL concurrency and idempotency tests, including payload-bound key reuse. |
| Offline synchronization | Claiming, retry, stale recovery, partial batches, 401/429 handling, canonical payload binding. |
| Offline deletion | Fail-closed counts, active-sync block, unreadable-queue block, blocked-delete failure reporting. |
| Cross-tab session | BroadcastChannel signal, server identity revalidation, offline-scope closure, fail-closed offline state. |
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

---

# Authenticated staging assessment — 2 November 2026

**Branch:** `security/authenticated-pentest-2026-11` (from `a71cb1c`)
**Environment:** local production-mode deployment with isolated PostgreSQL 16 (`bloomcore_staging`), MFA enforced, synthetic tenants A/B.
**Not claimed:** independent penetration test, formal certification, active authenticated ZAP scan against financial endpoints.

## New findings

| ID | Severity | Area | Finding | Evidence | Status |
|---|---|---|---|---|---|
| PT-01 | High | Availability / release integrity | Route-level `loading.tsx` shells wrapped statically prerendered pages. Production HTML contained only the skeleton and a hidden page payload; navigation never revealed the page. `/`, `/admin/login`, `/susu/admin/customers` were affected. | Browser body `Loading content…`; hidden `S:0`; `window.__next_f.length === 0`; build showed `○ (Static)` for the affected routes | **Fixed** in `484270f` — removed root/group loading shells; static pages render; added `tests/production-rendering`. |
| PT-02 | High | Offline data integrity | IndexedDB deletion rejected the promise on `blocked` while the browser request stayed queued, and tabs were not coordinated before deletion. Users could see "failed" and later loss. | `deleteDatabase` old `onblocked -> reject`; no cross-tab close protocol | **Fixed** in `a9d702e` — BroadcastChannel closure coordination, pending-state reporting, no false success, retest tests. |
| PT-03 | Informational | Test environment | The first staging MFA key was 29 bytes, so encryption fell back to a development derivation during seeding; MFA verification failed. | `base64.b64decode` length 29; staging re-seed with a 32-byte key succeeded | **Environmental — corrected.** Staging setup now requires a 32-byte key and uses the same value for seed and runtime. |
| PT-04 | Low | CSP | `script-src` still allows `'unsafe-inline'`; authenticated ZAP confirms the warning. | `zap-auth-baseline.json`, rule 10055 | **Accepted, documented** in `CSP-ASSESSMENT.md`. `'unsafe-eval'` is production-removed. |
| PT-05 | Low | Caching | Static `_next` assets are cacheable; authenticated responses are `no-store`. ZAP reports both as informational. | ZAP rules 10049/10050 | **Accepted** — intended CDN behaviour for immutable assets. |

## Controls that resisted live testing

| Area | Probe | Result |
|---|---|---|
| Password-only MFA bypass | Login password, then request `/api/auth/me?module=admin` and `/admin/dashboard` before TOTP | `401`; dashboard `307` to MFA/login |
| MFA rate limit | Repeated invalid verify attempts | "Too many verification attempts. Please wait 5 minute(s)" |
| Recovery-code replay | Reuse a consumed recovery code | `Invalid verification code` |
| Cross-tenant user IDOR | Tenant B admin requests Tenant A user id (`/api/user/:id`) | `404 User not found` |
| Cross-tenant audit | Tenant B `/api/audit` | only Tenant B rows (`total: 0`) |
| Cross-tenant device list | Tenant B `/api/admin/devices` | only Tenant B devices |
| Cross-tenant offline sync | Tenant B device posts Tenant A account | `404 Account not found`; no posting |
| Role escalation | Collector token to `/api/audit`, `/api/admin/devices`, admin `/api/auth/me`, `/admin/dashboard`, `/platform/dashboard` | `403 / 401 / 307` as appropriate |
| Platform boundary | Tenant admin to `/platform/dashboard` | `307` to `/platform/login` |
| CSRF / origin | Cross-origin POST to offline enroll | `403 Request origin is not allowed` |
| Stored XSS | Customer name `<img src=x onerror=...>` | stored literally, rendered escaped (`&lt;img`), `window.__xss` unset |
| SQL injection | `' OR 1=1--` customer search | no results, no SQL/Prisma error |
| Suspended session | Minted admin session, account set inactive, `/api/auth/me` | `401 Not authenticated` |
| Offline idempotency | Same key + same payload retry | first `200`, retry `200 already processed`, one ledger row |
| Offline payload binding | Same key + changed amount | `409` |
| Authenticated passive ZAP | Admin session injected for scan | 0 FAIL, 8 WARN, 60 PASS |

## Potential / unverified

- TOTP replay inside the same 30-second window was not conclusively exercised; the platform does not store a per-code consumed counter. Recorded as a potential hardening item, not a confirmed vulnerability.
- Login password lockout was verified by automated tests, not by a live 5-attempt sequence.
- Active authenticated ZAP scanning was **not** run: it would submit forms and risk financial mutations. Only passive authenticated scanning was performed.
- Turnstile was disabled in staging (no staging keys); production enablement remains an owner action.

## Environmental limitations

- No hosted Render/Neon staging was created (cost/credentials). The assessment used a local production-mode build with isolated PostgreSQL. This is not a substitute for testing a deployed staging service; external-test setup requirements are in `PENTEST-READINESS.md`.
- ZAP CLI cannot complete TOTP; a server-minted test session (JWT + `SessionRecord`) was used for passive authenticated scanning. The minting helper is not committed.

---

# Security closeout — 2 November 2026

Branch: `security/closeout-pentest-readiness-2026-11`

| ID | Severity | Area | Finding / decision | Status |
|---|---|---|---|---|
| SC-01 | Medium | MFA replay | A valid TOTP step could be accepted more than once within its window; state was in-memory-free and not per-step. | **Fixed** — `User`/`Customer`/`PlatformSuperAdmin.mfaLastTotpStep`; atomic conditional `updateMany`; ±1 drift; recovery codes unchanged. Tests: `mfa-replay` (7), `pg-mfa-replay` (2). |
| SC-02 | Medium | Remittance corrections | No safe reversal path; naive negative rows would corrupt the expected-cash anchor. | **Fixed** — `reversedAt/reversedById/reversalReason`, atomic single reversal, active queries exclude reversed rows. ADR §Remittance. |
| SC-03 | Medium | Daily-account corrections | No correction path; duplicate row would violate location/date uniqueness. | **Fixed** — `DailyAccountRevision` immutable snapshots + live row correction, mandatory reason, atomic version guard. ADR §Daily account. |
| SC-04 | Low | Password lockout live evidence | Previous internal staging did not complete a live repeated-password sequence. | **Covered by deterministic integration** (`security-hardening`): 1/5/15-minute progression, cooldown non-extension, success reset, pair + account buckets. Live re-run not repeated in this pass; documented. |
| SC-05 | Low | Turnstile expired token | No explicit expired-challenge test. | **Fixed test coverage** — added expired timestamp test; existing missing/invalid/hostname/action/replay/timeout/configuration tests remain. Live staging keys still unavailable. |
| SC-06 | Low | CSP `unsafe-inline` | Nonce/hash migration assessed as a broader dynamic-rendering change. | **Accepted residual** — policy unchanged; `unsafe-eval` remains production-removed. |
| SC-07 | Informational | Audit integrity | Audit rows are append-only by application convention, not cryptographically chained; a database superuser or compromised application code can alter them. | **Accepted** — documented; hash chaining/external retention is a future project. |
| SC-08 | Informational | Dependency advisory | `prisma → @prisma/config → deepmerge-ts` high advisory remains CLI-only. | **Accepted** — Prisma 7 migration is a separate compatibility project. |

No Critical or High finding remains open from the code-addressable set. This is
an internal status, not independent verification.
