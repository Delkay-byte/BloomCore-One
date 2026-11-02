# Incident Response Runbook

## 1. Severity

| Severity | Examples | First action |
|---|---|---|
| Critical | Confirmed account takeover, cross-tenant data exposure, financial manipulation | Contain immediately, preserve evidence, notify owner |
| High | Sustained brute force, stolen session, MFA bypass | Contain within the hour |
| Medium | Repeated throttling of a legitimate user, misconfigured Turnstile | Fix same day |
| Low | Suspicious audit entries without impact | Review next business day |

## 2. Signals

Security events are JSON lines on Render logs with `kind: "security_event"`:

- `auth.login_success`, `auth.login_failed`, `auth.cooldown`,
  `auth.rate_limited`
- `turnstile.verification_failed`, `turnstile.configuration_error`
- `mfa.enrolled`, `mfa.verify_failed`, `mfa.recovery_code_used`,
  `mfa.disabled`, `mfa.login_verify_failed`
- `password_reset.turnstile_failed`, `auth.password_reset_completed`
- `ratelimit.blocked`, `ratelimit.error`
- `platform.sensitive_rate_limited`

Application audit rows are in `AuditLog` (tenant) and `PlatformAuditLog`
(platform). Query by `action`, `entityId`, `tenantId` and `createdAt`.

## 3. Containment playbooks

### Suspected account compromise

1. Deactivate the account (`User.status = "inactive"` or
   `PlatformSuperAdmin.status = "inactive"`).
2. Increment `tokenVersion` and revoke sessions:
   `UPDATE "SessionRecord" SET "revokedAt" = now(), "revokedReason" = 'incident'
    WHERE "subjectType" = 'user' AND "subjectId" = '<id>';`
3. Force a password change (`forcePasswordReset = true` or reset flow).
4. Review `AuditLog` for the account over the incident window.
5. If MFA was disabled or re-enrolled unexpectedly, treat as full compromise.

### Stolen session cookie

1. Revoke that `jti` in `SessionRecord` (`revokedAt`), or revoke all subject
   sessions as above.
2. Confirm the account's `tokenVersion` matches the active session.
3. Review requests from the associated IP fingerprint in security logs.

### Sustained brute force / credential stuffing

1. Confirm `auth.rate_limited` and `auth.cooldown` events are firing.
2. Enable Turnstile if it is disabled.
3. Temporarily lower `RATE_LIMITS.loginIp` only if business login remains
   usable; do not lock accounts permanently.
4. Notify affected users through an out-of-band channel; do not reveal whether
   an email exists.

### Cross-tenant access attempt

1. Search audit logs for the actor and the referenced entity IDs.
2. Verify whether any mutation succeeded; the guards should return null/deny.
3. If data was returned, treat as Critical and preserve logs before any cleanup.
4. Deactivate the actor and review all tenant boundaries touched.

### Turnstile outage / misconfiguration

1. If Cloudflare is unreachable, logins fail closed. Set
   `TURNSTILE_ENABLED=false` only with owner approval, and record the decision.
2. Restore keys/hostname configuration and re-enable.

### Financial discrepancy

1. Do not edit financial rows directly.
2. Export the affected account's contributions, withdrawals, commissions and
   audit rows.
3. Identify the actor from `AuditLog` (`susu.withdrawal_processed`,
   `susu.contribution_recorded`).
4. Suspend the actor and preserve the database state; owner decides on
   compensating entries.

## 4. Evidence handling

- Export Render logs for the incident window before rotating anything.
- Export relevant `AuditLog`, `PlatformAuditLog`, `SessionRecord` and
  `AuthThrottle` rows.
- Do not store passwords, reset tokens, MFA secrets or full cookies in the
  incident ticket.
- Record timestamps in UTC and the deployed commit SHA from `/api/health`.

## 5. Recovery

1. Rotate any exposed secret: `RATE_LIMIT_HMAC_SECRET`,
   `MFA_ENCRYPTION_KEY`, `TURNSTILE_SECRET_KEY`, database password, or
   `JWT_SECRET` (last resort; signs out everyone).
2. If `MFA_ENCRYPTION_KEY` is rotated, existing TOTP secrets cannot be
   decrypted. Every privileged user must re-enrol; plan this as a controlled
   operation.
3. Re-run `npm test` and the post-deploy checks in
   `PRODUCTION-SECURITY-ROLLOUT.md`.
4. Document the root cause and the control that failed.

## 6. Log retention

Recommended: retain security logs for at least 90 days (12 months for financial
events) in a store the application cannot modify. Render log retention depends
on the plan; export to object storage or a SIEM if longer retention is required.

## 7. Break-glass MFA reset

There is no self-service bypass. If a privileged user loses both the
authenticator and all recovery codes:

1. Verify the requester's identity out of band.
2. A platform operator (or database operator) sets
   `"mfaEnabled" = false, "mfaSecret" = NULL, "mfaRecoveryCodes" = NULL`.
3. Set `forcePasswordReset = true`.
4. Record the action, actor, reason and time in the incident ticket.
5. The user signs in, changes the password and re-enrols MFA.
