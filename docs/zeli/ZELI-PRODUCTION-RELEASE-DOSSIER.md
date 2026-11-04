# Zeli — Production Release Dossier

**Status:** RELEASE CANDIDATE. Engineering remediation complete; staging verified
at `53ceae8`; PR #4 open and awaiting final CI, merge and production deployment.
**Prepared:** 4 November 2026. **Owner decision:** production operation
authorized for this release.

## Proposed release

| Item | Value |
|---|---|
| Repository | `Delkay-byte/BloomCore-One` |
| PR | #4 — base `main` at `06ea9df` |
| Branch | `feat/zeli-complete-api-commerce-2026-11` |
| Candidate SHA | `53ceae829b348b2415832eb87a469858a5985d31` (staging-verified) |
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
- [ ] Final CI on the exact PR head.
- [x] Staging deployment of the final candidate. Health at `53ceae8`, 21/21
      migrations, availability ON, provider latched disabled, chat 401,
      cross-origin 403, unsigned webhook 401. Interactive browser acceptance was
      blocked by Cloudflare Turnstile for the automation browser and is recorded
      as a limitation in `ZELI-STAGING-DEPLOYMENT.md`.
- [ ] Merge and production deployment.
- [ ] Independent penetration test — **DEFERRED**; owner intends to arrange it.
- [ ] DPIA/privacy/legal approval for approved production AI — outstanding.

## Material environment finding

Production `bloomcore-one` is configured with a Paystack **test** key
(`sk_test_…`), not a LIVE key. The application therefore keeps production
checkout closed with an honest message instead of taking an unsettled order.
This is an owner-operated Render dashboard action: set `PAYSTACK_SECRET_KEY` on
`bloomcore-one` to the LIVE secret key, then redeploy. No key value is recorded
here and the key must never be copied to staging.

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

## Deployment sequence (owner only)

1. Approve merge and production deployment.
2. Merge PR #4 (this may trigger Auto-Deploy on CI pass).
3. Run migration deploy with the direct URL **before** or independently of
   relying on the app.
4. Verify `/api/health` reports the expected commit and `APP_ENV`.
5. Verify `/platform/login` and `/admin/login`.
6. Verify the payment webhook endpoint responds and rejects an unsigned request.
7. Verify `/platform/zeli`: Zeli ON, provider disabled, emergency stop active,
   production processing locked.
8. Verify analytics/chat with a synthetic tenant or controlled support account.
9. Monitor errors, latency, provider usage, entitlement and payment events.

## Post-deployment health checks

- `GET /api/health` returns 200 with the release commit.
- Platform login and tenant login succeed; MFA behaves as configured.
- `/zeli` answers locally with external AI disabled.
- Unentitled tenant is denied analytics; export returns 403.
- `/platform/zeli` shows Zeli ON and provider disabled.
- Webhook rejects an unsigned POST and acknowledges a valid test event without
  granting access from a browser redirect.
- No unexpected provider usage rows appear.

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
- Production Paystack is configured with a test key, so live checkout stays
  closed until the owner sets the LIVE key in Render.
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

No production action was taken by this work.
