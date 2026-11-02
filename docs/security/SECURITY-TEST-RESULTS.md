# Security Test Results

All commands were run locally on Windows against the SQLite test database. No
production system was contacted.

## 1. Commands

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | Pass — 0 errors |
| `npm run lint` (`eslint`) | Pass — 0 errors, warnings only (pre-existing) |
| `npx vitest run tests/security-hardening.test.ts` | Pass — 14/14 |
| `npx vitest run tests/financial-security.test.ts` | Pass — 5/5 |
| `npx vitest run tests/admin-recovery.test.ts` | Pass — 7/7 |
| `npx vitest run tests/offline-isolation.test.ts` | Pass — 3/3 |
| `npx vitest run tests/staff-status.test.ts` | Pass — 2/2 |
| `npx vitest run tests/mfa-enforcement.test.ts` | Pass — 2/2 |
| `npx vitest run --config vitest.pg.config.ts tests/pg-withdrawal-concurrency.test.ts` (PostgreSQL) | Pass — 2/2 |
| `npx vitest run tests/platform-auth.test.ts` | Pass — 16/16 |
| `npm test` (full suite) | See section 4 |
| `npm run build` (`next build --webpack`) | Pass — production build completed |
| `npm audit --audit-level=critical` | Pass — 0 critical |
| `npm audit --omit=dev` | 3 high (Prisma CLI `deepmerge-ts`; config parsing only) |
| `npx prisma db push` (SQLite) | Pass — schema applied |
| `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema-pg.prisma` | Pass — generated SQL matches the checked-in migration tables/columns |

## 2. Security regression coverage

`tests/security-hardening.test.ts`

1. Persistent fixed-window limit allows N, blocks N+1, survives a new call and
   resets after the window.
2. Stored keys are HMAC digests, never the raw email.
3. Progressive cooldown reaches 1 minute, then 5 minutes, then 15 minutes.
4. Attempts during an active cooldown do not extend `blockedUntil`.
5. A successful authentication clears the progression.
6. Spoofed `X-Forwarded-For` / `X-Real-IP` are ignored when no trusted proxy is
   configured.
7. `True-Client-IP` wins over `X-Forwarded-For` when the trusted proxy is
   configured.
8. A malformed trusted header is rejected rather than used.
9. Turnstile: missing token, wrong action, wrong hostname, replay, upstream
   timeout, and enabled-without-keys all fail closed.
10. A valid Turnstile token is accepted exactly once.
11. TOTP matches the RFC 6238 SHA-1 vector.
12. Recovery codes are single-use.
13. Password recovery never returns a reset token.
14. Password reset rows are created server-side only.

`tests/financial-security.test.ts`

1. Cross-tenant withdrawal is denied and writes no row.
2. `NaN`, `Infinity`, sub-cent and negative amounts are rejected.
3. Replayed withdrawal idempotency key is rejected.
4. A second withdrawal does not charge a second commission.
5. Audit rows are written once per successful withdrawal.

Phase 2 suites also cover:

- administrator recovery authority boundaries, expiry, replay, session
  revocation and customer portal recovery (`tests/admin-recovery.test.ts`);
- offline database partitioning and sign-out deletion
  (`tests/offline-isolation.test.ts`);
- mandatory MFA challenge for workers/customers and rejection of password-only
  sessions (`tests/mfa-enforcement.test.ts`);
- status transition rejection (`tests/staff-status.test.ts`);
- withdrawal and contribution reversals with duplicate protection
  (`tests/financial-security.test.ts`).

`tests/pg-withdrawal-concurrency.test.ts` was executed against the isolated
PostgreSQL rehearsal database after applying every migration. It proved that two
simultaneous 80.00 withdrawals against a 100.00 balance leave exactly one posted
withdrawal and a 10.00 balance, and that a replayed idempotency key posts once.

Existing suites also cover:

- Tenant isolation with two tenants (`tests/tenant-isolation.test.ts`).
- Platform/tenant cookie boundaries (`tests/platform-auth.test.ts`).
- Unified login capability checks (`tests/unified-login.test.ts`).
- Middleware route boundaries (`tests/middleware-boundaries.test.ts`).
- Susu financial logic and operational integrity
  (`tests/susu.test.ts`, `tests/operational-integrity.test.ts`).

## 3. Manual verification performed

- `next build` output includes `/mfa/verify`, `/mfa/enroll`,
  `/admin/security/mfa` and `/platform/security/mfa`.
- Prisma client generation succeeds for the updated schema.
- PostgreSQL migration SQL was compared with Prisma's generated reference SQL;
  table/column definitions match.
- No test or script was run against the Neon production database.

## 4. Full suite result

Recorded from the final run on the security branch:

```
Test Files  22 passed (22)
Tests       270 passed (270)
```

One platform login test was given an explicit 30-second timeout because six
bcrypt cost-12 verifications exceed the default 5-second budget on slower
runners. No assertion was weakened.

## 5. Not tested

- Dynamic scanning (ZAP/Burp) against a deployed instance.
- Independent penetration testing.
- Real Cloudflare Siteverify calls (mocked in tests; manual verification is
  required after keys are configured).
- Neon production migration rehearsals (instructions provided, not executed).
- Load testing beyond the automated race assertions.
- A real Cloudflare token in the automated suite; the live widget was checked
  manually against production after deployment.
