# MaaCash Rebrand — Migration Report

**Date:** 2026-11-06
**Old product name:** BloomCore One
**New product name:** **MaaCash**
**Parent company:** BloomCore Technologies (unchanged)
**Positioning:** Mobile Money, Susu and Multi-Branch Financial Operations Platform
**Primary rebrand commit:** `3e1daf7`
**Branch:** `feat/maacash-rebrand`
**Base:** `e890cf9` (`origin/main`)

> Final status: **READY FOR OWNER APPROVAL TO DEPLOY**
>
> The code rebrand is complete and locally verified. Infrastructure, domain,
> repository-name, Paystack and OIDC changes require owner approval and were
> deliberately not performed.

---

## A. Product rebrand

### What changed

- Product name: **BloomCore One → MaaCash**.
- Company attribution remains **BloomCore Technologies**.
- Descriptor: "Mobile Money, Susu & Multi-Branch Financial Operations Platform".
- Marketing copy now names MaaCash and describes mobile money, Susu and
  multi-branch operations.

### UI areas updated

- Unified login, admin login, forgot-password, customer forgot-password,
  account recovery and workspace selection.
- Admin, worker, collector, customer and platform shells.
- Navigation, page headers, footers, dashboard copy, error copy, empty-state
  and offline notices.
- Marketing pages: home, features, solutions, contact, not-found.
- Zeli assistant prompts, labels and unavailable states.
- MFA issuer display name.
- CSV export filenames: `maacash-momo-history`, `maacash-momo-reports`,
  `maacash-susu-contributions`, `maacash-money-history`,
  `maacash-susu-statement`.
- Access-link QR download filenames.

### Branding assets

Generated from the existing brand geometry (forest `#0E4D34`, gold `#C9A227`,
ivory `#F6F5EC`, ink `#17211C`, Noto Sans):

- `public/branding/maacash-logo.svg` and light/reversed/mono/stacked variants.
- `public/branding/maacash-mark*.svg`.
- `public/branding/maacash-icon.svg`, PWA 192/512/maskable PNGs.
- `public/branding/maacash-favicon-16/32/48.png`.
- `public/branding/maacash-og.svg` and `maacash-og.png`.
- `src/app/apple-icon.png`, `src/app/favicon.ico`, `src/app/icon.svg`.

Old `bloomcore-one-*` assets were removed after all references moved.

### Metadata and PWA

- Document titles, metadata base, Open Graph and Twitter metadata now use
  MaaCash.
- `public/manifest.json`: name, short name, description and icon paths.
- Apple web app title, application name and theme colour.
- Manifest and icon URLs changed, so installed PWAs fetch new assets. The
  per-tab service worker scope and protocol were not changed.

### Emails and notifications

- This repository has **no email-sending integration**. There were no email
  templates to change.
- In-app notifications and confirmation copy were rebranded.
- No sender address, SPF, DKIM or DMARC record was changed.

### Historical references kept

- Audit logs, transaction history, payment references and receipts already
  issued were not rewritten.
- Historical docs and pentest evidence retain the old name, with the main brand
  document explicitly labelled historical.
- Tenant **BIK Prestige Enterprise** keeps its name: it is a customer business,
  not the product.

---

## B. GitHub

| Item | Value |
| --- | --- |
| Repository | `https://github.com/Delkay-byte/BloomCore-One` |
| Rename performed | **No — owner approval required** |
| History | Preserved; no rewrite |
| Branches | Preserved |
| PRs and issues | Untouched |
| CI workflow | `.github/workflows/ci.yml`, reviewed, no product-name coupling |
| Remote CI result | **Pass** — PR #16, run 42308514524 (`Lint, typecheck, test, build`, 3m55s) |
| Local CI equivalent | Typecheck, tests, lint, production build passed (§H) |

### Prepared rename steps (not executed)

1. Owner approves the repository rename.
2. GitHub → Settings → rename `BloomCore-One` to `MaaCash`.
3. GitHub creates redirects for the old URL.
4. Update local remotes:
   `git remote set-url origin https://github.com/Delkay-byte/MaaCash.git`.
5. Verify Render's GitHub connection still lists the repository.
6. Confirm branch protection, required checks, secrets and environments.
7. Trigger a no-op CI run to confirm the integration.

Do **not** create a new repository and copy the code; that would lose PR and
issue continuity.

---

## C. Render

| Item | Production | Staging |
| --- | --- | --- |
| Service name | `bloomcore-one` | `bloomcore-one-staging` |
| URL | `https://bloomcore-one.onrender.com` | `https://bloomcore-one-staging.onrender.com` |
| Plan / region | Free / Oregon | Free / Oregon |
| Auto-Deploy | **ON — After CI Checks Pass** | **OFF** |
| Renamed | **No** | **No** |
| Deployed this task | **No** | **No** |
| Deployment SHA | unchanged | unchanged |

### Why not rename now

The service name controls the `onrender.com` hostname. That hostname is bound
to the Paystack webhook, Turnstile host allow-list and default OIDC redirect
URI. Renaming now would break those without a coordinated, approved migration.
The public identity is already MaaCash.

### Live verification (read-only)

| Endpoint | Result 2026-11-06 |
| --- | --- |
| `https://bloomcore-one.onrender.com/api/health` | **200**, `env: production`, commit `e890cf9` |
| `https://bloomcore-one-staging.onrender.com/api/health` | **200**, `env: STAGING`, commit `e5b670f` |

Both services are alive and still serving the pre-rebrand builds. The health
payload still reports `app: "bloomcore-one"`; that is a preserved monitoring
identifier, not user-facing branding.

### Configuration changes

None. `render.yaml` and `render.staging.yaml` were updated with comments and
branding only; service names, plans, branches, auto-deploy flags, health checks
and environment variable names are unchanged.

---

## D. Domain

| Candidate | Registry signal | Status |
| --- | --- | --- |
| `maacash.com` | No RDAP registration record on 2026-11-06 | Preferred, reputation check required |
| `maacash.app` | No RDAP registration record on 2026-11-06 | Available candidate |
| `maacash.io` | No RDAP registration record on 2026-11-06 | Available candidate; higher cost |
| `maacash.africa` | No RDAP registration record on 2026-11-06 | Regional candidate |
| `maacash.com.gh` | Registry RDAP unavailable | Verify with Ghana registrar |

- **Selected domain:** none.
- **Purchased:** no.
- **DNS records changed:** none.
- **TLS:** unchanged.
- **Canonical redirects:** unchanged.
- **Old hostnames:** retained and still canonical for now.
- **Important:** `maacash.com` appeared in historical abuse feeds. Run Google
  Safe Browsing, URLhaus and VirusTotal checks before purchase. See
  `docs/branding/MAACASH-DOMAIN-OPTIONS.md`.
- No legal clearance is claimed.

---

## E. Database

| Item | Value |
| --- | --- |
| Production provider | Neon PostgreSQL |
| Staging provider | Separate Neon PostgreSQL database |
| Local/test | SQLite |
| Schema changes | **None** |
| Migration run | **None** |
| Records modified | **None** |
| Backup taken by this task | Not required: no database write occurred |
| Record-count reconciliation | Not applicable |
| Financial balance reconciliation | Not applicable |
| Restore test | Not performed; no restore was needed |

Production and staging remain separate. Connection strings and provider
identifiers were not read or printed. Owner should confirm the provider's
current backup/restore status before any future production deployment.

---

## F. Paystack

| Item | Status |
| --- | --- |
| Production webhook | Unchanged: `https://bloomcore-one.onrender.com/api/payments/paystack/webhook` |
| Staging webhook | Unchanged |
| Callback URLs | Derived from `NEXTAUTH_URL` / `APP_URL`; unchanged |
| Signature verification | Code unchanged (HMAC SHA-512 over raw body) |
| Idempotency | Code unchanged |
| Live keys | Not read, not changed |
| Real payments triggered | **No** |

No Paystack test transaction was run because no staging credentials were
provided. The integration is unchanged by the rebrand.

---

## G. Authentication and SSO

| Control | Status |
| --- | --- |
| Existing users and password hashes | Untouched |
| Roles, permissions, tenants, branches | Untouched |
| MFA enrolments | Untouched; TOTP issuer label now displays MaaCash |
| MFA challenge validation | Unchanged (`bloomcore-one:mfa-challenge` preserved) |
| Independent tab sessions (PR #14 / #15) | Code preserved; automated tests pass |
| JWT issuer/audiences | **Preserved** |
| Tab proof headers and IndexedDB | **Preserved** |
| Legacy cookie cleanup | **Preserved** |
| Service-worker auth binding | **Preserved**; scope unchanged |
| OIDC issuer/client/redirect | **Preserved via env** |
| Control Center product slug | **Preserved:** `bloomcore-one` |
| Immutable user subject mapping | Unchanged |
| Feature flags | Unchanged (`PLATFORM_OIDC_ENABLED` not altered) |
| Security headers / CSP / CORS | Unchanged |
| Session revocation | Unchanged |

No interactive login, MFA challenge or live SSO round-trip was performed
against staging or production. Those remain staging acceptance steps.

---

## H. Quality assurance — exact results

| Check | Command | Result |
| --- | --- | --- |
| Type checking | `npm run typecheck` | **Pass** (no output) |
| Unit + integration tests | `npm test` | **Pass: 58 files, 599 tests, 0 failed** |
| Lint | `npm run lint` | **0 errors, 84 pre-existing warnings** |
| Production build | `npm run build` | **Pass** (Next.js 16.4.3, webpack) |
| Runtime smoke test | `next dev` + HTTP GET | `/` 200, `/login` 200, manifest 200, icon 200 |
| Rendered brand smoke test | HTML inspection | 43 MaaCash references, **0 "BloomCore One"** on home page |
| PostgreSQL test suite | `vitest.pg.config.ts` | **Not run** — no PostgreSQL test database available |
| Playwright E2E | `npm run test:e2e` | **Not run** — no browser/DB environment prepared |
| Mobile viewport tests | — | **Not run** |
| Staging deployment | — | **Not performed** |
| Production deployment | — | **Not performed** |
| Domain/TLS checks | — | **Not applicable** — no domain |

### What the automated suite covers

The 599 tests include authentication, tenant isolation, financial security,
Susu/MoMo workflows, offline isolation, platform OIDC, session revocation,
public routes and release configuration. The tab-session suites passed with the
preserved protocol identifiers.

---

## I. Outstanding owner actions

1. **Review and merge** `feat/maacash-rebrand`.
2. **Approve a repository rename** to `MaaCash` (optional but recommended).
3. **Decide Render service naming.** Current recommendation: keep
   `bloomcore-one` until a custom domain is approved.
4. **Select and purchase a domain.** Not started. Use the domain options
   document. Run reputation checks first.
5. **Approve DNS changes** after purchase. Use only Render's displayed values.
6. **Approve the production deployment** of the rebranded build.
7. **Deploy to staging manually**, at the exact tested SHA, and run the
   functional regression suite.
8. **Run PostgreSQL tests** against a disposable PostgreSQL 16/18 database.
9. **Run Playwright and mobile viewport tests** against staging.
10. **Verify Paystack in staging** with TEST keys and a test transaction.
11. **Verify OIDC/SSO** with the Control Center if the feature is enabled.
12. **Update Paystack webhook** only after a domain cutover.
13. **Update OIDC redirect URIs** only after a domain cutover.
14. **Accept the reauthentication transition** if the origin changes: browser
    storage, service-worker registrations and sessions are origin-bound.
15. **Confirm provider backups** before the production deployment.

---

## J. Final release status

### READY FOR OWNER APPROVAL TO DEPLOY

- **Follow-up PR:** https://github.com/Delkay-byte/BloomCore-One/pull/16
- **Branch:** `feat/maacash-rebrand`
- **Primary commit SHA:** `3e1daf76b2f87d6e6615ed26abacc8218234ff2b`
- **Staging deployment SHA:** none
- **Production deployment SHA:** none
- **Rollback:** redeploy the previous `main` commit (`e890cf9`) in Render. No
  database rollback is needed because no database change was made. Old
  `onrender.com` hosts and callbacks remain active, so rollback is a normal
  code redeploy.

### Honest limitations

- The rebrand was verified locally, not on Render staging or production.
- PostgreSQL, Playwright, mobile viewport, live Paystack and live OIDC checks
  remain outstanding.
- No domain exists yet; the free Render hostname remains the public origin.
- GitHub and Render service names were intentionally not renamed.
