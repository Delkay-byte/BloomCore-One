# MFA for Administrators

## 1. What is implemented

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
| `optional` (default) | Anyone who has enrolled must verify. Privileged users are not blocked if they have not enrolled. |
| `enforce` | Platform operators and tenant administrators must enrol before a session is issued. |

The default is deliberately `optional` so a deploy cannot lock every
administrator out. Enforcement is a deliberate owner action after enrolment.

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

### Login with MFA

Password → `/mfa/verify` → 6-digit code (or one recovery code) → dashboard.
A recovery code is consumed on use and cannot be reused.

## 4. Enabling enforcement

Only after both privileged accounts (platform and each tenant administrator)
have enrolled:

1. Confirm the current time on the enrolment device is accurate.
2. Set `MFA_ENFORCEMENT=enforce` in Render.
3. Redeploy.
4. Test: a privileged account without MFA is redirected to `/mfa/enroll` and
   cannot reach the dashboard; an enrolled account reaches `/mfa/verify`.
5. Keep at least one platform recovery code offline.

Rollback: set `MFA_ENFORCEMENT=optional` and redeploy. Existing enrolled users
still verify; unenrolled privileged users can sign in again.

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
