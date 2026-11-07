# MaaCash — Staging Acceptance Report

**Date:** 2026-11-07
**PR:** https://github.com/Delkay-byte/BloomCore-One/pull/16
**Branch:** `feat/maacash-rebrand`
**Deployed staging SHA:** `0e0c7dbbe3733ba8ea66ddff102cfe5a662bcdc1`
**Production SHA (untouched):** `e890cf92965364bd7278b4649236e3812bc8cc4e`

> Final status: **STAGING ACCEPTANCE PARTIALLY PASSED — ISSUES TO RESOLVE**
>
> The exact PR head is live on the existing staging service. Public branding,
> PWA metadata, PostgreSQL 16/18, security headers and Paystack TEST hardening
> passed. Full authenticated role and tab-session acceptance was blocked by
> Cloudflare Turnstile throttling under automation, and a customer-login
> Turnstile action mismatch was found in code.

---

## A. Starting state

| Item | Verified value |
| --- | --- |
| PR #16 state | OPEN, MERGEABLE |
| PR head | `0e0c7dbbe3733ba8ea66ddff102cfe5a662bcdc1` |
| Base | `e890cf92965364bd7278b4649236e3812bc8cc4e` |
| CI before deployment | **Pass** — `Lint, typecheck, test, build` |
| Production SHA before | `e890cf9` |
| Staging SHA before | `e5b670f038674f4f2cb1040396dacee389f3f9cb` |
| Production Auto-Deploy | **ON — After CI Checks Pass** (verified `autoDeploy: yes`) |
| Staging Auto-Deploy | **OFF** (verified `autoDeploy: no`) |
| Production service | `bloomcore-one` — unchanged |
| Staging service | `bloomcore-one-staging` — unchanged |

No merge, no production deployment, no service rename, no repository rename,
no domain purchase, no DNS change and no secret rotation were performed.

---

## B. Deployment

| Item | Value |
| --- | --- |
| Deployment ID | `dep-dbn6d5bbc2fs738lva4g` |
| Trigger | Render API, explicit `commitId` |
| Commit | `0e0c7dbbe3733ba8ea66ddff102cfe5a662bcdc1` |
| Final status | **live** |
| URL | `https://bloomcore-one-staging.onrender.com` |
| Auto-Deploy after deploy | **still OFF** |
| Service configuration changed | **No** |

### Health and readiness

| Endpoint | Status | Body (trimmed) |
| --- | --- | --- |
| `/api/health` | **200** | `status=ok`, `env=STAGING`, `commit=0e0c7db…` |
| `/api/health/ready` | **200** | `status=ready`, `database=ok`, `latencyMs≈1124`, `env=STAGING` |

The deployed application identifies itself as **staging**, not production.
Production remained on `e890cf9` throughout.

---

## C. Branding

### Public and unauthenticated surfaces — 22/22 checks passed

Routes tested against the live staging host:

`/`, `/login`, `/admin/login`, `/forgot-password`, `/recover-account`,
`/access`, `/features`, `/solutions`, `/about`, `/contact`, `/privacy`,
`/terms`, `/this-route-does-not-exist-maacash`.

Results:

- All returned HTTP 200.
- Every page contained **MaaCash**.
- **0** pages contained `BloomCore One` or `BloomCore-One`.
- Titles, descriptions, Open Graph and Twitter metadata named MaaCash.
- Login and admin login rendered the MaaCash lockup and parent attribution
  "Built by BloomCore Technologies".
- Not-found page rendered the MaaCash metadata and layout.
- No application JavaScript errors on public pages.

### Metadata, icons and PWA

| Asset / check | Result |
| --- | --- |
| `/manifest.json` | 200, `short_name=MaaCash`, name starts with MaaCash |
| `maacash-icon-192.png` | 200, image/png |
| `maacash-icon-512.png` | 200, image/png |
| `maacash-icon-maskable-512.png` | 200, image/png |
| `/favicon.ico` | 200, image/x-icon |
| `/apple-icon.png` | 200, image/png |
| `maacash-og.png` | 200, image/png |
| Theme colour | `#0e4d34` |
| Service worker | Registered at `/`, controlling the page |
| Installability errors | **[]** (none reported by Chromium) |

Screenshots and raw results: `docs/branding/evidence/staging/`.

### Authenticated admin surface

A real administrator login completed successfully and reached
`/admin/dashboard`. The rendered shell showed:

- `MaaCash`
- `Staging Tenant A`
- `MaaCash · Staging Tenant A · Built by BloomCore Technologies`

No old product name was present in that dashboard body.

### Legacy-name audit

| Location | `BloomCore One` / `BloomCore-One` |
| --- | --- |
| `src/` and `public/` active source | **0** |
| Live public staging pages | **0** |
| Preserved technical identifiers | 27 occurrences across 14 files |

Preserved identifiers are the expected contracts: JWT issuer/audiences, tab
proof headers, legacy cookie cleanup, offline storage names, OIDC product slug,
Turnstile host default, health payload `app`, and Render hostname. They were
not changed.

### Staging metadata defect

The staging HTML contains 6 `bloomcore-one` references. All are absolute
Open Graph/Twitter URLs pointing at the **production** hostname
`https://bloomcore-one.onrender.com`, because staging has no `SITE_URL` set and
falls back to the temporary production URL in `src/lib/site.ts`.

Impact: staging social metadata points at production. It does not affect
production branding or functionality. Fix by setting staging
`SITE_URL=https://bloomcore-one-staging.onrender.com` and redeploying.

---

## D. Authentication

### Real results

| Test | Result |
| --- | --- |
| Admin login on staging with Turnstile | **Pass** — reached `/admin/dashboard` |
| MFA verification | **Pass** — valid TOTP accepted, dashboard reached |
| MFA enrolment | **Pass** — QR/manual key, 6-digit confirmation, recovery codes issued |
| MFA-branded screens | **Pass** — MaaCash lockup on `/mfa/enroll` and `/mfa/verify` |
| Independent tab sessions — distinct users | **Not completed** |
| Tab refresh independence | **Not completed** |
| Copied-URL isolation | **Observed pass** — fresh tab redirected to `/login` |
| Independent logout | **Not validly completed** |
| Service-worker failure fail-closed | **Pass** — worker stopped, tab returned to `/login`, `/api/auth/me` returned 401 |
| Worker / Collector / Customer / Platform login | **Not completed** |

### Why the tab and role matrix is incomplete

Cloudflare Turnstile token issuance became unreliable after repeated automated
logins. Fresh tabs often stayed on "Verifying…" with no token. When tokens were
issued, admin login and MFA passed. This is an automation/challenge limitation,
not an application failure, and enforcement was **not** weakened.

The full multi-tab matrix therefore remains unproven against staging. It is
covered by the repository's automated tab-session tests, which passed, but that
is not a substitute for a real staging browser run.

### Defect found: customer login Turnstile action mismatch

- `src/app/login/UnifiedLoginClient.tsx` renders
  `<TurnstileWidget action="login" />` for every non-admin role.
- Customer login is verified server-side with action
  `"customer_login"` (`src/lib/actions/auth.actions.ts`).
- `verifyTurnstile` rejects a response whose `action` differs from the expected
  action.

With Turnstile enabled, a valid customer challenge token will be rejected with
reason `action`. Customer portal login is therefore expected to fail on staging
and production while Turnstile is enabled. This is a release-blocking defect.
Fix: render `action="customer_login"` when the selected role is Customer, or
align the server action for customer login with the widget action. Do not fix by
disabling Turnstile.

---

## E. PostgreSQL

Disposable Docker databases were used. The persistent staging database was not
targeted by destructive tests.

| Version | Container | Test files | Tests | Result |
| --- | --- | --- | --- | --- |
| PostgreSQL 16 | `postgres:16-alpine` | 6 | 32 | **32/32 pass** |
| PostgreSQL 18 | `postgres:18-alpine` | 6 | 32 | **32/32 pass** |

Coverage includes Prisma compatibility, schema push, Susu financial logic,
financial corrections, withdrawal concurrency, offline idempotency, MFA replay
and Zeli analytics.

No schema migration was introduced. The rebrand changes no database object.

---

## F. Financial workflows

### Baseline staging data (read-only, after acceptance accounts were created)

| Metric | STG-A | STG-B |
| --- | --- | --- |
| Branches | 4 | 4 |
| Users | 9 | 7 |
| Customers | 8 | 7 |
| Contributions | 11 | 11 |
| Withdrawals | 3 | 3 |
| Remittances | 2 | 2 |
| Daily accounts | 3 | 3 |
| Audit logs | 5 | 1 |

Staging uses its own Neon database. Its host fingerprint differs from
production. No production data was copied into staging. No database was reset
or truncated.

### What passed

- PostgreSQL financial suites: corrections, Susu, withdrawal concurrency,
  offline idempotency, tenant-scoped queries.
- Vitest suite: financial security, tenant isolation, branch isolation,
  authentication and audit assertions.

### What was not executed on staging

MoMo/Susu UI workflows, branch-scoped screens, reports, CSV exports,
reconciliation and audit screens were not exercised against staging because
authenticated role sessions could not be established reliably. No financial
records were created or modified during staging acceptance.

---

## G. Paystack

| Check | Result |
| --- | --- |
| Staging key type | **TEST** (`sk_test_*`) — confirmed without printing the key |
| Live key present | **No** |
| Webhook URL | `https://bloomcore-one-staging.onrender.com/api/payments/paystack/webhook` |
| Unsigned request | **401** |
| Invalid signature | **401** |
| Signed synthetic `charge.success` | **200**, `decision=ignored` |
| Duplicate signed event | **200**, `decision=ignored` |
| Real payment triggered | **No** |
| Production Paystack config touched | **No** |

The synthetic event used reference `MAACASH-ACC-1794014173857` and no real
customer data. The handler accepted and ignored it because no matching
subscription exists. This verifies signature enforcement, endpoint
availability and duplicate-safe handling at the route level. A successful
subscription checkout/callback and reconciliation were not exercised.

---

## H. Zeli

- Staging configuration was not changed.
- `ZELI_*` provider flags and DeepSeek credentials were not read or altered.
- External AI was not enabled.
- Authenticated Zeli UI, local responses and business tools were **not**
  exercised on staging because role login was blocked.
- Existing unit/integration tests for Zeli conversation and analytics passed in
  the 599-test suite.
- Limitation: staging Zeli acceptance is incomplete.

---

## I. Browser and PWA

| Check | Result |
| --- | --- |
| Desktop Chromium — public pages | Pass, screenshots captured |
| Mobile 390×844 — home/login/admin login | Pass, no horizontal overflow |
| Old branding in mobile pages | **0** |
| Broken images on public pages | None observed |
| Service worker registration | Active, scope `/` |
| Manifest | Valid, MaaCash |
| Installability | No Chromium installability errors |
| Physical PWA install | Not performed |
| CSP violations | No application CSP violations; third-party Turnstile iframe logged `data:,` connect errors |
| Mixed content | None observed |
| TLS | Valid, `ssl_verify=0`, HTTPS 200 |
| Security headers | CSP, HSTS, DENY framing, nosniff, referrer policy, permissions policy present |

Authenticated browser screenshots beyond the successful admin dashboard were
not captured because of the Turnstile blocker.

---

## J. Quality gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | **58 files, 599 tests, 0 failed** |
| `npm run lint` | **0 errors**, 84 pre-existing warnings |
| `npm run build` | Pass |
| GitHub CI | **Pass** — run 42309076532, 3m27s |
| PostgreSQL 16 | 6 files, 32 tests, pass |
| PostgreSQL 18 | 6 files, 32 tests, pass |
| Playwright staging suite | **Not run** — blocked by Turnstile |
| Local Playwright suite | **Not completed** — local web server returned a 404 shell, harness issue; no product assertion was obtained |

Existing warnings were not introduced by the rebrand. No tests or assertions
were removed or skipped to obtain a pass.

---

## K. Outstanding issues

| # | Issue | Severity | Impact | Required action |
| --- | --- | --- | --- | --- |
| 1 | Customer login uses Turnstile action `login` while server expects `customer_login` | **High** | Customer portal login fails when Turnstile is enabled | Fix action selection, retest, redeploy staging |
| 2 | Turnstile throttles automated logins; tab/role matrix incomplete | High (acceptance gap) | Cannot prove multi-role and multi-tab staging behaviour | Run interactive acceptance in a real browser, or complete challenge manually |
| 3 | Staging `SITE_URL` unset | Low | OG/Twitter URLs point at production host | Set staging `SITE_URL` and redeploy |
| 4 | Paystack success/reconciliation path not exercised | Medium | Subscription payment confirmation unproven on staging | Run a TEST checkout with a seeded plan and matching reference |
| 5 | Zeli authenticated acceptance incomplete | Medium | Zeli UI/provider behaviour unproven on staging | Retest after auth blocker clears |
| 6 | PWA not physically installed | Low | Install prompt not manually confirmed | Install in desktop/mobile browser and verify launch name/icon |
| 7 | Playwright staging not run | Medium | Browser regression evidence incomplete | Run after Turnstile/automation blocker is resolved |

### Test data created in staging

Clearly labelled acceptance-only records were added to allow real login:

- `maacash-acceptance-admin-a@staging.local`
- `maacash-acceptance-admin-b@staging.local`
- `maacash-acceptance-worker-a@staging.local`
- `maacash-acceptance-collector-a@staging.local`
- `maacash-acceptance-customer-a@staging.local` (customer `MAACASH-ACC-STG-A`)
- `maacash-acceptance-platform@staging.local`

Passwords are not recorded in this report or the repository. No existing
tenant, customer, financial record or audit entry was rewritten. MFA was
enrolled on the two acceptance admin accounts during testing.

---

## L. Release recommendation

### STAGING ACCEPTANCE PARTIALLY PASSED — ISSUES TO RESOLVE

- **Deployed staging SHA:** `0e0c7dbbe3733ba8ea66ddff102cfe5a662bcdc1`
- **Deployment ID:** `dep-dbn6d5bbc2fs738lva4g`
- **PR:** https://github.com/Delkay-byte/BloomCore-One/pull/16
- **Production:** untouched at `e890cf9`
- **Staging Auto-Deploy:** OFF

Do **not** merge or promote until the customer-login Turnstile action mismatch
is fixed and the authenticated role/tab matrix is completed. The rebrand itself
passes on every public surface tested; the blockers are authentication
acceptance gaps, not branding regressions.
