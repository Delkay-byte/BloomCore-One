# Zeli — Production Release Dossier

**Status:** RELEASED. PR #4 merged; production deployed and verified at
`030ff1c`; Zeli availability ON with an audit entry; external AI disabled.
**Prepared:** 4 November 2026. **Owner decision:** production operation
authorized for this release.

## Proposed release

| Item | Value |
|---|---|
| Repository | `Delkay-byte/BloomCore-One` |
| PR | #4 — base `main` at `06ea9df` |
| Branch | `feat/zeli-complete-api-commerce-2026-11` |
| Candidate SHA | `53ceae829b348b2415832eb87a469858a5985d31` (staging-verified) |
| Deployed merge commit | `f4ef60139fd463bf5782797f59f1f44f2946d31b` |
| Current production commit | `030ff1c26faae04d55ad77310ac042f66692049f` (scheduler fix) |
| Production service | `bloomcore-one` |
| Legacy service | `bik-prestige-legacy` — not touched |
| Staging | `bloomcore-one-staging` — manual deploy, Auto-Deploy OFF |
| Production AI | Locked: `PRODUCTION_PROVIDER_APPROVED = false` |

## Evidence recorded before merge

- [x] Unit/integration suite: 49 files, 493/493.
- [x] PostgreSQL suite: 32/32 on PostgreSQL 16.15 and 32/32 on 18.6.
- [x] Browser E2E: 20/20 (desktop and mobile projects).
- [x] Typecheck clean; lint 0 errors / 83 warnings; production build passes.
- [x] Migration rehearsal on PostgreSQL 18.6, empty and upgrade paths; empty
      `migrate diff` — see `ZELI-MIGRATION-REHEARSAL.md`.
- [x] Production `MFA_ENFORCEMENT=enforce` verified through the Render API and
      the blueprint updated to match.
- [x] Payment lifecycle covered by `zeli-billing-lifecycle.test.ts` (25 cases)
      including early renewal, checkout races, duplicate settlement, refund
      retry and webhook replay.
- [x] Expiry sweep implemented and tested; access still denied by `expiresAt`.
- [x] Emergency stop latched independently of provider mode.
- [x] External-AI status header derived from the effective policy.
- [x] Final CI on the exact PR head `b46a0f5` (`Lint, typecheck, test, build`).
- [x] Staging deployment of the final candidate. Health at `53ceae8`, 21/21
      migrations, availability ON, provider latched disabled, chat 401,
      cross-origin 403, unsigned webhook 401. Interactive browser acceptance was
      blocked by Cloudflare Turnstile for the automation browser and is recorded
      as a limitation in `ZELI-STAGING-DEPLOYMENT.md`.
- [x] Merge and production deployment — merge `f4ef601`, deployed and verified.
- [ ] Independent penetration test — **DEFERRED**; owner intends to arrange it.
- [ ] DPIA/privacy/legal approval for approved production AI — outstanding.

## Material environment finding

During this release window the production `PAYSTACK_SECRET_KEY` on
`bloomcore-one` changed from a test key to a **LIVE** key (`sk_live_…`, prefix
only). The release was performed after that change, so production checkout is
now **open for real charges** rather than closed by the test-key guard.

Consequences, recorded honestly:

- No card charge and no checkout initialisation were performed by this
  workstream. No payment row was created.
- The production webhook endpoint must be registered in the Paystack dashboard
  against the LIVE secret before any real payment is attempted. That is an
  owner dashboard check and was not verified here.
- Refunds use the same LIVE secret; the duplicate-payment auto-refund path is
  therefore live as well. It is never triggered by a synthetic test.
- Staging still uses its own TEST key and was not changed.

Also observed: production `DEEPSEEK_API_KEY` now holds a real value, and
`ZELI_DEEPSEEK_APPROVED=true` is set. External AI still cannot run because the
`ZeliProviderControl` row is absent, which resolves to `DEFAULT_CONTROL`
(`mode=disabled`, `enabled=false`, `emergencyDisabled=true`), and because
`PRODUCTION_PROVIDER_APPROVED = false` in code. The key value was not recorded
in this document; it should be rotated as routine hygiene if it was ever
exposed outside the Render dashboard.

## Migration review

Migrations: 21 in the repository. New for this release:

- `20261103_zeli_global_availability` (PR #4)
- `20261104_zeli_commerce_and_provider_control` (PR #4)
- `20261105_zeli_renewal_checkout_refund_expiry` (this remediation)

`20261105` adds nullable/defaulted columns, unique indexes and one new table.
No `DROP`, `DELETE`, `TRUNCATE` or column removal appears in any of them.
Existing financial, subscription, conversation and audit records are untouched.

Apply only with:

```bash
DATABASE_URL=<production pooled> DIRECT_URL=<production direct> \
  npx prisma migrate deploy --schema=prisma/schema-pg.prisma
```

Never run from a build. Never run against staging by accident.

## Pre-deployment

1. Record the Neon recovery point/branch identifier privately.
2. Verify production `DATABASE_URL`/`DIRECT_URL` privately (pooled/direct).
3. Confirm the `20261103_zeli_global_availability` migration inserts the
   `enabled = true` row; the master switch is ON after release unless an
   operator turned it off.
4. Confirm provider control remains `disabled`/latched and
   `PRODUCTION_PROVIDER_APPROVED=false` in the release commit.
5. Production Paystack: **currently a test key**. Either set the LIVE key before
   release or accept that production checkout stays closed with an honest
   message. Do not display the key.
6. Confirm the production webhook endpoint
   `https://bloomcore-one.onrender.com/api/payments/paystack/webhook` is set in
   the Paystack dashboard with the LIVE secret. Do not send a live charge.
7. Confirm production Turnstile keys and hostname
   (`bloomcore-one.onrender.com`) are unchanged.
8. Production `MFA_ENFORCEMENT=enforce` is verified live and matches the
   blueprint.
9. Production Auto-Deploy is `checksPass`: merging `main` triggers a deployment
   after CI passes.

## Deployment sequence (executed)

1. Final CI on `b46a0f5`: `Lint, typecheck, test, build` — pass.
2. `prisma migrate deploy` with the production direct URL — 7 pending migrations
   applied, 14 → 21. No migration dropped or truncated anything.
3. PR #4 merged as `f4ef601` (merge commit). Auto-Deploy started from `main`.
4. First auto-deploy reached `live` but the public origin kept serving the old
   build. A clean redeploy of the same commit (`clearCache: clear`) was issued
   through the Render API and the origin then served `f4ef601`.
5. Smoke verification run against `https://bloomcore-one.onrender.com`.
6. Post-release check found the expiry scheduler hook at the repository root,
   which Next ignores for a `src/app` project, so no sweep ever started. PR #7
   moved it to `src/instrumentation.ts`, added regression tests, and deployed as
   `030ff1c`. Production logs then showed `[zeli-expiry] sweep completed` at
   14:14:50Z and 14:29:44Z, 15 minutes apart.

## Production release record

| Item | Result |
|---|---|
| Merge commit | `f4ef60139fd463bf5782797f59f1f44f2946d31b` |
| Current production commit | `030ff1c26faae04d55ad77310ac042f66692049f` |
| Production `/api/health` | 200, `env=production`, `commit=030ff1c` |
| `/api/health/ready` | 200, `database=ok` |
| Migrations applied | 21/21 (`_prisma_migrations`) |
| `ZeliAvailability` | `enabled=true`, explicit release reason, audited |
| `ZeliProviderControl` rows | 0 → `DEFAULT_CONTROL` (disabled, emergency) |
| `PRODUCTION_PROVIDER_APPROVED` | `false` in the deployed commit |
| Expiry scheduler | in-process, 15-minute sweep, production logs confirm runs |
| `POST /api/zeli/chat` same-origin, no session | 401 `Not authenticated` (Zeli ON) |
| `POST /api/zeli/chat` cross-origin | 403 origin denied |
| `POST /api/payments/paystack/webhook` unsigned | 401 `invalid_signature` |
| `/platform/login` | 200 |
| `/admin/login` | 200 |
| Legacy service `bik-prestige-legacy` | no configuration change; see finding |
| Staging | unchanged at `53ceae8`, Auto-Deploy OFF |

Audit note: the rollout migration seeded `enabled=true`. The explicit release
enablement was then performed as an audited platform operation in one database
transaction: the `ZeliAvailability` row was updated with the release reason and a
`PlatformAuditLog` row `zeli.availability_enabled` was written with the same
reason, the previous value, the previous reason and a marker that it was executed
without a UI session. No operator identity was fabricated (`actorId` is null).
The external-AI control row was not touched and remains absent, so external AI
stays disabled.

## Legacy service coupling

`bik-prestige-legacy` points at the same GitHub repository and `main` branch with
Auto-Deploy on, so it redeployed automatically when PR #4 merged. It also uses
the **same production Neon database** and has no `MFA_ENFORCEMENT`, Turnstile or
`APP_ENV` variables. It was not reconfigured by this workstream, per the
instruction not to modify it. It is a second public entry point to the same data
with weaker login protections and should be retired or hardened by the owner.

## Post-deployment checks still owner-operated

- Authenticated UI walk-through of `/platform/zeli` with a Super Admin session
  (Zeli ON, provider disabled, emergency stop active).
- Tenant-side `/zeli` chat and analytics entitlement checks with a real account.
- Paystack dashboard: confirm the webhook URL and LIVE secret, then send one
  controlled LIVE verification only if the business is ready to take money.

## Rollback

- Application: redeploy the previous successful commit.
- Database: migrations are additive; do not drop tables during rollback.
  Disable Zeli via the master switch first if the issue is Zeli-specific.
- Payments: do not modify payment rows manually; use reconciliation.
- Provider: emergency stop is independent of the Zeli master switch.

## Known limitations

- Approved production DeepSeek processing remains locked by code and policy.
- DPIA/privacy/legal review for external AI remains outstanding.
- Independent penetration testing has not occurred and is **DEFERRED** to the
  owner's later security-assurance stage.
- Production Paystack is now configured with a LIVE key, so production checkout
  is open for real charges. No live charge was made during this release.
- No successful live card payment. Payment behaviour is proven with the
  Paystack TEST environment and signed TEST webhooks.
- Recurring auto-charge requires an owner-configured Paystack plan code.
- Revenue report is gross recorded value, not settled revenue.
- The expiry sweep runs in-process every 15 minutes; it is not a separately
  monitored Render Cron Job.
- Paystack test/live separation is verified by key prefix, not by dashboard
  inspection of the Paystack account.
- Dependency advisories remain in the Prisma CLI chain (`deepmerge-ts`,
  build-time only). Upgrading Prisma is a breaking change outside this release.

## Required owner approvals

1. Merge PR #4 (this alone can trigger production Auto-Deploy).
2. Production deployment timing.
3. Production migration execution.
4. Privacy/DPC position for external AI (or keep disabled).
5. Independent tester and rules of engagement (deferred).
6. Payment/webhook production configuration.

## Owner approval checklist

- [ ] I have reviewed the PR #4 diff at `53ceae8`.
- [ ] I accept that `main` merge triggers production Auto-Deploy.
- [ ] I have taken and recorded a production Neon backup/branch.
- [ ] I have confirmed production Paystack LIVE credentials are set and remain
      unchanged by this release.
- [ ] I have confirmed the production webhook URL and signature secret.
- [ ] I have confirmed production Turnstile configuration and hostname.
- [ ] I accept that Zeli becomes ON for all tenants at first migration, and that
      the master switch is the immediate rollback lever.
- [ ] I accept that approved production AI remains locked.
- [ ] I accept that independent penetration testing is deferred.

## Execution note

Production action was taken by this workstream under the owner's written release
authorisation: migrations were applied, PR #4 was merged, and the service was
redeployed. Exact setting and reason for the one owner-operated dashboard item
(Paystack LIVE key) is recorded under “Material environment finding”.
