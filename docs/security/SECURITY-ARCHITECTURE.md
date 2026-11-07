# MaaCash — Security Architecture

## 1. Trust boundaries

```
Browser
  │  HTTPS (Render edge → True-Client-IP / CF-Connecting-IP)
  ▼
Next.js middleware ── JWT signature + cookie/module boundary only (edge)
  │
  ├── /platform/*        bik-platform-session   → PlatformSuperAdmin
  ├── /admin/* /susu/*   bik-admin-session      → tenant administrator
  ├── /worker/*          bik-worker-session     → MoMo worker
  ├── /collector/*       bik-collector-session  → Susu collector
  ├── /customer/*        bik-customer-session   → Customer portal
  └── /mfa/*             bik-mfa-challenge      → pending second factor
        │
        ▼
Server guards (Node runtime)
  getTenantContext() → User/Customer row → BusinessTenant (ACTIVE)
        │
        ▼
Prisma → Neon PostgreSQL (pooled) / SQLite (dev, tests)
```

Every page and server action re-validates the session against the database.
Middleware alone is never the authorization control.

## 2. Authentication

- Passwords: bcrypt cost 12 (`src/lib/auth.ts`). Existing hashes remain valid.
- Unknown accounts perform a dummy bcrypt comparison so timing does not reveal
  existence (`verifyPasswordConstantTime`).
- Sessions: HS256 JWT signed with `JWT_SECRET`, `iss=bloomcore-one`,
  audience per token type (`session`, `workspace-selection`, `platform`), and
  `amr` recording password-only vs password+MFA authentication.
- MFA is mandatory for every account type once `MFA_ENFORCEMENT=enforce`.
  Password-only sessions are rejected by middleware, every server guard and
  `isSessionCurrent()`.
- Every new JWT carries `jti`; `SessionRecord` is the server-side registry.
  A token whose record is missing, expired or revoked is rejected.
- Cookies: `HttpOnly`, `Secure` in production, `SameSite=Lax` (tenant) or
  `Strict` (platform), `Path=/`, absolute `Max-Age`, `Priority=High`.
- No authentication token is stored in `localStorage` or `sessionStorage`.
- Logout, password change, password reset and platform logout revoke the
  registry rows server-side.

## 3. Authorization

- Tenant identity comes only from the verified session (`src/lib/tenant.ts`).
  No client-supplied `tenantId` is accepted anywhere.
- `assertTenantEntity` / `assertAllTenantEntities` verify referenced IDs belong
  to the authorized tenant before mutation.
- Platform boundary is one-way: platform cookie cannot open tenant routes and
  tenant cookies cannot open `/platform/*`.
- Platform read actions now require a live platform session
  (`requirePlatformRead`), not just a layout redirect.
- API routes use `getApiTenantContext` and role checks
  (`/api/audit`, `/api/user/[id]`, `/api/admin/devices`).

## 4. Abuse prevention

| Control | Store | Key material |
|---|---|---|
| Per-IP request limits | `RateLimitCounter` | `HMAC-SHA256(RATE_LIMIT_HMAC_SECRET, ip)` |
| Progressive login cooldown | `AuthThrottle` | HMAC of identifier and identifier+IP |
| Turnstile single-use ledger | `TurnstileTokenUse` | SHA-256 of the token |
| Session revocation | `SessionRecord` | JWT `jti` |
| Administrator recovery | `AccountRecoveryRequest` | SHA-256 of a 16-character code |

All tables are shared by every application instance and survive restarts.
Expired rows are cleaned opportunistically and by the deployment operator
(`docs/security/INCIDENT-RESPONSE-RUNBOOK.md`).

## 5. Transport and headers

`next.config.ts` sets:

- `Content-Security-Policy` (enforced) — `default-src 'self'`, Turnstile
  script/frame/connect origins, `frame-ancestors 'none'`, `object-src 'none'`.
- `Strict-Transport-Security` (2 years, includeSubDomains, preload).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Frame-Options: DENY`.
- `Permissions-Policy` denies camera, microphone, geolocation, payment, USB.
- `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`.
- Protected pages and authenticated APIs: `Cache-Control: no-store`.

CSP still allows `'unsafe-inline'` for Next.js hydration and Tailwind. A nonce
based CSP is a future improvement; see the audit report.

## 6. Secrets

| Secret | Purpose | Storage |
|---|---|---|
| `JWT_SECRET` | JWT signing | Render env; unchanged by this work |
| `RATE_LIMIT_HMAC_SECRET` | rate-limit/throttle keys | Render env (new) |
| `MFA_ENCRYPTION_KEY` | AES-256-GCM for TOTP secrets | Render env (new) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Siteverify | Render env (new) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | widget site key | Build env (public) |

Secrets are never logged. Security log lines store only keyed IP fingerprints.
MFA secrets are encrypted with AES-256-GCM (`v1:<iv>:<tag>:<ciphertext>`);
recovery codes are stored as SHA-256 hashes and removed on use.

## 7. Data and migrations

Two schemas must stay in sync:

- `prisma/schema.prisma` (SQLite — local development and tests)
- `prisma/schema-pg.prisma` (PostgreSQL — Neon production)

The security migration is additive:
`prisma/migrations/20261101_security_hardening/migration.sql`.

## 8. Offline storage

IndexedDB is partitioned as
`bik-prestige-offline:v2:<tenantId>:<userId>`. The scope is resolved from
`/api/auth/me`, never from browser input. Device identifiers live inside the
scoped database. Sign-out closes every connection and deletes all
`bik-prestige-offline*` databases; the pre-hardening global database is purged
on first use. Server-side tenant/user/device checks remain authoritative during
sync.

## 9. What the architecture does not provide

- Application-level audit logs are append-only by convention, not by
  cryptographic proof or database permissions.
- No WAF or bot-management layer is configured beyond Turnstile when enabled.
- No centralized SIEM; security events are JSON lines in Render logs.
- No per-request data-loss prevention; logs deliberately omit request bodies.
