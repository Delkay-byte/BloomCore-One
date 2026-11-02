# BloomCore One — Security Audit Report

**Branch:** `security/bloomcore-one-security-hardening`
**Audit type:** Manual code review + automated regression testing
**Baseline commit at start:** `193ffff` (`ci: add GitHub Actions workflow`)
**Standards used:** OWASP ASVS 5.0 Level 2 (target), OWASP API Security Top 10
2023, OWASP Authentication/Authorization/Session/Password Storage/CSRF/Input
Validation/SQL Injection/Logging Cheat Sheets.

This report describes code that was inspected, changed and tested. It is not a
penetration-test report and BloomCore One is not OWASP-certified.

## 1. Method

1. Inventoried every authentication entry point, session cookie, guard and API
   route in `src/`.
2. Reviewed all server actions in `src/lib/actions/`, the offline sync API,
   Prisma schema (SQLite and PostgreSQL variants), middleware and `next.config.ts`.
3. Classified findings, fixed them on the security branch, and added automated
   regression tests (`tests/security-hardening.test.ts`,
   `tests/financial-security.test.ts`, plus the existing
   `tests/tenant-isolation.test.ts`).
4. Ran `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`.
   Results are recorded in `SECURITY-TEST-RESULTS.md`.

No production database, production account or production host was modified.
No brute-force or vulnerability scan was run against production.

## 2. Authentication entry points inventoried

| Entry point | Handler | Cookie issued |
|---|---|---|
| Shared portal (customer / MoMo / Susu) | `unifiedLogin` → `resolveCustomerAuth` / `resolveStaffAuth` | `bik-customer-session`, `bik-worker-session`, `bik-collector-session` |
| Tenant administrator | `adminLogin` | `bik-admin-session` |
| Platform operator | `platformLogin` | `bik-platform-session` |
| Customer-only legacy route | `customerLogin` | `bik-customer-session` |
| Dual-role workspace choice | `selectWorkspace` | module cookie + short-lived `bik-workspace-select` |
| Password recovery request / completion | `requestPasswordReset`, `completePasswordReset` | none |
| MFA challenge | `/mfa/verify`, `/mfa/enroll` | `bik-mfa-challenge` (5 min, not a login) |

Legacy fallbacks still accepted: `bik-prestige-token` and pre-hardening JWTs
without `jti`/`iss`/`aud`, until their existing 8-hour expiry. No cookie name was
changed and `JWT_SECRET` was not rotated.

## 3. Confirmed findings

Severity reflects exploitability in the reviewed code. "Fixed" means the code
change is in this branch and is covered by a test where a test was feasible.

### Critical

| ID | Area | Finding | Evidence | Status |
|---|---|---|---|---|
| C-01 | Platform authorization | `getPlatformOverview`, `listTenants`, `getTenantDetail` and `getPlatformAuditPage` called `getPlatformAdminOrNull()` but discarded the result. Any caller able to invoke the server action received platform-wide tenant directories, administrator PII and audit history. | `src/lib/actions/platform.actions.ts` (reads at `getPlatformOverview`, `listTenants`, `getTenantDetail`, `getPlatformAuditPage`) | Fixed — reads now throw unless a live platform session exists (`requirePlatformRead`). |
| C-02 | Account recovery | `requestPasswordReset` returned `_pilotToken` — the raw reset token — to the browser. Anyone who knew an email address could reset that account. | `src/lib/actions/password-recovery.actions.ts` | Fixed — the token is never returned; the field was removed and the UI no longer displays it. Regression test asserts the response contains no token. |
| C-03 | Financial authorization | Offline contribution sync trusted the client-supplied `channel`. Any Susu/worker session could post arbitrary amounts to any account in its tenant with `collectorId: null`, bypassing collector assignment and administrator approval. | `src/app/api/offline/sync-contribution/route.ts` | Fixed — `channel` is enum-validated; non-collector channels require an administrator session; collector channel still requires an active assignment. |

### High

| ID | Area | Finding | Evidence | Status |
|---|---|---|---|---|
| H-01 | Brute force | Rate limiting used a process-local `Map` keyed on email only, and `getClientIp` trusted any `X-Forwarded-For` value. Counters vanished on restart and were per-instance; spoofing the header changed the bucket. | `src/lib/rate-limit.ts` (removed) | Fixed — database-backed counters, HMAC keys, platform-only IP headers. |
| H-02 | Login lockout | No progressive cooldown. Unlimited password guesses were possible until the in-memory limit reset. | `src/lib/actions/auth.actions.ts` | Fixed — 1/5/15-minute progressive cooldown (pair + account dimensions). |
| H-03 | Automated abuse | No CAPTCHA anywhere. | login/forgot-password forms | Fixed — Turnstile client widget + mandatory server verification when enabled. |
| H-04 | Financial integrity | Withdrawal balance and `commissionCharged` were read outside the transaction; two concurrent withdrawals could both charge the first-withdrawal commission and overdraw the cycle. `NaN` passed the `<= 0` check. | `src/lib/actions/susu-withdrawal.actions.ts` | Fixed — validation, single transaction, conditional commission claim, unique idempotency key. |
| H-05 | Financial integrity | Contributions used `Math.floor(amount / dailyContribution)`, crediting the full amount while allocating fewer days. Idempotency key was random server-side, so a retry recorded money twice. | `src/lib/actions/susu-contribution.actions.ts` | Fixed — whole-day validation, in-transaction day allocation, client retry key accepted. |
| H-06 | Session management | Logout only deleted the cookie; a copied JWT stayed valid until expiry. Password change bumped `tokenVersion` but did not revoke the registry because none existed. | `src/lib/auth.ts`, `src/lib/platform-auth.ts` | Fixed — `SessionRecord` registry checked on every guarded request; logout, password change, reset and platform logout revoke server-side. |
| H-07 | Privileged access | No MFA for platform operators or tenant administrators. | — | Implemented — TOTP + recovery codes, encrypted secrets, rollout-gated enforcement. |
| H-08 | Cross-tenant IDOR | Offline sync upserted `OfflineTransaction` by globally unique `idempotencyKey` without checking tenant ownership, allowing a foreign key to be overwritten. | `src/app/api/offline/sync-contribution/route.ts` | Fixed — key ownership is checked; foreign keys return 409. |
| H-09 | Tenant isolation | Customer login matched `customerId`/`email`/`phone` with no tenant filter; identical identifiers across tenants resolved to an arbitrary tenant. | `src/lib/actions/auth.actions.ts` | Fixed — ambiguous matches are refused. |
| H-10 | Session validation | `/api/auth/me` and `/api/auth/session` returned profile/timing data without re-checking user status or token version; a suspended user kept access until JWT expiry. | `src/app/api/auth/me/route.ts`, `src/app/api/auth/session/route.ts` | Fixed — both call `isSessionCurrent()`.

### Medium

| ID | Finding | Evidence | Status |
|---|---|---|---|
| M-01 | `parseFloat(...) || 0` silently stored a typo as zero in daily accounts. | `src/lib/actions/daily-account.actions.ts` | Fixed — invalid input now fails schema validation. |
| M-02 | Draft daily-account edits wrote no audit row. | same | Fixed — `daily_account.updated` audit entry. |
| M-03 | Account status writes accepted arbitrary strings in several staff/worker/collector actions. | `staff.actions.ts`, `worker.actions.ts`, `susu-collector.actions.ts`, `susu-customer.actions.ts`, `location.actions.ts` | Partially fixed in the security-relevant actions; remaining enum tightening is tracked in `PRODUCTION-SECURITY-ROLLOUT.md`. |
| M-04 | Device re-enrolment matched only `(deviceId, tenantId)`, letting another user in the same tenant re-arm a revoked device. | `src/app/api/offline/enroll/route.ts` | Fixed — must belong to the same user. |
| M-05 | No origin check on cookie-authenticated API mutations. | `src/app/api/**/route.ts` | Fixed — `isSameOriginRequest` on offline sync/enrol and device revoke. |
| M-06 | CSP was report-only. | `next.config.ts` | Fixed — enforced CSP, COOP, CORP, adjusted Permissions-Policy. |
| M-07 | Password recovery and MFA attempts had no persistent limits. | recovery/MFA actions | Fixed — persistent per-IP and per-identifier/subject limits. |
| M-08 | Platform mutations had no rate limit. | `platform.actions.ts` | Fixed — per-operator sensitive-action limit. |
| M-09 | Login responses leaked account state (deactivated account, missing module) before password verification. | `auth.actions.ts` | Fixed — state checks run only after a correct password; unknown accounts take a dummy bcrypt comparison. |

### Low / informational

| ID | Finding | Status |
|---|---|---|
| L-01 | `.env.pilot` is tracked but contains only placeholder values (`CHANGE_ME...`, template DB URL). No live secret was found. | Informational; recommend replacing with `.env.pilot.example`. |
| L-02 | `/api/health` exposes the deployed commit SHA. | Accepted: no secret, operationally useful. |
| L-03 | Audit details are a JSON string, not a structured column. | Accepted for now; query by `action`/`entity` works. Append-only is application-level only, not cryptographic. |
| L-04 | Prisma CLI dependency (`deepmerge-ts`) has high-severity advisory affecting config parsing, not runtime queries. Fix requires Prisma 7 (breaking). | Accepted; tracked for a planned upgrade. |
| L-05 | Offline IndexedDB cache is not partitioned per user and uses a static salt. | Out of scope for this branch; documented for follow-up. |

## 4. Blocking items requiring owner action

1. **Password reset delivery.** There is no email provider in the repository.
   The token is now correctly never exposed, which means self-service reset
   cannot deliver a link until an email integration is added. This is a
   deliberate security-over-convenience trade: exposing the token was an
   account-takeover vulnerability. Owner decision required.
2. **Turnstile keys.** The integration is complete but disabled until the
   Cloudflare widget exists and both keys are in Render. See
   `CLOUDFLARE-TURNSTILE-SETUP.md`.
3. **MFA enforcement.** Code is deployed in `optional` mode. The owner must
   enrol both privileged accounts, then set `MFA_ENFORCEMENT=enforce`.
4. **HTTP 429 semantics.** Login is implemented as Next.js server actions, which
   return structured refusal objects rather than HTTP status codes. API routes
   enforce origin and rate limits, but login/recovery do not emit a literal
   `429` response. Migrating these forms to route handlers is the clean fix and
   is listed as a follow-up; the refusal message includes a `Retry-After`-style
   wait time. Do not claim literal 429 compliance for server actions.

## 5. Controls that are not claimed

- No independent penetration test was performed.
- No dynamic application security scan was run against production.
- No formal ASVS or SOC 2 assessment was completed.
- Application-level audit logs are not tamper-proof storage.
- `unsafe-inline` remains in `script-src` because Next.js hydration requires it;
  this is a documented CSP weakness, not an oversight.

---

# Phase 2 — completion audit (2 November 2026)

This section records the work completed after the first release candidate.

## New findings and fixes

| ID | Severity | Finding | Status |
|---|---|---|---|
| P2-01 | Critical | Password recovery could not deliver codes (no email provider) and the previous public flow was removed without a replacement | Fixed with administrator-assisted, hashed, single-use, 30-minute recovery codes. `ADMIN-ASSISTED-RECOVERY.md`. |
| P2-02 | High | MFA enforcement covered only administrators; workers, agents, collectors and customers could sign in with a password only | Every account type now passes the same challenge; `amr = pwd+mfa` is required on every guarded request while enforcing. |
| P2-03 | High | PostgreSQL READ COMMITTED allowed two withdrawals to spend the same balance | Per-account transaction advisory lock; verified by `tests/pg-withdrawal-concurrency.test.ts` against PostgreSQL. |
| P2-04 | High | Offline IndexedDB used one global database and cached the encryption key across users | Per-tenant/per-user databases, scoped device IDs, all offline databases deleted on sign-out, legacy database purged. Verified by `tests/offline-isolation.test.ts`. |
| P2-05 | Medium | Staff/collector/customer/location status accepted arbitrary strings | Central status policy (`active`/`inactive`, active↔inactive only); server-side rejection and audit. `tests/staff-status.test.ts`. |
| P2-06 | High | No auditable correction path for posted financial entries | Compensating reversal entries for withdrawals and contributions; originals preserved; unique `reversalOfId`; audit (`susu.withdrawal_reversed`, `susu.contribution_reversed`). |
| P2-07 | Medium | Customer accounts had no MFA schema | Added to `Customer`; challenge flow supports customer portal accounts. |
| P2-08 | Medium | `MFA_ENFORCEMENT=optional` would not satisfy the mandatory policy | Production rollout flips to `enforce`; every login path applies the challenge. |
| P2-09 | Informational | CSP still allows `'unsafe-inline'` for scripts | Investigated. Next.js nonces require dynamic rendering and per-request headers for every route; static marketing pages would lose hydration without a broader refactor. Retained and documented rather than weakening/breaking the site. |
| P2-10 | Informational | Login server actions return structured refusals, not literal HTTP 429 | Retained to avoid breaking authentication. Messages include the wait time. API routes use real status codes. Follow-up: migrate login to route handlers. |
| P2-11 | Informational | `.env.pilot` is tracked | Contains only placeholders (`CHANGE_ME...`, template URL). No live secret found. No rotation required. |
| P2-12 | Informational | Three high `npm audit --omit=dev` findings | All in `prisma` → `@prisma/config` → `deepmerge-ts` (CLI config parsing). Not reachable from runtime request handling. Fix requires Prisma 7; separate upgrade recommended. |

## Turnstile

Production has `TURNSTILE_ENABLED=true`, a 24-character site key, a 35-character
secret and `TURNSTILE_ALLOWED_HOSTNAMES=bloomcore-one.onrender.com`. The
implementation was verified locally with mocked Siteverify responses and the
widget was verified in production after deployment. Token replay, wrong action,
wrong hostname, missing token, timeout and missing keys all fail closed.

## Remaining limitations

1. Password-reset delivery still depends on an administrator; email delivery is a
   future enhancement, not a release dependency.
2. Reversals cover withdrawals and contributions. Remittance and daily-account
   corrections remain manual audited operations.
3. Two-factor recovery is administrator-assisted; there is no self-service
   recovery without the authenticator or recovery codes.
4. CSP `'unsafe-inline'` remains.
5. Login forms do not emit literal 429 responses.
6. No independent penetration test or DAST was performed.
