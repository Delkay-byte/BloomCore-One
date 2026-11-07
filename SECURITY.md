# MaaCash — Security Policy

> Formerly BloomCore One. Historical security records keep the old product
> name where they describe events at that time.

> **Status:** Security hardening complete — ready for security pilot.
> Security testing is ongoing. No software can guarantee zero vulnerabilities.

## 1. Authentication

### Password Policy
- Minimum 8 characters
- At least one uppercase letter
- At least one number
- Hashed with bcrypt (cost factor 12)

### Account Lockout
- **5 failed login attempts** per 15-minute window per IP address
- Progressive lockout prevents distributed password guessing
- Account status: `active` | `inactive` (admin-controlled)

### First Login
- Workers and collectors receive a temporary password
- Forced password change required on first login
- Old sessions are invalidated when password changes

## 2. Session Management

### Architecture
- **Module-scoped JWT cookies** — separate cookies for admin, MoMo, and Susu
- Each login writes only its own module cookie
- JWT tokens signed with HS256 using a strong server-side secret

### Session Timeouts

| Policy | Value | Enforcement |
|--------|-------|-------------|
| **Inactivity timeout** | 5 minutes | Server-side (JWT `lastActivityAt`) |
| **Background/hidden timeout** | 60 seconds | Client-side grace timer + server |
| **Absolute session lifetime** | 15 minutes | Server-side (JWT `exp`) |

### Server-Side Enforcement
- Session timing is enforced server-side via JWT claims
- The server validates `iat`, `exp`, and `lastActivityAt` on every request
- A malicious client **cannot** extend the session by modifying client-side timers
- `tokenVersion` bumps invalidate all existing sessions

### Client-Side Monitoring
- `SessionMonitor` component tracks user activity
- Polls server every 15 seconds for session status
- Displays warning before inactivity expiry (60 seconds)
- Detects background/hidden page and starts 60-second grace timer
- Logs timeout events for audit trail

### Session Invalidation
- **Password change:** Bumps `tokenVersion`, invalidating all sessions across all modules
- **Admin password reset:** Bumps `tokenVersion`, forces first-login password change
- **Logout:** Clears all module cookies
- **Session expiry:** Server rejects expired tokens

### Refresh Behavior
- Browser refresh: warns user, confirms, reloads, terminates session, redirects to login
- Normal SPA navigation does **not** log the user out

## 3. Sensitive Operation Reauthentication

### Step-Up Authentication
Before high-impact operations, the user must re-enter their password:

| Operation | Reauthentication Required |
|-----------|--------------------------|
| Admin password reset (worker/collector) | ✅ |
| Susu withdrawal processing | ✅ |
| Module capability changes | ✅ |
| Regular page navigation | ❌ |

The server verifies the password and logs the event.

## 4. Authorization

### Role-Based Access Control

| Role | Access |
|------|--------|
| **Admin** | Full administrative access, MoMo + Susu modules |
| **Worker** | MoMo module only (if enabled), own location |
| **Collector** | Susu module only (if enabled), own customers |

### Object-Level Authorization
- Workers can only access their own daily accounts
- Workers can only access their assigned location
- Collectors can only access their assigned customers
- Admin-only operations are protected by `requireAdmin()` guard
- ID manipulation is checked server-side

### Dual-Role Users
- One account, one login, multiple module capabilities
- Workspace selection after login
- `WorkspaceSwitcher` allows switching between MoMo and Susu
- Admin authority is **never** granted through module capabilities

## 5. Security Headers

| Header | Value |
|--------|-------|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-XSS-Protection` | `1; mode=block` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Content-Security-Policy-Report-Only` | See `next.config.ts` |
| `X-Permitted-Cross-Domain-Policies` | `none` |

### Clickjacking Protection
- `X-Frame-Options: DENY`
- `frame-ancestors 'none'` in CSP
- Application cannot be embedded in unauthorized iframes

### Content Security Policy
- Report-only mode initially (validates before enforcement)
- `unsafe-inline` required for Next.js hydration (documentated exception)
- No `unsafe-eval` unless required

### Cache-Control
- Protected pages: `no-store, no-cache, must-revalidate, proxy-revalidate`
- API routes: same headers applied
- Prevents sensitive data from being served from browser cache

## 6. CSRF Protection

- Next.js Server Actions use POST with automatic CSRF tokens
- `SameSite: Lax` cookies provide CSRF protection
- State-changing operations require authenticated sessions
- Origin validation through middleware

## 7. Password Security

### Display
- Every password field has an eye toggle (show/hide)
- Toggle is `type="button"` — cannot submit forms
- Accessible labels: "Show password" / "Hide password"
- Entered values are preserved during toggle

### Fields with Toggle
- Login password
- Change Password: current, new, confirm
- Worker creation: temporary password
- Collector creation: temporary password
- Admin reset: temporary password
- Reauthentication: password

## 8. Audit Logging

### Events Recorded
- Login success / failure
- Logout
- Session timeout (inactivity, background, absolute)
- Password change (own + admin reset)
- First-login forced password change
- Step-up authentication success / failure
- Module capability changes
- Workspace switching
- User creation / update / status changes
- Financial operations (contributions, withdrawals, remittances)

### Events NOT Recorded
- Passwords or password hashes
- JWT tokens or session secrets
- Raw database connection strings

## 9. Data Protection

### Sensitive Data
- Passwords are bcrypt-hashed (never stored in plaintext)
- JWT secrets are environment-only (never committed to git)
- `.env` files are gitignored
- No secrets in frontend bundles, logs, or audit logs

### Browser Cache
- Protected pages have `Cache-Control: no-store` headers
- After logout, sensitive data is not retrievable from cache
- API responses include no-cache headers

## 10. Dependency Security

- Regular `npm audit` checks
- Security-sensitive dependencies are reviewed before upgrade
- Known vulnerabilities are addressed where practical

## 11. Known Limitations

1. **In-memory rate limiter** — Pilot-sufficient; production should use Redis-backed rate limiting
2. **JWT in cookies** — Server-side session store would provide stronger revocation guarantees
3. **CSP `unsafe-inline`** — Required for Next.js hydration; documented exception
4. **Single-tab session sharing** — Same-origin tabs share cookie state (standard browser behavior)
5. **No offline financial operations** — Internet connection required for all financial operations
6. **Client-side session monitor** — Can be bypassed by disabling JavaScript; server-side enforcement is authoritative

## 12. Vulnerability Reporting

If you discover a security vulnerability, please report it to:
- **Email:** [security contact]
- **Do not** open public GitHub issues for security vulnerabilities

## 13. Changes

This document is updated with each security hardening phase.
