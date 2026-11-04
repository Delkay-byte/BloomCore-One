# Zeli — Staging Deployment and Verification

**Status:** DEPLOYED AND VERIFIED (internal verification, not an independent test).
**Hostname:** https://bloomcore-one-staging.onrender.com
**Deployed commit:** `81d6031` (current PR #4 head)
**Staging Auto-Deploy:** OFF (verified through the Render API)
**Production:** untouched.

## Live recheck (4 November 2026)

- `GET /api/health` returned HTTP 200 with
  `{"status":"ok","app":"bloomcore-one","env":"STAGING","commit":"81d6031d49e0684c746ee095d69b68ef09837baa"}`.
- The deployed commit matches the current PR #4 head, so no additional staging
  deployment was required for this closeout.
- Auto-Deploy remains OFF; staging is deployed manually.

## Blueprint note

The checked-in `render.staging.yaml` is a reviewed template and was not applied to
create the live service. Its `branch: main` entry is a template default; the live
staging service is deployed manually from the approved feature commit with
Auto-Deploy OFF. While Auto-Deploy is OFF, changing the template branch would not
deploy anything.

## Service and database

- Render service: `bloomcore-one-staging`, distinct from `bloomcore-one` and
  `bik-prestige-legacy`.
- Build: `npm ci --include=dev && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build`
- Start: `npm start`
- Health check: `/api/health` returns `env=STAGING` and the deployed commit.
- `DATABASE_URL` uses the Neon pooled hostname; `DIRECT_URL` uses the same
  database's direct hostname.
- Staging database host is distinct from production. Both use the Neon default
  `neondb` database name inside separate projects; the host comparison is the
  isolation evidence.
- No production data was imported.

Sanitized checks passed:

| Check | Result |
|---|---|
| Pooled URL contains `-pooler` | PASS |
| Direct URL present | PASS |
| Staging DB host differs from production | PASS |
| Application health reports `STAGING` | PASS |
| Legacy/production services unchanged | PASS |

## Environment

Present and verified without printing values:

`APP_ENV=STAGING`, `NODE_ENV=production`, `JWT_SECRET`,
`RATE_LIMIT_HMAC_SECRET`, `MFA_ENCRYPTION_KEY`, `MFA_ENFORCEMENT=enforce`,
Turnstile enabled with staging hostname, `TRUSTED_PROXY_HEADERS=true`,
`NEXTAUTH_URL=https://bloomcore-one-staging.onrender.com`,
`ZELI_GATEWAY_MIN_COHORT=5`, payment and DeepSeek credentials present.

`ZELI_SYNTHETIC_TESTING_ALLOWED` was temporarily enabled for the approved
synthetic probe and returned to `false`.

## Migrations

All 20 migrations applied with `prisma migrate deploy --schema=prisma/schema-pg.prisma`.
`prisma migrate status` reports “Database schema is up to date.”

Note on dates: `20261104_zeli_commerce_and_provider_control` was authored in PR #4
as the next sequential migration after `20261103`. It is a logical ordering name,
not a forward-dated database operation. It was **not** renamed after being
applied. The new `20261103_zeli_global_availability` migration sorts before it
and has no dependency on it.

## Synthetic seed

`APP_ENV=STAGING STAGING_SEED_CONFIRM=YES` seeded:

- 2 tenants (`STG-A`, `STG-B`), both ACTIVE with MoMo + Susu.
- Per tenant: owner/admin, worker, agent (worker + MoMo), collector, customer.
- 1 platform Super Admin.
- Synthetic Susu accounts, cycles, contributions, withdrawal, remittance,
  daily account and expense for analytics.
- No prices, no payment records and no production data were copied.

Credentials were written to an operator-specified file outside the repository.
They were not committed, logged in this report or sent to any tester.

## Verification results

Internal staging checks: **26/26 passed**.

- Platform master switch, provider control and commerce panels load.
- Package creation and manual entitlement grant work.
- Tenant A analytics renders with charts; Tenant B is denied.
- Tenant B export returns 403.
- Core Zeli chat works without Analytics entitlement.
- Worker, collector and customer direct Analytics URLs are denied.
- Master Zeli switch OFF: chat/analytics pages show maintenance; chat API and
  export return 503; platform controls remain available.
- Master Zeli switch ON: analytics recovers immediately.
- Package appears on checkout; live Paystack **test-mode** initialization
  redirects to `checkout.paystack.com`.
- No payment was made and no live key was used.

## MFA and Turnstile

- Server-side MFA enforcement: a valid platform session without `amr=pwd+mfa`
  redirects to `/platform/login?reason=mfa_required`.
- Turnstile is enabled, the page loads the Cloudflare script, and login without
  a challenge token is rejected.
- **Cloudflare widget mode:** the owner has confirmed that the staging widget
  uses **Managed mode** and is restricted to
  `bloomcore-one-staging.onrender.com`. This is an owner confirmation, not an
  independent Cloudflare dashboard verification by this workstream. The widget
  and its keys were not changed.

## Paystack live test-mode lifecycle

Using the configured Paystack **test** secret and a controlled signed webhook:

- Invalid signature → HTTP 401.
- Valid `charge.success` → processed; subscription active; entitlement active.
- Duplicate webhook → ignored; no double activation.
- Wrong amount → failed; subscription remained pending.
- `refund.processed` → subscription refunded; entitlement suspended.
- No card payment or customer charge occurred.

The staging environment uses a Paystack **TEST** secret key. The production
environment uses a Paystack **LIVE** secret key. The owner has confirmed that the
two environments are correctly separated. Neither key was displayed, copied,
rotated or changed during this verification, and no live charge was made.

## DeepSeek synthetic probe

- Staging-only key was present (value never displayed).
- `ZELI_SYNTHETIC_TESTING_ALLOWED` was set true, synthetic mode enabled with a
  recorded reason, and the fixed synthetic probe run.
- Probe succeeded: 2002 ms, 257 input tokens, 190 output tokens, model
  `deepseek-flash`.
- Audit row recorded decision `success`, purpose `synthetic_probe`, no prompt or
  payload values.
- A normal tenant chat while synthetic mode was active made **no** provider
  request and remained local.
- Emergency stop set the provider to disabled/emergency; environment permission
  was returned to `false`; the service was redeployed.
- After the stop, a normal chat succeeded locally and provider usage count did
  not increase.
- Production approval code constant remains `false`.

## Remaining owner actions

1. Independent penetration testing is **DEFERRED** — the owner intends to
   arrange it at a later security-assurance stage. No tester has been engaged,
   and this internal verification is not an independent assessment.
2. Keep staging Auto-Deploy OFF unless a deliberate manual deployment is chosen.
3. Decide whether to add a third synthetic tenant for billing isolation tests.
4. Decide the DPIA/privacy position before any approved production AI
   processing. Production AI remains locked by code.
5. Authorise production release separately. This document authorises nothing.
