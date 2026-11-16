# MaaCash Security Remediation Register

**Branch:** `security/comprehensive-hardening-sec-01-to-sec-16` (PR #48)
**Baseline:** `d6d1577471733c00278000360a16fe2fea091dcc`
**Register date:** 2026-11-16
**Status:** implementation complete for SEC-01 to SEC-16 at the code/test level; owner review and controlled production deployment remain.

This register is additive to `docs/security/MAACASH-AI-SECURITY-ASSESSMENT.md`. The original
assessment, its subject commit and its findings are preserved unchanged. This document records
the second remediation pass.

## Evidence scope

| Check | Result |
|---|---|
| Unit/integration suites (SQLite) | 86 files, 929 tests passed |
| PostgreSQL suite (disposable `maacash_test`) | 4 files, 20 tests passed |
| TypeScript | `tsc --noEmit` clean |
| ESLint | 0 errors (existing warnings only) |
| Production build | `next build --webpack` succeeded |
| Migration rehearsal | Fresh database plus legacy-data database both applied cleanly |
| Production data | Not touched. No production migration, deploy, password, MFA or financial record changed. |

## Disposition table

| ID | Original severity | Current status | Implementation | Regression evidence |
|---|---|---|---|---|
| SEC-01 | Critical | **Closed** | Session minting remains in `src/lib/session-issuance.ts`, outside `"use server"`. No exported action accepts a subject id and returns a session. | `tests/security-release-fixes.test.ts`, `tests/security-hardening-round2.test.ts` |
| SEC-02 | High | **Closed** | `isSessionCurrent`, `getTenantContext` and `requirePlatformAdmin` reject persisted upgrade flags on every module. | `tests/auth-email-password.test.ts`, `tests/security-release-fixes.test.ts` |
| SEC-03 | High | **Closed with runtime proof** | Offline sync takes `lockAccountForUpdate` inside the transaction before allocation. Two different keys concurrently allocate days 1–2 and 3–4, never the same day. | `tests/pg-offline-idempotency.test.ts` (new different-key concurrency case) |
| SEC-04 | High (original Medium) | **Closed** | New `StepUpGrant` model and `src/lib/security/step-up.ts`. Grants are hash-only, subject/session/purpose/target/context bound, five-minute TTL, single-use and consumed inside the protected transaction. Wired to withdrawals, withdrawal/contribution/remittance reversals, daily-account corrections, staff/worker/collector password resets, tenant-admin recovery and capability changes. MFA is required from the authenticated `amr`, never a browser flag. | `tests/security-sec04-06-14.test.ts` (no grant, wrong password, changed amount, replay, expiry, session binding, MFA), `tests/pg-step-up.test.ts` (three concurrent claims, one success; expiry; changed amount) |
| SEC-05 | Medium | **Closed (code), residual documented** | `CF-Connecting-IP` is authoritative; `True-Client-IP` requires explicit opt-in; `X-Forwarded-Host` cannot widen the same-origin allow-list. | `tests/security-hardening-round2.test.ts`; edge behaviour still requires the controlled staging check in residual risk A/I |
| SEC-06 | Medium | **Closed** | `CollectorRemittance.idempotencyKey` plus `(tenantId, idempotencyKey)` unique constraint and request hash. Same key returns the original row; same key with different collector/amount/notes is rejected; P2002 is reconciled to the original. Collector advisory lock retained; reversed contributions excluded; strict money validation retained. | `tests/security-sec04-06-14.test.ts`, `tests/financial-corrections.test.ts`, migration rehearsal |
| SEC-07 | Low | **Closed with runtime proof** | New `MfaRecoveryCode` table, one hashed code per row. Consumption is one conditional `updateMany` with `usedAt: null`. Legacy JSON arrays are migrated and lazily backfilled; `mfaRecoveryCodes` is retired to `null` on next write. | `tests/pg-mfa-replay.test.ts` (three concurrent uses, exactly one succeeds; replay refused), migration rehearsal preserved user 2, platform 1, customer 2 codes |
| SEC-08 | Low | **Closed** | Workspace selection carries a server-derived `amr`; platform password change re-issues with the current verified `amr`; MFA status is never taken from the browser. | `tests/workspace-switch.test.ts`, `tests/platform-auth.test.ts`, full suite |
| SEC-09 | Low | **Closed** | Closed static asset allow-list remains. | `tests/security-hardening-round2.test.ts` |
| SEC-10 | Low | **Closed** | Public health responses remain minimal. | `tests/security-hardening-round2.test.ts` |
| SEC-11 | Low | **Verified in code and tests; dynamic staging pending** | Siteverify validates success, action, hostname, challenge age and replay; fails closed on timeout/config errors. Unit coverage includes valid, invalid, expired, replay, wrong hostname, missing token, timeout and missing config. No controlled Cloudflare staging run was possible from this environment. | `tests/security-hardening.test.ts`, `tests/turnstile-action-mapping.test.ts` |
| SEC-12 | Low | **Closed** | Broad `.env*` and secret-file ignores remain. | `tests/security-hardening-round2.test.ts`, `.gitignore` |
| SEC-13 | High (dependency) | **Partially closed; Prisma major documented** | `npm audit`: 6 high, 0 critical. Production tree: `prisma`, `@prisma/config`, `deepmerge-ts`, all build/CLI reachability only, fixed only by Prisma 7.10.1 (semver-major). `npm audit fix` failed with an npm internal `edgesOut` error; no force upgrade was applied. The Prisma 7 migration requires adapter/generator changes that were not proven safe in this pass. | `npm audit --json`; no runtime path from Next.js request handling |
| SEC-14 | Low | **Closed** | `EmailVerificationToken.destinationEmailHash` binds the token to the normalized destination. Consumption refuses a mismatch or a legacy token with no snapshot. Every staff/worker email change invalidates outstanding links, unverifies the address, reissues and audits. | `tests/security-sec04-06-14.test.ts`; migration invalidated all unused legacy tokens |
| SEC-15 | Low | **Closed (code)** | Durable per-subject limits on enroll/confirm/disable (tenant and platform). Pending enrollment secret is reused for 15 minutes unless an explicit restart is requested. Disable requires password, current code, reason, explicit confirmation, audit and email notification. | `tests/security-sec04-06-14.test.ts` |
| SEC-16 | Informational | **Partially closed** | Production preflight fails boot when delivery is disabled or sender/API key is missing. Delivery failures are audited with retryable classification; accounts stay pending and resendable; the token is removed so an undelivered link cannot block resend. No durable cross-process outbox or consolidated operator page was added. | `tests/security-sec04-06-14.test.ts`, instrumentation preflight |

## Migrations

`prisma/migrations/20261116_security_stepup_recovery_email_remittance/migration.sql`

| Change | Safety |
|---|---|
| `StepUpGrant` table | Additive only |
| `MfaRecoveryCode` table | Additive only |
| Recovery-code backfill | Copies only 64-hex SHA-256 hashes from legacy JSON; `ON CONFLICT DO NOTHING`; plaintext never created |
| `CollectorRemittance.idempotencyKey/requestHash` | Nullable; historical rows keep NULL; unique index allows multiple NULLs |
| `EmailVerificationToken.destinationEmailHash` | Nullable; unused legacy tokens are marked used because their destination cannot be proven |
| `mfaPendingSecretAt` on User/Customer/PlatformSuperAdmin | Additive nullable |

Rehearsal results:

1. Fresh `maacash_test`: all 30 migrations applied.
2. Legacy-data `maacash_test_migration`: 3 user hashes (2 valid), 1 platform hash, 2 customer hashes seeded plus one unused legacy email token. After migration: user 2 active, platform 1 active, customer 2 active; invalid hash was skipped; the legacy email token was invalidated. No rows were deleted.

## Residual risks A–I

| Item | Disposition |
|---|---|
| A. SEC-01 runtime reachability | Static proof remains strong; no isolated staging deployment was created in this environment. Dynamic action-surface inspection remains an owner/staging action. |
| B. PostgreSQL concurrency | Closed for offline contribution allocation, MFA recovery-code consumption, step-up grant consumption, daily-account correction and remittance reversal. The reported `pg-financial-corrections` failure was reproduced and fixed: the PG config did not point the application client at `PG_DATABASE_URL`. All four PostgreSQL files now pass. |
| C. Security-event retention/alerting | Not implemented. Existing `AuditLog`/`PlatformAuditLog` remain append-only through application code, but storage-level immutability, retention policy and alert routing are deployment work. |
| D. Break-glass administrator | Existing fresh MFA proof, reason, audit and rate limits remain. Second-person approval and notification fan-out are not implemented. |
| E. Financial dual control | Not implemented. Single-administrator tenants still need to operate. Step-up, reason capture and audit now apply to corrections/reversals; maker-checker requires a policy and UI project. |
| F. First MFA enrollment | Enrollment is challenge-bound, rate-limited, pending-secret idempotent for 15 minutes and audited. Start/complete email notification is only partially implemented (disable notification is implemented). |
| G. Offline device protection | Existing AES-GCM/PBKDF2 and lock behavior unchanged. The expanded tamper/cross-tenant test matrix was not added in this pass. |
| H. Service-worker dependency | Fail-closed tab proof unchanged; blocked-worker UX and replay tests were not re-run. |
| I. Dynamic testing | No ZAP/Semgrep/CodeQL/Trivy/Gitleaks run was possible in this environment. `npm audit`, full unit/integration, PostgreSQL concurrency and production build were run. Dynamic staging and secret-history scanning remain owner actions. |

## Recurring controls

- Dependency and secret monitoring on every PR and at least monthly.
- Monthly security-event review (failed authentication, MFA changes, email changes, platform recovery, financial reversals).
- Quarterly application-security review.
- Re-review after any authentication, payment, database or infrastructure change.
- Independent penetration test when finances allow.
