# Administrator-Assisted Account Recovery

MaaCash does not yet have a transactional email provider. Public
"email me a link" recovery was removed because the previous implementation
returned the reset token to the browser. Recovery is now administrator-assisted.

## 1. Who can recover whom

| Actor | Can issue a code for | Cannot recover |
|---|---|---|
| Tenant administrator (`role = admin`, own tenant) | Workers, agents, collectors, customer portal accounts in the same tenant | Other tenant administrators, the business owner, platform operators, other tenants |
| Platform operator (`PlatformSuperAdmin`) | Business owners / tenant administrators in any tenant; ordinary users and customers as an escalation path | Other platform operators (use the break-glass procedure) |

Enforced in `src/lib/actions/account-recovery.actions.ts` on the server. The UI
only hides options; it is not the control.

## 2. Procedure

1. The administrator signs in (with MFA when enrolled) and opens
   **Settings → Recovery** (`/admin/recovery`) or, for platform operators,
   **Account Recovery** (`/platform/recovery`).
2. They enter the account email/ID, a mandatory reason (10–500 characters) and,
   when enrolled, their own current authenticator code (step-up).
3. The server generates a **16-character base32 code** (~80 bits) with
   `crypto.randomBytes`, stores only `SHA-256("admin-recovery:" + normalized)`,
   sets a **30-minute expiry**, cancels any previous outstanding code for that
   account, and returns the plaintext code **once**.
4. The administrator verifies the person's identity out of band (established
   phone number or in person) and gives them the code. The code must not be sent
   through the same channel used to sign in.
5. The user opens `/recover-account`, enters the code and chooses a new password
   (minimum 8 characters, one uppercase letter, one digit).
6. The server consumes the code atomically (`UPDATE ... WHERE usedAt IS NULL
   AND expiresAt > now`), replaces the password, clears the force-reset flag,
   increments `tokenVersion`, revokes every `SessionRecord` for the account, and
   writes `auth.admin_recovery_redeemed`.
7. The user signs in. If MFA is enrolled, a TOTP/recovery code is required. If
   enforcement is on and the account is not enrolled, enrolment is required
   before access.

## 3. Security properties

- Codes are never logged, never returned by read APIs, and never stored in
  plaintext.
- Single use, 30-minute expiry, invalidated when replaced.
- Issuing is rate limited per administrator and per target.
- Redemption is rate limited per IP.
- Every issue, redemption and MFA reset writes a tenant audit row; platform
  issues also write a `PlatformAuditLog` row.
- A password reset does **not** silently disable MFA. A separate, audited MFA
  reset is required when the authenticator is lost.
- No permanent lockout: an expired code can be replaced by the same authority.

## 4. Lost authenticator and recovery codes

A tenant administrator can reset MFA for ordinary users; a platform operator can
reset it for owners/tenant administrators. The action requires the same reason
and step-up code, clears the MFA secret and recovery-code hashes, revokes all
sessions, and records `auth.mfa_reset_by_admin`. The user then enrols again at
next sign-in.

## 5. Public recovery experience

`/forgot-password` never claims an email was sent. It directs:

- workers, agents, collectors and customers to their business administrator;
- business owners and tenant administrators to the BloomCore platform
  administrator.

`/recover-account` is the only public redemption screen. It always returns the
same error for unknown, used or expired codes.

## 6. Future email integration

`AccountRecoveryRequest` is provider-independent. An email integration can later
add a delivery step (`issueAccountRecoveryCode` already returns the plaintext
code once) without changing authorization, hashing, expiry or audit behaviour.
Until then, administrator-assisted recovery is the supported method.

## 7. Tests

`tests/admin-recovery.test.ts` covers same-tenant issue, cross-tenant denial,
protected-administrator denial, platform escalation, successful redemption,
password replacement, session revocation, replay rejection, expiry, customer
portal recovery and MFA reset.
