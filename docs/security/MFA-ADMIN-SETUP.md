# MFA for Administrators

## 1. Policy: MFA is mandatory for every authenticated account

Every account type must enrol: platform operators, business owners, tenant
administrators, workers, agents, collectors and customer portal accounts.
`MFA_ENFORCEMENT=enforce` makes enrolment a precondition for a normal session.

- Login performs the password check, then creates a 5-minute challenge cookie.
  No application session is issued until a TOTP or recovery code succeeds (or,
  for an unenrolled account, enrolment is completed).
- Sessions carry `amr = "pwd+mfa"`. While enforcement is on, middleware, all
  server guards and `isSessionCurrent()` reject password-only sessions.
- Existing accounts are redirected to `/mfa/enroll` at next sign-in.
- Newly created accounts are forced through the same challenge before their
  first password change and before any dashboard, customer or financial route.
- Customer portal accounts use the same challenge flow against the `Customer`
  table.
- There is no alternative login, legacy session, offline route or
  administrator action that bypasses the challenge. An administrator password
  reset leaves MFA enabled (or requires separate MFA reset + re-enrolment).

`MFA_ENFORCEMENT=optional` was the controlled rollout state. Production is now
set to `enforce`; existing accounts will be sent to `/mfa/enroll` at their next
successful password check. `optional` never bypasses verification for an account
that has already enrolled.

## 2. What is implemented

TOTP (RFC 6238, SHA-1, 6 digits, 30-second step) with:

- Authenticator enrolment with QR code and manual key.
- Encrypted server-side storage of the TOTP secret
  (AES-256-GCM, key from `MFA_ENCRYPTION_KEY`).
- Ten single-use recovery codes, stored only as SHA-256 hashes; a code is
  removed from the list when used.
- Verification rate limits per IP and per subject.
- Disablement requires the current password **and** a valid TOTP or recovery
  code.
- Audit events: `mfa.enrolled`, `mfa.verify_failed`,
  `mfa.recovery_code_used`, `mfa.disabled`, plus login audit rows.
- Login challenge cookie (`bik-mfa-challenge`) valid for 5 minutes; it is not a
  session and grants no access by itself.

Entry points that apply the policy: `unifiedLogin`, `login`, `adminLogin`,
`platformLogin`, and `resolveStaffAuth` (used by the shared portal). The policy
helper is `beginMfaStepIfRequired` in `src/lib/security/mfa-login.ts`.

## 2. Enforcement policy

`MFA_ENFORCEMENT` controls rollout:

| Value | Behaviour |
|---|---|
| `optional` | Anyone who has enrolled must verify. Unenrolled users are not blocked. Used only during the controlled rollout. |
| `enforce` | Every account type must enrol before a session is issued. This is the required production end state. |

The code default remains deliberately `optional` so a fresh deploy cannot lock
every administrator out. Production is a deliberate owner decision: the live
`bloomcore-one` service reports `MFA_ENFORCEMENT=enforce` through the Render API,
and the checked-in `render.yaml` now also sets `enforce` so the blueprint and the
runbook agree. Staging uses `enforce` as well.

Verification (4 November 2026):

- Render API, production service `bloomcore-one`: `MFA_ENFORCEMENT=enforce`.
- `render.yaml`: `MFA_ENFORCEMENT` value `"enforce"`.
- `tests/release-config.test.ts`: asserts both blueprint and staging enforce and
  that no payment secret or approved-provider constant is hardcoded.

Do not weaken enforcement to make a login easier. Use the recovery procedure in
section 5 instead.

## 3. Enrolment (owner / administrator)

### Tenant administrator

1. Sign in at `/admin/login`.
2. Open **Settings → Two-factor** (or `/admin/security/mfa`).
3. Click **Set up MFA**.
4. Scan the QR code with an authenticator app (Google Authenticator, Microsoft
   Authenticator, 1Password, Aegis, etc.).
5. Enter the 6-digit code and click **Verify**.
6. Save the ten recovery codes offline. They are shown once.

### Platform operator

1. Sign in at `/platform/login`.
2. Open `/platform/security/mfa`.
3. Follow the same steps.

### Existing BIK Prestige accounts

Production currently contains one tenant, one tenant administrator and one
platform operator; no workers, agents, collectors or customers exist yet. On the
first sign-in after enforcement, each existing account is sent to
`/mfa/enroll`, must scan the QR/code, confirm a 6-digit code, and save recovery
codes before a session is issued.

### New accounts and onboarding

Worker, agent, collector and customer creation flows already set a temporary
password and force a password change at first login. With enforcement on, the
MFA challenge runs before that session is issued, so onboarding cannot complete
without enrolment. No billing, subscription or role exception exists.

### Login with MFA

Password → `/mfa/verify` → 6-digit code (or one recovery code) → dashboard.
A recovery code is consumed on use and cannot be reused.

## 4. Enabling enforcement

Only after both privileged accounts (platform and each tenant administrator)
have enrolled:

1. Confirm the current time on the enrolment device is accurate.
2. Set `MFA_ENFORCEMENT=enforce` in Render (production already reports this).
3. Redeploy.
4. Test: a privileged account without MFA is redirected to `/mfa/enroll` and
   cannot reach the dashboard; an enrolled account reaches `/mfa/verify`.
5. Keep at least one platform recovery code offline.

Rollback: set `MFA_ENFORCEMENT=optional` and redeploy. Existing enrolled users
still verify; unenrolled privileged users can sign in again. This is a
break-glass action: record who changed it, when and why. Do not leave production
on `optional` after the incident.

## 5. Recovery and loss of authenticator

- Use a saved recovery code at `/mfa/verify`.
- If no recovery code remains, a platform operator can disable MFA directly in
  the database only as a break-glass action, then force a password reset. This
  is recorded in the incident runbook. It is not exposed as an application
  feature.

## 6. Database changes

`User` and `PlatformSuperAdmin` gained:

- `mfaEnabled BOOLEAN NOT NULL DEFAULT false`
- `mfaSecret TEXT` (encrypted)
- `mfaRecoveryCodes TEXT` (JSON array of hashes)
- `mfaEnrolledAt TIMESTAMP`
- `mfaLastUsedAt TIMESTAMP`

Migration: `prisma/migrations/20261101_security_hardening/migration.sql`.
Additive only; existing accounts stay at `mfaEnabled = false`.

## 7. Security notes

- The TOTP secret is never returned after enrolment. The QR/manual key is shown
  only once during setup.
- Recovery codes are never logged and never stored in plaintext.
- Changing a password revokes sessions but does not disable MFA.
- MFA is not available to customers or non-administrator staff in this rollout.
