# MaaCash Email Verification, Password Reset and Mandatory Password Upgrade

**Status:** implementation plan and architecture record for review.
**Branch:** `feat/auth-email-verification-password-upgrade`
**Related:** account security. No offline, device or financial workflow is changed.

## 1. Current authentication architecture (discovered)

- **Session transport:** signed HS256 JWT in `x-bloomcore-tab-session`, injected by the
  tab-session service worker. No auth cookie is trusted in production. `SessionRecord` rows
  provide revocation, a server-enforced tokenVersion check and idle/absolute timeouts
  (`src/lib/auth.ts`).
- **Tenant logins:** `/admin/login` (`adminLogin`), shared `/login` (`unifiedLogin`) for
  MoMo/Susu/customer, `/customer/login` (`customerLogin`), plus MFA challenge and workspace
  selection. Google-style OIDC exists only for the platform boundary.
- **Platform login:** `/platform/login` (`platformLogin`) uses a platform cookie/session and a
  separate `PlatformSuperAdmin` table. SSO returns a platform session directly.
- **Password hashing:** bcrypt cost 12 in `hashPassword`. Login has per-IP/per-identifier
  throttling, progressive cooldown, Turnstile support and constant-time unknown-account checks.
- **Password recovery:** `PasswordResetToken` model and `password-recovery.actions.ts` already
  generate SHA-256 token hashes, enforce 15-minute expiry, consume atomically and revoke
  sessions. **No tokens are emailed today**; `/forgot-password` is administrator-assisted and
  `/reset-password` asks the user to paste a token.
- **Mandatory change:** `User.forcePasswordReset`, `Customer.forcePortalPasswordReset` and
  `PlatformSuperAdmin.forcePasswordReset`. Current login paths issue a full session first and
  redirect to a first-login page. That violates the new requirement that no unrestricted
  session may be issued before the change.
- **Account creation:** no public self-registration. Accounts are created by tenant staff
  (`staff.actions.ts`, `worker.actions.ts`, `susu-collector.actions.ts`), by platform tenant
  enrollment (`platform.actions.ts`) or seeded. All set `forcePasswordReset: true`.
- **Email:** there is no email code in the repository. Render already provides
  `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_SECURITY`, `EMAIL_FROM_NOREPLY`,
  `EMAIL_FROM_NOTIFICATIONS`, `SITE_URL`, `NEXTAUTH_URL`. No duplicate provider is needed.
- **Migrations:** PostgreSQL uses `prisma/schema-pg.prisma` + `prisma/migrations`; SQLite uses
  `prisma/schema.prisma` and CI `prisma db push`. PostgreSQL integration tests run in a
  disposable database.

## 2. Design decisions

1. **Verification applies to email-based staff/business accounts** created by administration or
   tenant enrollment. There is no public self-registration to attach a sign-up screen to.
   Customer portal accounts authenticate by phone/Account Number and keep their existing
   business-issued provisioning; their changed passwords use the same policy.
2. **Existing accounts are not locked out of their data permanently, but existing sessions
   stop working.** The migration marks every existing `User` verified and requires a password
   upgrade. Because the upgrade is mandatory, a session that predates the flag is refused by
   `isSessionCurrent`, `getTenantContext` and the platform guards: the account must complete the
   challenge flow, which issues a fresh session only afterwards. No password hash, role, tenant
   or financial record is changed by this.
3. **`forcePasswordReset` remains the persisted mandatory flag.** A successful compliant change
   clears it and records `passwordPolicyVersion = 1`.
4. **Password-change challenge:** a dedicated JWT (audience
   `bloomcore-one:password-change`, 10-minute expiry, purpose and subject claims). It is stored
   only in the tab's `sessionStorage`, never in a URL, and authorises only the change action. It
   is not a session and cannot read protected endpoints.
5. **Login order:** credentials → account active → email verified → required MFA (verify or
   enrol) → mandatory-change challenge → session. An unverified or change-required account
   never receives a session. If MFA is required, the challenge is issued only from the MFA
   completion action after the factor is proven.
6. **Platform SSO:** an operator with `forcePasswordReset` is not given a platform session; the
   callback directs them to the local login so the challenge path can be used.
7. **Email safety:** all sends go through one Resend client. Tests and an explicit disabled mode
   use an in-memory outbox; no test can deliver to a real address. Missing configuration is
   logged without secrets, and the account remains pending with a resend option.
8. **No enumeration:** verification and reset requests return the same generic response for
   known, unknown, ineligible and already-verified addresses.

## 3. Schema changes

`User`

- `emailVerified Boolean @default(true)` — existing rows stay usable; every new creation path
  sets `false` explicitly.
- `emailVerifiedAt DateTime?`
- `passwordPolicyVersion Int @default(0)`
- relation `emailVerificationTokens`

`PlatformSuperAdmin`

- `passwordPolicyVersion Int @default(0)`

`Customer`

- `passwordPolicyVersion Int @default(0)`

New `EmailVerificationToken`

- `id`, `tenantId?`, `userId`, `tokenHash @unique`, `expiresAt`, `usedAt?`, `createdAt`
- indexes on user, hash, expiry, tenant; cascade delete with the user.

`PasswordResetToken` is reused unchanged.

PostgreSQL migration `20261115_email_verification_password_policy`:

1. Add the nullable/defaulted columns only.
2. `UPDATE "User" SET "emailVerified" = true` for every existing row.
3. `UPDATE "User" SET "forcePasswordReset" = true` for existing rows (one-time upgrade).
4. No table rewrite, no deletion, no password hash change, no role/tenant change.

SQLite uses `prisma db push` in CI/tests; the schema default keeps fixtures working.

## 4. Files likely to change

- `prisma/schema.prisma`, `prisma/schema-pg.prisma`, new migration folder, seeds.
- New `src/lib/security/password-policy.ts`.
- New `src/lib/email/{resend,templates}.ts`.
- New `src/lib/security/account-tokens.ts` and `password-change-challenge.ts`.
- `src/lib/actions/auth.actions.ts`, `platform.actions.ts`, `password-recovery.actions.ts`,
  `staff.actions.ts`, `worker.actions.ts`, `susu-collector.actions.ts`.
- New `email-verification.actions.ts`.
- Login clients: `UnifiedLoginClient`, `AdminLoginForm`, `PlatformLoginForm`.
- New `/verify-email`, revised `/forgot-password`, `/reset-password`, `/password-upgrade`, `/change-password`,
  platform first-login.
- `src/lib/validations.ts`, `src/lib/platform-auth.ts`, `src/lib/auth.ts`.
- Tests for verification, reset, challenge, policy, tenant isolation and email failure.

## 5. Deployment variables (names only)

Already present on Render: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_SECURITY`,
`SITE_URL`, `NEXTAUTH_URL`. Optional `EMAIL_DELIVERY=disabled` for a controlled environment.
No secret values are recorded here.

## 6. Implementation summary (completed on the feature branch)

### New modules

- `src/lib/security/password-policy.ts` — one authoritative policy (12+, upper, lower,
  number, symbol, 256 max) used by every server action and shared by the form checklist.
- `src/lib/email/resend.ts` — single Resend client using `RESEND_API_KEY` and
  `EMAIL_FROM_SECURITY`/`EMAIL_FROM_NOREPLY`/`EMAIL_FROM`. Test/disabled mode writes an
  in-memory outbox; no test can deliver real mail.
- `src/lib/email/templates.ts` — MaaCash-branded verification and reset emails with escaped
  values, canonical links, expiry and security guidance.
- `src/lib/security/account-tokens.ts` — SHA-256 token hashing, 24-hour verification tokens,
  60-second resend cooldown, single-use consumption, idempotent repeat for the same verified
  account, invalidation of other outstanding links.
- `src/lib/security/password-change-challenge.ts` — HS256 JWT, audience
  `bloomcore-one:password-change`, purpose/subject claims, 10-minute expiry. No session guard
  accepts it.
- `src/lib/security/password-change-client.ts` — tab-scoped sessionStorage transport.

### Login changes

- Staff/admin/customer/platform password logins check, in order: password → active status →
  email verified (User) → required MFA verify/enrolment → mandatory-change challenge → session.
- A mandatory account receives `{ passwordChangeRequired, challengeToken }` and **no**
  `sessionToken`. The client stores the challenge in sessionStorage and opens
  `/password-upgrade?required=1`.
- The MFA success and enrolment-finish actions re-read the persisted account state. If the
  forced-change flag is set they return the password-change challenge instead of a session.
  A password-only login cannot skip MFA to reach the challenge.
- `completeRequiredPasswordChange` verifies the challenge, policy and persisted flag, updates
  the hash, clears the flag, records `passwordPolicyVersion = 1`, increments tokenVersion,
  revokes older sessions and asks the user to sign in again.
- Platform SSO refuses to mint a session for an operator with `forcePasswordReset`; the
  callback returns an error that directs them to the local login challenge.
- `isSessionCurrent` rejects a User session whose email is not verified, and rejects any session
  whose account still carries a mandatory password-upgrade flag. `getTenantContext` applies the
  same rule, and `requirePlatformAdmin` redirects a forced-upgrade operator to the standalone
  first-login screen. A session created before the flag therefore cannot be used to skip the
  challenge.

### Email verification

- New User accounts from staff, worker, collector and platform tenant enrollment set
  `emailVerified = false` and receive a verification email.
- `/verify-email` confirms the token or offers a generic resend form. Verified, expired,
  invalid and already-consumed cases are handled without account enumeration.
- Login shows a “Verify your email” message and a resend link only after correct credentials.
- Delivery failure is logged without recipient or token data and leaves the account pending.

### Password reset

- `/forgot-password` posts to the existing rate-limited/Turnstile-protected action, which now
  sends only to active, verified accounts.
- `/reset-password?token=…` validates the link, shows the live policy checklist, consumes the
  token atomically, updates the hash/policy version, clears the forced flag and revokes
  sessions.
- Unknown, unverified and inactive addresses receive the same generic response.
- Delivery failure removes the just-created token so a retry starts clean.

### Account creation and existing accounts

- All four User creation paths set `emailVerified: false` and trigger a verification email.
- Migration backfills every existing User as verified and sets the one-time
  `forcePasswordReset` flag. No existing active session is revoked by the migration.
- Existing users continue to use their current password; on their next password login they
  receive the change challenge instead of a session.

### Frontend

- New/updated: login challenge handling, `/verify-email`, `/forgot-password`, `/reset-password`,
  `/change-password`, customer/platform password forms, live policy checklist, show/hide
  password controls, loading/disabled states, mobile layout.
- `/verify-email` and `/password-upgrade` are public routes; both actions remain server-guarded
  by token or session and cannot open protected data.

## 7. Schema and migration impact (exact)

Additive PostgreSQL migration
`prisma/migrations/20261115_email_verification_password_policy/migration.sql`:

- `User.emailVerified BOOLEAN NOT NULL DEFAULT true`
- `User.emailVerifiedAt TIMESTAMP(3) NULL`
- `User.passwordPolicyVersion INTEGER NOT NULL DEFAULT 0`
- `PlatformSuperAdmin.passwordPolicyVersion INTEGER NOT NULL DEFAULT 0`
- `Customer.passwordPolicyVersion INTEGER NOT NULL DEFAULT 0`
- New `EmailVerificationToken` table + indexes + cascade foreign key to `User`
- Backfill: all existing User rows verified; all existing User rows `forcePasswordReset = true`
- Backfill: every PlatformSuperAdmin with a password hash `forcePasswordReset = true`
- Backfill: portal-enabled Customers with a non-empty `portalPasswordHash`
  `forcePortalPasswordReset = true`; customers without portal credentials untouched

No table is dropped, recreated or truncated. No password hash, role, tenant, financial,
customer, device or offline row is changed by the migration. SQLite uses the matching
`prisma/schema.prisma` with `prisma db push` in CI/tests.

## 8. Tests executed

- `npm test`: **847 passed / 81 files** (includes 24 new authentication/MFA tests and the collector policy test).
- `npm run typecheck`: clean.
- `npm run lint`: 0 errors (71 warnings; no new errors).
- `npm run build`: compiled successfully.
- New Playwright spec `e2e/maacash-auth-security.spec.ts`: 5/5 passed locally.
- Full mobile Playwright project (offline + auth): **15/15 passed locally**.
- PostgreSQL migration rehearsal locally on a disposable PostgreSQL 16 container:
  - all 30 migrations applied;
  - `migrate status`: up to date;
  - `migrate diff --exit-code`: no difference;
  - upgrade rehearsal: a user inserted at the previous schema revision became
    `emailVerified=true`, `passwordPolicyVersion=0`, `forcePasswordReset=true`;
  - PostgreSQL integration tests: **36 passed / 8 files**.

Coverage includes MFA-before-challenge for verified and enrolment paths, challenge type separation, expiry/replay, registration verification, token reuse/expiry, resend cooldown, delivery
failure, unverified login block, mandatory challenge for staff/admin/customer/platform, no
session before change, weak password rejection, challenge replay, old password invalidation,
generic reset responses, token consumption, tenant isolation and existing-session behaviour.

## 9. Accepted limitations and operational notes

- There is no public self-registration in MaaCash. Verification applies to administrator- and
  platform-provisioned User accounts; no new tenant self-signup flow was added.
- Customer portal accounts authenticate by phone/Account Number, not email. They receive the
  new password policy on every password write but not email verification/reset. Their legacy
  forced-change flow is unchanged.
- Platform operators use the platform recovery process; they are not sent tenant reset emails.
- The reset link token is in the URL query, as is conventional for email links. The page does
  not load third-party resources; the token is single-use, 30 minutes, hashed at rest.
- Pre-upgrade sessions are refused, not silently kept. A signed-in user whose account carries the
  mandatory-upgrade flag is treated as having no session: the next request lands on the challenge
  or sign-in screen, and a fresh session is issued only after the compliant change. This is the
  deliberate outcome of the security assessment finding SEC-02, and it is documented in the PR.
- `issueModuleSession` lives in `src/lib/session-issuance.ts`, deliberately outside every
  `"use server"` module, so it cannot be invoked as a server action (assessment finding SEC-01).
- Offline Susu contribution sync takes the same per-account advisory lock as the online path, so
  concurrent syncs cannot allocate the same cycle day twice (assessment finding SEC-03).
- Email delivery depends on Resend and the configured sender domain. A missing key or sender
  fails safely; the account remains pending and a resend is possible.
- `EMAIL_TEST_FORCE_PROVIDER` exists only so tests can exercise provider failure with a stubbed
  fetch. It must never be set in production.

## 10. Deployment variables (names only)

`RESEND_API_KEY`, `EMAIL_FROM_SECURITY` (or `EMAIL_FROM_NOREPLY`/`EMAIL_FROM`), `SITE_URL`,
`JWT_SECRET` (already required). Optional `EMAIL_DELIVERY=disabled`. No secret is written here.

## 11. Rollback

- Application: deploy the previous Render release. The schema change is additive; the previous
  application ignores the new columns/table.
- Database: no destructive rollback is needed or permitted. Do not drop the new columns or
  token table while the new application may still write them.
- Existing passwords, sessions, roles, tenants, financial records, device enrollments and
  offline queues are untouched by both the migration and rollback.

