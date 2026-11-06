# Zeli — Staging Deployment and Verification

**Status:** PRESERVED. Manual deployment only; Auto-Deploy OFF. Candidate
verification is recorded below after each release candidate.
**Hostname:** https://bloomcore-one-staging.onrender.com
**Staging Auto-Deploy:** OFF (verified through the Render API:
`autoDeployTrigger=off`)
**Production:** separate service, separate Neon project, LIVE credentials.

## Live recheck (4 November 2026)

- Staging service confirmed through the Render API: `bloomcore-one-staging`,
  plan retained, Auto-Deploy off.
- Staging `MFA_ENFORCEMENT=enforce`; `PAYSTACK_SECRET_KEY` is a **TEST** key;
  `ZELI_SYNTHETIC_TESTING_ALLOWED=false`.
- Staging database uses the pooled hostname for runtime and the direct hostname
  for migrations, in the staging Neon project only.
- Candidate deployment and acceptance results are appended below for this
  release.

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

All 21 migrations applied with `prisma migrate deploy --schema=prisma/schema-pg.prisma`.
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
service is currently configured with a Paystack **TEST** key as well, not a LIVE
key; that is a separately recorded material finding in
`ZELI-PRODUCTION-RELEASE-DOSSIER.md`. The application therefore keeps production
checkout closed with an honest message. The secrets are stored in separate
services and separate Neon projects; neither key was displayed, copied, rotated
or changed during this verification, and no live charge was made.

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

## Candidate `53ceae8` — final verification

Deployment and evidence for the release candidate
`53ceae829b348b2415832eb87a469858a5985d31`.

| Check | Result |
|---|---|
| Manual deploy of `53ceae8`, Auto-Deploy still OFF | PASS |
| `/api/health` returns `env=STAGING`, `commit=53ceae82…` | PASS |
| `/api/health/ready` returns `status=ready`, `database=ok` | PASS |
| `prisma migrate deploy` — 21/21 migrations applied | PASS |
| `ZeliAvailability` row `global` present and `enabled=true` | PASS |
| `ZeliProviderControl` `mode=disabled`, `enabled=false`, latched | PASS |
| `ZELI_SYNTHETIC_TESTING_ALLOWED=false` | PASS |
| `POST /api/zeli/chat` same-origin, no session → 401 `Not authenticated` (not 503) | PASS |
| `POST /api/zeli/chat` cross-origin → 403 origin denied | PASS |
| `POST /api/payments/paystack/webhook` unsigned → 401 `invalid_signature` | PASS |

The 401 rather than 503 on the chat route proves the global availability guard is
open; the same-origin guard and authentication still reject the request.

Limitation recorded honestly: interactive staging acceptance through the browser
could not be completed by this workstream on this candidate. The `/admin/login`
page loads, but Cloudflare Turnstile presents an interactive challenge to the
automation browser, so the session never reaches the MFA step. This is a
Turnstile/automation interaction, not a product failure. The authenticated
UI walk-through (master switch, provider controls, commerce panels, analytics
entitlements) was previously executed on the `81d6031` candidate with the same
application code paths and is not re-claimed for `53ceae8`. An owner-operated
manual login remains the way to re-run those UI checks on the final candidate.



1. Independent penetration testing is **DEFERRED** — the owner intends to
   arrange it at a later security-assurance stage. No tester has been engaged,
   and this internal verification is not an independent assessment.
2. Keep staging Auto-Deploy OFF unless a deliberate manual deployment is chosen.
3. Decide whether to add a third synthetic tenant for billing isolation tests.
4. Decide the DPIA/privacy position before any approved production AI
   processing. Production AI remains locked by code.
5. Authorise production release separately. This document authorises nothing.
