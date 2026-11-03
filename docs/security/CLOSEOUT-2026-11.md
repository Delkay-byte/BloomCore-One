# Security Closeout Report — November 2026

**Branch:** `security/closeout-pentest-readiness-2026-11`
**Base:** `security/authenticated-pentest-2026-11` @ `3d0c79e`
**Production:** untouched (`main` @ `0a5ba96`)

## 1. TOTP replay protection

- `verifyTotpStep` returns the matched RFC 6238 time step with the existing ±1
  drift window.
- `verifyMfaCode` atomically claims that step through a conditional
  `updateMany` on `mfaLastTotpStep` for the correct subject table (User,
  Customer, PlatformSuperAdmin). A replay or older step updates zero rows and is
  rejected. Recovery codes remain single-use.
- Persisted in PostgreSQL/SQLite; concurrency-safe across connections.
- Migration: `20261102_mfa_totp_replay`.
- Tests: `tests/mfa-replay.test.ts` (7), `tests/pg-mfa-replay.test.ts` (2,
  including concurrent acceptance). Covered: valid, reused, invalid, older step,
  drift window, recovery, concurrent.

## 2. Financial corrections

- **Remittance:** `reversedAt`, `reversedById`, `reversalReason`; atomic single
  reversal; active queries exclude reversed rows; original preserved.
- **Daily account:** immutable `DailyAccountRevision` snapshots with mandatory
  reason and author; live row corrected under a version guard and unique
  `(dailyAccountId, version)` index; expenses replaced transactionally.
- Migration: `20261102_financial_corrections`; fresh `migrate deploy` and
  `migrate diff` returned no difference.
- Tests: `financial-corrections` (3), `pg-financial-corrections` (2, concurrent
  correction and reversal).
- ADR: `ADR-FINANCIAL-CORRECTIONS.md`.
- UI: remittance reversal action on the Susu remittances screen. Daily-account
  correction is exposed as the admin action; a dedicated correction screen is
  not included in this pass (documented limitation).

## 3. Password lockout

Executed the real `adminLogin` action against an isolated test database with a
synthetic admin:

- 5 wrong passwords produce the progressive cooldown at the 5-failure threshold.
- A correct password during the cooldown is refused; no session cookie is set.
- Clearing the pair/account throttle allows the correct password to reach the
  dashboard.
- Test: `tests/password-lockout-live.test.ts` (2). The existing deterministic
  suite still covers 1/5/15-minute stages, non-extension and success reset.

## 4. Turnstile

- Server verification remains authoritative; browser success is never trusted.
- Added an expired `challenge_ts` test. Existing tests cover missing, wrong
  action, wrong hostname, reuse, upstream timeout and missing keys.
- Live staging verification is pending staging-only keys; production was
  previously enabled and is not claimed disabled.

## 5. CSP

Rechecked. Nonce-based CSP still requires all statically prerendered pages to be
dynamic and nonce-tagged inline styles. No safe partial removal was found. The
enforced policy remains without `unsafe-eval` in production; `'unsafe-inline'`
is an accepted residual.

## 6. Offline and idempotency revalidation

Regression suites pass: canonical payload binding, changed payload 409, one
ledger row on retry, atomic claims, stale recovery, 401/429 handling, pending/
failed/syncing deletion blocks, unreadable queue fail-closed, cross-tab closure,
pending deletion state, scoped deletion and sign-out preservation.

## 7. Audit and dependencies

- Audit is append-only by application convention, not cryptographically sealed.
  A DB superuser or compromised code can modify rows; this is recorded as
  accepted residual risk.
- `npm audit --omit=dev`: 3 high in Prisma CLI `deepmerge-ts`; not runtime
  reachable. Prisma 7 remains a separate compatibility project.

## 8. Final verification

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | 0 errors, warnings |
| `npm test` | 32 files, 347 tests pass |
| PostgreSQL suite | 5 files, 29 tests pass |
| `npm run build` | Pass |
| `npm audit --audit-level=critical` | Exit 0 |
| `npm audit --omit=dev` | 3 high, accepted |

(Update the counts if a later run differs; do not round.)

## 9. Remaining limitations

- No independent penetration test.
- No hosted staging.
- Daily-account correction UI is action-level, not a dedicated screen.
- CSP inline script remains.
- Audit integrity is application-level only.
- Turnstile live staging parity pending keys.
- TOTP replay protection is per-server-step, not device attestation.
