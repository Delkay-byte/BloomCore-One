# MaaCash — New Render Service Report

**Date:** 2026-11-07
**New public URL:** https://maacash.onrender.com
**Existing production URL:** https://bloomcore-one.onrender.com (preserved)

---

## A. New service

| Item | Value |
| --- | --- |
| Render service name | `maacash` |
| Render service ID | `srv-dbnaciff3r2c7382tjgg` |
| Public URL | https://maacash.onrender.com |
| Repository | `https://github.com/Delkay-byte/BloomCore-One` |
| Branch | `main` |
| Deployed commit | `d05bf7aa27e82ae7e354cad3a24b4cf50c6d4059` |
| Deployment ID | `dep-dbnacinf3r2c7382tkm0` |
| Deployment status | **live** |
| Runtime | `node` |
| Region | `oregon` |
| Root directory | blank (repository root) |
| Build command | `npm ci --include=dev && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build` |
| Start command | `npm start` |
| Instance plan | `free` |
| Build plan | `starter` |
| Instances | 1 |
| Health check | `/api/health` |
| Environment | `evm-dbihngugekts73fclfng` (same Render environment as the existing service) |
| Auto-Deploy | **OFF** (`off`) during acceptance |
| Persistent disk | None |
| Object storage | None configured on the existing service; no new storage created |

The deployed commit `d05bf7a` differs from the approved release code
`ea869a9a1ba8391ba44ea06f6cdc9eb720d14037` only by
`docs/branding/MAACASH-RELEASE-REPORT.md`. A verified tree comparison showed
**0 lines changed** under `src`, `prisma`, `public`, `package.json` or
`package-lock.json`.

The exact hostname `maacash.onrender.com` was assigned. No generated
alternative was accepted.

---

## B. Health and database

| Check | Result |
| --- | --- |
| `https://maacash.onrender.com/api/health` | **200**, `status=ok`, `env=production`, commit `d05bf7a…` |
| `/api/health/ready` | **200**, `status=ready`, `database=ok`, latency ≈2.1 s |
| TLS | Valid certificate for `onrender.com`; chain trusted |
| Database | Same production Neon database as the existing service |

Database verification was done by comparing the copied connection variables
without exposing them:

- `DATABASE_URL`: byte-identical to the existing production service.
- `DIRECT_URL`: byte-identical to the existing production service.
- Readiness reports `database=ok`.

Record-level browsing through an authenticated dashboard was **not tested**
because no authorised production account is available. The shared database
identity and connectivity are verified.

---

## C. Environment and secrets

No environment groups exist in this workspace. Environment variables were copied
directly from the existing production service.

| Item | Result |
| --- | --- |
| Existing production variables | 29 |
| New service variables | 30 |
| `PORT` copied | **No** — Render-managed |
| `RENDER_EXTERNAL_URL` copied | **No** — Render-managed |
| Database URL | Copied byte-identically |
| JWT secret | Copied byte-identically |
| MFA encryption key | Copied byte-identically |
| Rate-limit HMAC secret | Copied byte-identically |
| Paystack secret and mode | Copied byte-identically (`live`) |
| DeepSeek key/model/base URL | Copied byte-identically |
| Turnstile secret and site keys | Copied byte-identically |
| MFA enforcement | `enforce` |
| Turnstile enabled | `true` |
| New-only `NEXTAUTH_URL` | `https://maacash.onrender.com` |
| New-only `ZELI_EXPIRY_SCHEDULER` | `disabled` |

Host-dependent variables changed **only on the new service**:

- `SITE_URL=https://maacash.onrender.com`
- `NEXT_PUBLIC_SITE_URL=https://maacash.onrender.com`
- `NEXTAUTH_URL=https://maacash.onrender.com`
- `TURNSTILE_ALLOWED_HOSTNAMES=bloomcore-one.onrender.com,maacash.onrender.com`

No secret value is recorded in this report.

---

## D. Authentication, OIDC and Turnstile

| Check | Result |
| --- | --- |
| Customer Turnstile action | `customer_login` — token issued |
| MoMo/Susu Turnstile action | `login` — token issued |
| Administrator Turnstile action | `admin_login` — token issued |
| Platform Turnstile action | `platform_login` — token issued |
| Turnstile server allowlist | Old and new hostnames |
| Cloudflare widget domains | `bloomcore-one.onrender.com`, `maacash.onrender.com` |
| Old hostname Turnstile | Still issues tokens |
| MFA enforcement | `enforce` |
| `/api/auth/me` without session | **401**, `{"error":"Not authenticated"}` |
| Login response legacy cookie | None set |
| OIDC/SSO | Not configured on the existing service; no OIDC variables were added |

The Cloudflare widget initially rejected the new host because the widget domain
list contained only the old hostname. The owner added `maacash.onrender.com`
through the Cloudflare dashboard, preserving
`bloomcore-one.onrender.com`. After propagation, all four login surfaces issued
valid Turnstile tokens under the new hostname. Authentication enforcement was not
weakened.

Authenticated dashboard login and MFA were **not tested** because no authorised
production account is available. No production user or MFA secret was created
to work around this.

---

## E. Public hostname configuration

| Item | Result |
| --- | --- |
| Canonical URL | `https://maacash.onrender.com` |
| Open Graph URL/image | New hostname |
| Twitter image | New hostname |
| Old-host references in metadata | **0** |
| Robots meta | Not `noindex` |
| PWA manifest | MaaCash, `display=standalone`, `start_url=/workspace` |
| 192 / 512 / maskable icons | 200, `image/png` |
| Apple icon / OG image | 200 |
| Service worker | Registered, scope `https://maacash.onrender.com/`, activated |
| Service worker file | `/tab-session-sw.js` 200 |
| `/workspace` unauthenticated | 307 → `/login` |
| `/zeli` unauthenticated | 307 → `/login` |
| `/customer/dashboard` unauthenticated | 307 → `/login?role=customer` |
| `/admin/dashboard` unauthenticated | 307 → `/login` |

The PWA start URL and manifest assets are relative or same-origin, so they work
under the new hostname.

---

## F. Security and browser checks

| Check | Result |
| --- | --- |
| CSP | Present, nonce-based |
| `script-src` `unsafe-inline` | Absent |
| `script-src` `unsafe-eval` | Absent |
| HSTS | `max-age=63072000; includeSubDomains; preload` |
| X-Frame-Options | `DENY` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | Camera, microphone, geolocation, payment, USB disabled |
| Homepage console errors | None |
| Failed critical API requests | None |
| Playwright staging CSP check | 1/1 passed against the new host |

The only console noise was the pre-existing Cloudflare Turnstile `data:,`
CSP message also seen on the existing host. It did not prevent token issuance.

---

## G. Paystack and background processing

| Item | Result |
| --- | --- |
| Paystack mode | `live`, copied unchanged |
| Paystack webhook destination | Existing endpoint on the old service retained |
| Duplicate webhook handler | None created |
| Duplicate payment workflow | None created |
| New-host payment return/callback | `NEXTAUTH_URL` set to the new host so new checkouts return to `maacash.onrender.com` |
| Render cron jobs | None |
| Background workers | None |
| Zeli expiry scheduler on new service | **Disabled** via `ZELI_EXPIRY_SCHEDULER=disabled` |
| Zeli expiry scheduler on old service | Remains active |

The new service is a second web instance sharing the database. The only
in-process scheduled job is the Zeli expiry sweep; conditional updates make it
idempotent, but it is disabled on the new service so only the existing service
executes it during the parallel period.

No real payment, financial transaction, withdrawal, contribution, subscription
or balance change was made.

---

## H. Existing service preservation

| Item | Result |
| --- | --- |
| Service name and ID | `bloomcore-one` / `srv-dbjalrk9v7es739ifkp0` — unchanged |
| Public URL | https://bloomcore-one.onrender.com — live |
| Deployed SHA | `ea869a9a1ba8391ba44ea06f6cdc9eb720d14037` — unchanged |
| Health | **200** |
| Auto-Deploy | ON — After CI Checks Pass |
| Database | Same production database, unchanged |
| Environment variables | Unchanged |
| Turnstile widget hostname | Old hostname retained; new hostname added |
| Suspended/deleted/renamed | No |

The old service was not redirected, repurposed or renamed.

---

## I. Cost and infrastructure

| Item | Value |
| --- | --- |
| New service plan | `free` |
| Additional recurring charge | **$0/month for the free plan itself** |
| New infrastructure resources | One web service only |
| New database/Redis/storage | None |
| Environment groups | None created; variables copied individually |
| Free-tier limitation | Free instance hours are shared across the workspace, and free services spin down when idle. Two free services can exhaust the shared monthly allowance and will cold-start. A paid plan is recommended if both hosts must stay warm continuously. |

No existing service was upgraded and no unrelated infrastructure was created.

---

## J. Blocked and unverified checks

1. **Authenticated production dashboard and MFA on the new host** — BLOCKED
   because no authorised production account exists. Login pages, Turnstile
   issuance, auth redirects, `/api/auth/me` 401, MFA enforcement configuration
   and the tab-session test suite were verified.
2. **Record-level browsing through the new service** — UNVERIFIED for the same
   reason. Database identity and connectivity are verified.
3. **Physical PWA installation under the new hostname** — not repeated; the
   same manifest and service worker were verified, and physical installation was
   already owner-confirmed on staging.

---

## K. Recommended Auto-Deploy configuration

Keep the new service's Auto-Deploy **OFF** until the owner accepts this report.
After acceptance, set the new service to **After CI Checks Pass** so it follows
the same `main` CI gate as the existing production service. Do not change the
existing service's Auto-Deploy setting.

---

## L. Final status

### NEW MAACASH SERVICE LIVE — ACCEPTANCE HAS LIMITATIONS

- **New URL:** https://maacash.onrender.com
- **Service ID:** `srv-dbnaciff3r2c7382tjgg`
- **Deployment ID:** `dep-dbnacinf3r2c7382tkm0`
- **Deployed commit:** `d05bf7aa27e82ae7e354cad3a24b4cf50c6d4059`
- **Existing production URL:** https://bloomcore-one.onrender.com — preserved and live

The new service is live, shares the existing production database, serves the
MaaCash build, issues Turnstile tokens on all four login surfaces, passes health,
readiness, TLS, metadata, PWA and security-header checks, and keeps the existing
service untouched. Acceptance is limited only by the absence of an authorised
production account for a live dashboard/MFA login and by the shared free-tier
instance-hour allowance.
