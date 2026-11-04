# Zeli — Production Release Dossier

**Status:** NOT APPROVED. PR #4 remains open and unmerged. Production untouched.
**Prepared:** 4 November 2026. **Owner decision:** pending.

## Proposed release

| Item | Value |
|---|---|
| Repository | `Delkay-byte/BloomCore-One` |
| PR | #4 — open, mergeable, base `main` at `06ea9df` |
| Branch | `feat/zeli-complete-api-commerce-2026-11` |
| PR head / proposed release SHA | `81d6031` |
| Changed files | 89 (+8132 / −137) |
| Production service | `bloomcore-one` — do not touch |
| Legacy service | `bik-prestige-legacy` — do not touch |
| Staging | `bloomcore-one-staging` — verified at `81d6031` |
| Production AI | Locked: `PRODUCTION_PROVIDER_APPROVED = false` |

## Evidence recorded before merge

- [x] CI green on `81d6031` (`Lint, typecheck, test, build` — pass).
- [x] Unit/integration suite: 44 files, 435/435.
- [x] PostgreSQL suite: 32/32 against PostgreSQL 16.
- [x] Browser E2E: 20/20 (desktop and mobile projects).
- [x] Typecheck, lint and production build pass.
- [x] Staging deployed at `81d6031`; `/api/health` reports `env=STAGING` and the
      same commit; 26/26 internal staging checks.
- [x] Staging migrations applied; `prisma migrate status` up to date.
- [x] Synthetic staging seed completed (2 tenants, 10 role accounts, 1 platform
      admin); no production data imported.
- [x] Payment lifecycle verified with Paystack **test** mode and signed test
      webhooks; no customer charge.
- [x] Synthetic DeepSeek probe succeeded in an approved staging window;
      environment permission returned to `false` and the provider is disabled.
- [x] Paystack test/live credential separation **owner-confirmed**.
- [x] Turnstile staging widget Managed mode and hostname restriction
      **owner-confirmed**.
- [ ] Owner reviews PR #4 diff and approves merge.
- [ ] Independent penetration test — **DEFERRED**; owner intends to arrange it.
- [ ] DPIA/privacy/legal approval for approved production AI — outstanding.
- [ ] Production backup/snapshot taken immediately before release.

## Migration review

Migrations: 20 in the repository. New for this release:

- `20261102_zeli_assistant` (previous PR #2, already on `main`)
- `20261103_zeli_business_intelligence` (PR #3, already on `main`)
- `20261103_zeli_global_availability` (this PR)
- `20261104_zeli_commerce_and_provider_control` (this PR)

Both new migrations are additive: they create tables, indexes and foreign keys,
and insert one `ZeliAvailability` row with `enabled = true`. No `DROP`,
`DELETE`, `TRUNCATE` or column removal appears in either file. Existing
financial, subscription, conversation and audit records are untouched.

The `20261104` name is a sequential ordering label, not a forward-dated
operation. The full 20-migration sequence was applied to staging PostgreSQL.

Apply only with:

```bash
DATABASE_URL=<production pooled> DIRECT_URL=<production direct> \
  npx prisma migrate deploy --schema=prisma/schema-pg.prisma
```

Never run from a build. Never run against staging by accident.

## Pre-deployment

1. Take a Neon backup/branch/snapshot and record its identifier.
2. Verify production `DATABASE_URL`/`DIRECT_URL` privately (pooled/direct).
3. Confirm the `20261103_zeli_global_availability` migration will insert the
   `enabled = true` row; the master switch is ON for every tenant after release.
4. Confirm provider control remains `disabled`/emergency with
   `PRODUCTION_PROVIDER_APPROVED=false` in the release commit.
5. Confirm production Paystack LIVE credentials are present in the Render
   dashboard and were not changed by this workstream. Do not display them.
6. Confirm the production webhook endpoint
   `https://bloomcore-one.onrender.com/api/payments/paystack/webhook` is set in
   the Paystack dashboard with the LIVE secret and that signature verification
   is enabled. Do not send a live charge; use provider test events only if the
   owner authorises them.
7. Confirm production Turnstile keys and hostname
   (`bloomcore-one.onrender.com`); Managed mode compatibility is the owner's
   Cloudflare decision. No widget or key change is part of this release.
8. Confirm production `MFA_ENFORCEMENT` in the live Render dashboard.
   `docs/security/MFA-ADMIN-SETUP.md` records production as `enforce`, while the
   checked-in `render.yaml` template still shows `optional`. The live value must
   be verified by the owner; this is a documentation/config consistency item, not
   a change made by PR #4.
9. Confirm production Auto-Deploy behaviour: merging `main` can trigger deploy.

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
- No independent audit, certification or penetration test has taken place.
- No successful live card payment; a controlled signed test webhook was used.
- Recurring auto-charge requires an owner-configured Paystack plan code.
- Revenue report is gross recorded value, not settled revenue.
- Paystack test/live separation is owner-confirmed, not independently inspected
  by this workstream.
- Turnstile Managed mode is owner-confirmed, not independently inspected in the
  Cloudflare dashboard by this workstream.

## Required owner approvals

1. Merge PR #4 (this alone can trigger production Auto-Deploy).
2. Production deployment timing.
3. Production migration execution.
4. Privacy/DPC position for external AI (or keep disabled).
5. Independent tester and rules of engagement (deferred).
6. Payment/webhook production configuration.

## Owner approval checklist

- [ ] I have reviewed the 89-file PR #4 diff at `81d6031`.
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
