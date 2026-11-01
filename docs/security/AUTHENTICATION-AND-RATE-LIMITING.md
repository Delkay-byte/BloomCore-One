# Authentication and Rate Limiting

## 1. Login pipeline

Every credential submission runs the same sequence
(`src/lib/security/auth-guard.ts`):

1. Normalise the identifier (`trim().toLowerCase()`).
2. Resolve the client IP safely (`src/lib/security/client-ip.ts`).
3. Consume the per-IP fixed-window limit for that endpoint category.
4. Read the progressive pair and account cooldowns; refuse if either is active.
5. Verify the Turnstile token server-side (when `TURNSTILE_ENABLED=true`).
6. Look the account up and verify the password (dummy bcrypt when absent).
7. On failure: advance the cooldown and return a generic error.
8. On success: clear the cooldown, then apply the MFA policy.
9. Issue the module session and write an audit row.

Account state checks (inactive, wrong module, admin using the shared portal) run
only after a correct password, so they cannot be used for enumeration.

## 2. Client IP on Render

Render's edge sits behind Cloudflare. `X-Forwarded-For` is **not** safe for
security decisions because the platform appends to a client-supplied value.

`getClientIp()` therefore:

- Trusts `True-Client-IP`, then `CF-Connecting-IP`, only when
  `TRUSTED_PROXY_HEADERS=true` or `RENDER=true`.
- Never reads `X-Forwarded-For` or `X-Real-IP` for security decisions.
- Returns `{ ip: null }` when no trusted header is present or the value is not a
  valid IP.

When the IP is unknown, per-IP limiting is skipped (an unknown IP cannot be
bucketed safely) while account and pair throttles continue with the literal
`unknown` component. This is documented in the audit report; it is not silent
trust of a spoofed header.

## 3. Persistent counters

`RateLimitCounter` stores `<scope>:<HMAC-SHA256(secret, identifier)>` with a
count, window start and expiry. `AuthThrottle` stores the failure progression.
Both are ordinary database rows, shared by all Render instances and preserved
across restarts. HMAC identifiers prevent raw emails/IPs being stored.

Concurrency: an expired window is reset with a conditional `updateMany`; a live
window is incremented atomically; creation races are resolved by the unique key
and a retry increment.

## 4. Policies

| Scope | Limit | Window |
|---|---|---|
| Any login endpoint, per IP | 20 | 15 min |
| Password reset request, per IP | 5 | 15 min |
| Password reset request, per identifier | 3 | 15 min |
| Password reset submit, per IP | 10 | 15 min |
| MFA verify, per IP | 10 | 10 min |
| MFA verify, per subject | 5 | 10 min |
| Platform sensitive mutation, per operator | 30 | 10 min |
| Financial mutation, per user | 60 | 10 min |

## 5. Progressive failed-login cooldown

Configuration (`LOGIN_THROTTLE` in `src/lib/security/config.ts`):

- Observation window: 15 minutes.
- Failures needed: **5 → 8 → 11**.
- Cooldowns: **1 minute → 5 minutes → 15 minutes**.
- Quiet period that erases the state: 24 hours.
- Maximum automatic refusal: 15 minutes. There is no permanent lockout.

Two dimensions are tracked:

- `pair:<HMAC(identifier|ip)>` — drives the progressive schedule. An attacker on
  one IP cannot lock the legitimate user out from their own IP.
- `acct:<HMAC(identifier)>` — high threshold (30) account-wide ceiling. It is
  capped at 15 minutes, so it cannot be used for a permanent denial of service.

Attempts made while a cooldown is active are refused before any password check
and do **not** mutate `blockedUntil`, so hammering the endpoint cannot extend the
cooldown. A successful login deletes both rows.

Automated coverage: `tests/security-hardening.test.ts` drives a controlled clock
through the full 1 → 5 → 15-minute progression, verifies that attempts during a
cooldown do not extend it, and verifies that success clears it.

## 6. Password storage

- bcrypt cost 12.
- Existing hashes remain verifiable; no Argon2 migration was attempted.
- Password policy: minimum 8 characters, at least one uppercase letter and one
  digit. Long passphrases are accepted; there is no maximum-length trap.
- `verifyPasswordAction` no longer trims passwords, so leading/trailing spaces
  are honoured.
- Reset tokens: 32 random bytes, stored only as SHA-256, 15-minute expiry,
  single-use enforced with a conditional update inside a transaction.
- No reset token is ever returned to the browser. Delivery requires an email
  provider (blocking item).

## 7. Response semantics

Browser forms use Next.js server actions, which return `{ success, error }`
rather than an HTTP status. Refusals include the wait time, for example:

> Too many failed attempts. Please try again in 5 minutes.

API routes use real HTTP status codes (`401`, `403`, `409`, `400`, `500`).
A future migration of the login forms to route handlers is required if literal
`429` responses are mandated. This limitation is recorded rather than hidden.
