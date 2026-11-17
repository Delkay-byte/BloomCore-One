# MaaCash Security Remediation Register

**Branch:** `security/comprehensive-hardening-sec-01-to-sec-16` (PR #48)
**Baseline:** `d6d1577471733c00278000360a16fe2fea091dcc`
**Register date:** 2026-11-16
**Status:** implementation complete for SEC-01 to SEC-16 at the code/test level; owner review and controlled production deployment remain. GitHub Actions is green on head `787ffcc` (push and pull_request): SQLite, PostgreSQL migration rehearsal, mobile browser, secret scan and CodeQL.

This register is additive to `docs/security/MAACASH-AI-SECURITY-ASSESSMENT.md`. The original
assessment, its subject commit and its findings are preserved unchanged. This document records
the second remediation pass.

## Evidence scope

| Check | Result |
|---|---|
| Unit/integration suites (SQLite) | 86 files, 930 tests passed |
| PostgreSQL suite (disposable `maacash_test`) | CI migration rehearsal + integration suite passed (22 targeted tests locally, including new concurrency cases) |
| TypeScript | `tsc --noEmit` clean |
| ESLint | 0 errors (existing warnings only) |
| Production build | `next build --webpack` succeeded (CI) |
| Migration rehearsal | Fresh database plus legacy-data database both applied cleanly |
| Production data | Not touched. No production migration, deploy, password, MFA or financial record changed. |

## Disposition table

| ID | Original severity | Current status | Implementation | Regression evidence |
|---|---|---|---|---|
| SEC-01 | Critical | **Closed** | Session minting remains in `src/lib/session-issuance.ts`, outside `"use server"`. No exported action accepts a subject id and returns a session. | `tests/security-release-fixes.test.ts`, `tests/security-hardening-round2.test.ts` |
| SEC-02 | High | **Closed** | `isSessionCurrent`, `getTenantContext` and `requirePlatformAdmin` reject persisted upgrade flags on every module. | `tests/auth-email-password.test.ts`, `tests/security-release-fixes.test.ts` |
| SEC-03 | High | **Closed with runtime proof** | Offline sync takes `lockAccountForUpdate` inside the transaction before allocation. Two different keys concurrently allocate days 1–2 and 3–4, never the same day. | `tests/pg-offline-idempotency.test.ts` (new different-key concurrency case) |
| SEC-04 | High (original Medium) | **Closed** | New `StepUpGrant` model and `src/lib/security/step-up.ts`. Grants are hash-only, subject/session/purpose/target/context bound, five-minute TTL, single-use and consumed inside the protected transaction. Wired to withdrawals, withdrawal/contribution/remittance reversals, daily-account corrections, staff/worker/collector password resets, tenant-admin recovery and capability changes; every affected dialog now forwards the returned grant. MFA is required from the authenticated `amr`, never a browser flag. | `tests/security-sec04-06-14.test.ts` (no grant, wrong password, changed amount, replay, expiry, session binding, MFA), `tests/pg-step-up.test.ts` (three concurrent claims, one success; expiry; changed amount) |
| SEC-05 | Medium | **Closed (code), residual documented** | `CF-Connecting-IP` is authoritative; `True-Client-IP` requires explicit opt-in; `X-Forwarded-Host` cannot widen the same-origin allow-list. | `tests/security-hardening-round2.test.ts`; edge behaviour still requires the controlled staging check in residual risk A/I |
| SEC-06 | Medium | **Closed** | `CollectorRemittance.idempotencyKey` plus `(tenantId, idempotencyKey)` unique constraint and request hash. Same key returns the original row; same key with different collector/amount/notes is rejected; P2002 is reconciled to the original. Collector advisory lock retained; reversed contributions excluded; strict money validation retained. | `tests/security-sec04-06-14.test.ts`, `tests/financial-corrections.test.ts`, migration rehearsal |
| SEC-07 | Low | **Closed with runtime proof** | New `MfaRecoveryCode` table, one hashed code per row. Consumption is one conditional `updateMany` with `usedAt: null`. Legacy JSON arrays are migrated at deploy; the lazy compatibility path checks existing rows before inserting, so a migrated subject cannot hit a duplicate-key error. `mfaRecoveryCodes` is retired to `null` on next write. | `tests/pg-mfa-replay.test.ts` (three concurrent uses, exactly one succeeds; replay refused), migration rehearsal preserved user 2, platform 1, customer 2 codes |
| SEC-08 | Low | **Closed** | Workspace selection carries a server-derived `amr`; platform password change re-issues with the current verified `amr`; MFA status is never taken from the browser. | `tests/workspace-switch.test.ts`, `tests/platform-auth.test.ts`, full suite |
| SEC-09 | Low | **Closed** | Closed asset-directory and root-file allow-list. A nested protected path such as `/admin/staff/report.json` no longer inherits the bypass from its extension. | `tests/security-hardening-round2.test.ts` |
| SEC-10 | Low | **Closed** | Public health responses remain minimal. | `tests/security-hardening-round2.test.ts` |
| SEC-11 | Low | **Verified in code and tests; dynamic staging pending** | Siteverify validates success, action, hostname, challenge age and replay; fails closed on timeout/config errors. Unit coverage includes valid, invalid, expired, replay, wrong hostname, missing token, timeout and missing config. No controlled Cloudflare staging run was possible from this environment. | `tests/security-hardening.test.ts`, `tests/turnstile-action-mapping.test.ts` |
| SEC-12 | Low | **Closed** | Broad `.env*` and secret-file ignores remain. | `tests/security-hardening-round2.test.ts`, `.gitignore` |
| SEC-13 | High (dependency) | **Closed** | Upgraded to Prisma 7.10.1 with `@prisma/adapter-pg` / `@prisma/adapter-better-sqlite3` and `prisma.config.ts` / `prisma.pg.config.ts`. `npm audit`: **0 high, 0 critical** (`--omit=dev` also 0). Residual advisories are 10 moderate, all in dev-only tooling (eslint/vitest/minimatch); no `npm audit fix --force` was used. | `npm audit`, `npx tsc --noEmit`, 87 Vitest files / 944 tests, 10 PostgreSQL files / 44 tests, production `next build`, built-server boot with Prisma 7 adapters |
| SEC-14 | Low | **Closed** | `EmailVerificationToken.destinationEmailHash` binds the token to the normalized destination. Consumption refuses a mismatch or a legacy token with no snapshot. Every staff/worker email change invalidates outstanding links, unverifies the address, reissues and audits. | `tests/security-sec04-06-14.test.ts`; migration invalidated all unused legacy tokens |
| SEC-15 | Low | **Closed (code)** | Durable per-subject limits on enroll/confirm/disable (tenant and platform). Pending enrollment secret is reused for 15 minutes; the settings screen exposes an explicit "Generate a new secret" restart action. Disable requires password, current code, reason, explicit confirmation, audit and email notification. | `tests/security-sec04-06-14.test.ts` |
| SEC-16 | Informational | **Partially closed** | Production preflight fails boot when delivery is disabled or sender/API key is missing; it is scoped to the Render production service so CI/E2E runs are not affected. Delivery failures are audited with retryable classification; accounts stay pending and resendable; the token is removed so an undelivered link cannot block resend. No durable cross-process outbox or consolidated operator page was added. | `tests/security-sec04-06-14.test.ts`, instrumentation preflight |

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
| C. Security-event retention/alerting | **Closed in code.** Durable `SecurityEventRecord` + `SecurityAlert` tables, a 365-day pruning job that never touches `AuditLog`/`PlatformAuditLog`, and a platform/admin alert queue for critical events (`tests/security-retention-dual-control.test.ts`; migration `20261117_security_retention_alerting_dual_control`). Storage-level immutability of Neon backups remains an infrastructure control. |
| D. Break-glass administrator | **Closed in code.** Platform MFA reset is step-up + reason bound, requires a second platform administrator where one exists, and otherwise records an audited single-administrator exception plus a critical alert (`tests/security-retention-dual-control.test.ts`). Owner action: keep at least two platform super-admins enrolled. |
| E. Financial dual control | **Closed in code.** Withdrawals at or above `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR` and every reversal require a different administrator's approval, consumed atomically exactly once; a single-administrator tenant can post only through an audited exception. Approvals queue at `/susu/admin/approvals`; PostgreSQL concurrency proof in `tests/pg-dual-control.test.ts`. |
| F. First MFA enrollment | **Closed.** Enrollment now requires a verified channel (user `emailVerified`, active platform account), is challenge-bound and rate-limited per subject, reuses a pending secret for 15 minutes, and notifies the owner on completion and disable (`tests/security-retention-dual-control.test.ts`). |
| G. Offline device protection | Existing AES-GCM/PBKDF2 and lock behavior unchanged. The expanded tamper/cross-tenant test matrix was not added in this pass. |
| H. Service-worker dependency | Fail-closed tab proof unchanged; blocked-worker UX and replay tests were not re-run. |
| I. Dynamic testing | No ZAP/Semgrep/CodeQL/Trivy/Gitleaks run was possible in this environment. `npm audit` (0 high/critical), full unit/integration (87 files / 944 tests), PostgreSQL concurrency (10 files / 44 tests), production build and built-server boot were run. Dynamic staging and secret-history scanning remain owner actions. |

## Prisma 7 migration (SEC-13)

Prisma 7 removed the `datasource.url` property from schema files, so the datasource URL now
lives in configuration and the runtime uses driver adapters.

| Piece | Change |
|---|---|
| `prisma/schema.prisma` (SQLite), `prisma/schema-pg.prisma` (PostgreSQL) | `url`/`directUrl` removed; models unchanged |
| `prisma.config.ts` | SQLite CLI default: `PRISMA_CLI_DATABASE_URL` → `DIRECT_URL` → `DATABASE_URL` → `file:./dev.db` |
| `prisma.pg.config.ts` | PostgreSQL schema + unpooled `DIRECT_URL` for `migrate deploy/status/diff` |
| `src/lib/prisma-client.ts` | `PrismaPg` for `postgresql://`, `PrismaBetterSqlite3` for `file:`; one factory for app and scripts |
| `src/lib/db.ts` | Singleton built through the factory (no more `new PrismaClient()`) |
| `next.config.ts` | Server-only external packages + edge-only ignore for the Node maintenance module, so native drivers never enter the edge bundle |

Rehearsal evidence: all 32 migrations applied to a disposable PostgreSQL 16 container, `migrate diff` reported "No difference detected", and the PostgreSQL suite passed.

## Recurring controls

- Dependency and secret monitoring on every PR and at least monthly.
- Monthly security-event review (failed authentication, MFA changes, email changes, platform recovery, financial reversals).
- Quarterly application-security review.
- Re-review after any authentication, payment, database or infrastructure change.
- Independent penetration test when finances allow.

## Fresh-context reassessment (2026-11-16)

A separate read-only security-review agent reviewed diff `d6d1577..c52de6a` and reported no
privilege-escalation or tenant-isolation bypass. Its actionable findings and dispositions:

| Finding | Disposition |
|---|---|
| Legacy recovery-code lazy backfill could duplicate migration rows and throw | Fixed: compatibility path counts existing rows first; added regression test |
| All three financial reversal dialogs dropped the returned step-up token | Fixed: withdrawal, contribution and remittance reversal UIs now forward the grant |
| Remittance screen never supplied an idempotency key | Fixed: the screen generates and reuses a key until success |
| SEC-16 preflight would fail CI/E2E `next start` | Fixed: preflight is scoped to the Render production service; the production requirement is retained |
| SEC-09 still exempted nested protected paths with known extensions | Fixed: only approved asset directories and root-level files are static; nested `.json/.pdf/.css` protected paths are refused |
| Optional enrollment restart was unreachable | Fixed: settings exposes an explicit restart action |
| Grant revocation/pruning helpers were unwired | Fixed: logged-out/password-changed sessions revoke unused grants; the background sweep prunes expired grants |
| Turnstile allow-list still contained the direct Render host | Removed from the default and the blueprint; edge reachability still needs the staging check |
| Grant context for daily corrections/capability changes is coarse | Accepted residual: still subject/session/purpose/target bound and five-minute single-use |
| SEC-11 blueprint still disables Turnstile | Owner decision: enabling with missing keys fails closed and locks logins; configure keys, then enable |
| Full-history dynamic scans (ZAP/Semgrep/CodeQL/Trivy/Gitleaks) | Open owner/staging work; not claimed as complete |

