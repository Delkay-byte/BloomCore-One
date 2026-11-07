# MaaCash — Production Release Report

**Date:** 2026-11-07
**Release:** MaaCash rebrand — PR #16
**Production URL:** https://bloomcore-one.onrender.com

---

## A. Final staging acceptance

| Item | Value |
| --- | --- |
| PR head accepted | `67cb5792939d2ccff505a043056156cf01e83199` |
| Staging deployment ID | `dep-dbn99d5g1s2s73c1s240` |
| Deployed staging SHA | `67cb5792939d2ccff505a043056156cf01e83199` |
| Health | **200**, `env=STAGING`, correct commit |
| Readiness | **200**, `status=ready`, `database=ok` |
| Staging Auto-Deploy | **OFF** |

### Staging / PR SHA reconciliation

The previous staging SHA `791e4a78d35584abae708b5bb185ec3795ea5cd5` was an
ancestor of PR head `67cb5792939d2ccff505a043056156cf01e83199`.

Verified comparison:

- `git diff --name-status 791e4a7..67cb579` showed only:
  - `docs/branding/MAACASH-STAGING-ACCEPTANCE-REPORT.md`
  - four `docs/branding/evidence/staging/acceptance-live/*.json` files.
- `git diff 791e4a7..67cb579 -- src prisma public package.json package-lock.json`
  produced **0 lines**.
- The final PR head was then deployed to staging explicitly by commit ID, so
  staging now runs the exact accepted PR commit, not just an equivalent tree.

### Physical PWA installation

**PASS — owner-confirmed.** The owner installed MaaCash from
`https://bloomcore-one-staging.onrender.com` through the browser install
interface, launched the standalone application and reopened it. This result is
owner-confirmed; the agent did not observe the operating-system install dialog.
The automated checks independently confirmed the manifest, 192/512/maskable
icons, `display=standalone`, active service worker and zero installability
errors.

### Role, financial and tab-session acceptance

The accepted application code is unchanged from the previously verified build.
Retained evidence:

- 622 unit/integration tests.
- 51 security tests.
- PostgreSQL 16: 32/32.
- PostgreSQL 18: 32/32.
- Playwright: 31/31, including mobile Chromium.
- Real staging logins for customer, MoMo, Susu, administrator A/B and platform.
- Customer `customer_login`; staff `login`; admin `admin_login`; platform
  `platform_login`.
- Independent tabs, refresh restoration, copied-URL isolation, independent
  logout and cross-role isolation.
- Financial workflows, branch isolation, reports, CSV export and audit.
- Paystack TEST checkout, signed webhook success, replay protection and
  entitlement update.
- Zeli in the existing staging configuration.

Final staging smoke after deploying `67cb579`:

- 9 public/staging pages returned **200** with MaaCash and no old product name.
- Staging metadata remained staging-hosted, `noindex, nofollow`, no canonical,
  empty sitemap.
- Playwright staging CSP smoke passed.

---

## B. Merge

| Item | Value |
| --- | --- |
| PR | https://github.com/Delkay-byte/BloomCore-One/pull/16 |
| Base | `main` |
| Head | `feat/maacash-rebrand` |
| Merge method | Merge commit (history preserved) |
| Merge commit | `ea869a9a1ba8391ba44ea06f6cdc9eb720d14037` |
| PR state | **MERGED** |
| Merge timestamp | 2026-11-07T03:05:59Z |
| CI on merge commit | **Pass** — run `42332399710` |

`main` advanced from `e890cf92965364bd7278b4649236e3812bc8cc4e` to
`ea869a9a1ba8391ba44ea06f6cdc9eb720d14037`.

Branch protection: the repository currently reports `main` as unprotected
(`404 Branch not protected`). No protection rule was bypassed because none is
configured. Required CI still passed before merge.

Reviews/comments: no unresolved review threads or change requests.

---

## C. Production deployment

| Item | Value |
| --- | --- |
| Render service | `bloomcore-one` (`srv-dbjalrk9v7es739ifkp0`) — unchanged |
| Deployment ID | `dep-dbn9d4ivcj2c73873ug0` |
| Trigger | `new_commit` — automatic after CI |
| Deployed SHA | `ea869a9a1ba8391ba44ea06f6cdc9eb720d14037` |
| Status | **live** |
| Finished | 2026-11-07T03:13:15Z |
| Production URL | https://bloomcore-one.onrender.com |
| Health | **200**, `env=production`, commit `ea869a9…` |
| Readiness | **200**, `status=ready`, `database=ok`, latency ≈1.3 s |

The deployment was not started manually and no different commit was deployed
over it. No production environment variable was changed.

---

## D. Production verification

### Public application

| Check | Result |
| --- | --- |
| `/` | 200, MaaCash, no old product name |
| `/login` | 200, MaaCash |
| `/admin/login` | 200, MaaCash |
| `/features`, `/solutions`, `/about`, `/contact`, `/privacy`, `/terms` | 200, MaaCash |
| Page titles | MaaCash |
| Canonical URL | Present, production host |
| Open Graph / Twitter URLs | Production host only; zero staging URLs |
| Production robots meta | No `noindex` |
| Manifest | MaaCash, standalone, correct start URL |
| 192 / 512 / maskable icons | 200, `image/png` |
| OG image and Apple icon | 200 |
| Old product branding on active pages | **0** |

### Authentication surfaces

| Surface | Rendered Turnstile action | Token issued | Result |
| --- | --- | --- | --- |
| Customer | `customer_login` | Yes | **PASS** |
| MoMo/Susu | `login` | Yes | **PASS** |
| Administrator | `admin_login` | Yes | **PASS** |
| Platform | `platform_login` | Yes | **PASS** |

### Real production login and MFA

**BLOCKED — no authorised production account exists.** The owner confirmed that
no production account is registered for sign-in and instructed the agent to
confirm the login surface and continue.

What was verified without creating or modifying production data:

- Login pages render the MaaCash lockup and correct role surfaces.
- Each login surface issues a real Turnstile challenge with the correct action.
- `/api/auth/me` returns **401** before authentication.
- The login response sets **no legacy authentication cookie**.
- The tab-session architecture is covered by the 31/31 Playwright suite on the
  same application commit.
- The MFA enforcement configuration remains `enforce`.

A real dashboard login, tenant identity read and live logout could not be
performed without an authorised account. No production user, MFA secret or
credential was created or changed to work around this.

### Security headers

| Header | Result |
| --- | --- |
| Content-Security-Policy | Present, nonce-based |
| `script-src unsafe-inline` | Absent |
| `script-src unsafe-eval` | Absent |
| HSTS | `max-age=63072000; includeSubDomains; preload` |
| X-Frame-Options | `DENY` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | Camera, microphone, geolocation, payment, USB disabled |

No CSP violation was observed on the public/login surfaces.

### Financial and payment safety

No real MoMo or Susu transaction, customer balance change, subscription,
withdrawal, remittance, branch setting or Paystack LIVE payment was created or
modified during production verification.

---

## E. Preserved systems

| System | Status |
| --- | --- |
| Production database | Unchanged Neon database; separate host from staging |
| Existing users and MFA | Unchanged |
| Paystack LIVE configuration | Unchanged; no LIVE payment triggered |
| Turnstile production host | `bloomcore-one.onrender.com` |
| OIDC/SSO variables and redirects | Unchanged; no OIDC env keys added |
| JWT issuer/audiences | Unchanged |
| Authentication headers / IndexedDB contracts | Unchanged |
| Render production service name and ID | Unchanged |
| Render staging service name and ID | Unchanged |
| GitHub repository name | Unchanged |
| Production Auto-Deploy | **ON** |
| Staging Auto-Deploy | **OFF** |
| Database migration in this release | **None** |
| Production environment variables changed | **None** |

---

## F. Outstanding work

These are separate future tasks, not release blockers:

1. **Custom domain and DNS migration** — current production URL remains
   `https://bloomcore-one.onrender.com`.
2. **GitHub repository rename** — repository identity intentionally unchanged.
3. **Production login/MFA acceptance with a real owner account** — blocked only
   because no production account is registered; complete when the owner creates
   or nominates an authorised account.
4. **Render service rename** — intentionally deferred to an approved migration
   because the hostname is used by Turnstile, Paystack and OIDC callbacks.

---

## G. Rollback readiness

| Item | Value |
| --- | --- |
| Previous production SHA | `e890cf92965364bd7278b4649236e3812bc8cc4e` |
| Previous deployment | `dep-dbn1l2c9v7es738fkh90` |
| Availability | Retained in Render deployment history |
| Database rollback | Not required — no schema change |

Rollback procedure:

1. In Render, open the `bloomcore-one` service and deploy the previous commit
   `e890cf92965364bd7278b4649236e3812bc8cc4e` (or roll back to
   `dep-dbn1l2c9v7es738fkh90`).
2. Keep the existing Neon production database and all financial records.
3. Do not restore an older database backup over newer financial data.
4. Re-enable production Auto-Deploy after the rollback is confirmed.

---

## H. Final status

### MAACASH LIVE — PRODUCTION ACCEPTANCE PASSED

- **Final production SHA:** `ea869a9a1ba8391ba44ea06f6cdc9eb720d14037`
- **Production deployment ID:** `dep-dbn9d4ivcj2c73873ug0`
- **Production URL:** https://bloomcore-one.onrender.com
- **Health:** 200
- **Readiness:** 200, database healthy
- **PR #16:** MERGED
- **Staging:** exact PR head `67cb579`, deployment `dep-dbn99d5g1s2s73c1s240`

The production URL serves the approved MaaCash build. The only verification gap
is a real production dashboard login, because no authorised production account
exists; the owner explicitly accepted this limitation and asked the release to
continue.
