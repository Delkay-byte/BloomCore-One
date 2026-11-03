# Zeli — Production Release Dossier

**Status:** NOT APPROVED. PR #4 remains open. Production untouched.

## Proposed release

| Item | Value |
|---|---|
| Repository | `Delkay-byte/BloomCore-One` |
| Branch | `feat/zeli-complete-api-commerce-2026-11` |
| Proposed code SHA | `2050c01` (staging-verified); final docs head may be later |
| Base | `main` at `06ea9df` |
| PR | #4 — open |
| Production service | `bloomcore-one` — do not touch |
| Legacy service | `bik-prestige-legacy` — do not touch |
| Staging | `bloomcore-one-staging` — verified |

## Evidence required before merge

- [ ] Owner reviews PR #4 diff and approves.
- [ ] CI green on final head.
- [ ] Five consecutive full-suite runs recorded.
- [ ] PostgreSQL suite green.
- [ ] Browser E2E 20/20.
- [ ] Staging 26/26 with migrations/seed.
- [ ] Payment lifecycle reviewed; separate staging test key recommended.
- [ ] Turnstile Managed mode confirmed for staging.
- [ ] Independent penetration test completed or explicitly waived by owner.
- [ ] DPC/privacy approval status recorded.
- [ ] Production backup/snapshot taken.

## Migration review

Migrations: 20. New for this release:

- `20261102_zeli_assistant` (previous PR #2)
- `20261103_zeli_business_intelligence` (PR #3)
- `20261103_zeli_global_availability` (this PR)
- `20261104_zeli_commerce_and_provider_control` (this PR)

All applied successfully to staging PostgreSQL. The `20261104` name is a
sequential ordering label, not a forward-dated operation.

Apply only with:

```bash
DATABASE_URL=<production pooled> DIRECT_URL=<production direct> \
  npx prisma migrate deploy --schema=prisma/schema-pg.prisma
```

Never run from a build. Never run against staging by accident.

## Pre-deployment

1. Take a Neon backup/branch/snapshot and record its identifier.
2. Verify production `DATABASE_URL`/`DIRECT_URL` privately (pooled/direct).
3. Confirm production `ZELI_AVAILABILITY` migration will insert an enabled row.
4. Confirm provider control remains `disabled`/emergency or explicitly approved.
5. Confirm `PRODUCTION_PROVIDER_APPROVED=false` in the release commit.
6. Confirm Paystack production/test key status and webhook URL.
7. Confirm Turnstile production keys and hostname.
8. Confirm production Auto-Deploy behavior: merging `main` can trigger deploy.

## Deployment sequence (owner only)

1. Approve merge and production deployment.
2. Merge PR #4 (or deploy the exact SHA through the approved process).
3. Run migration deploy with direct URL.
4. Verify `/api/health` reports the expected commit and `APP_ENV`.
5. Verify `/platform/login` and `/admin/login`.
6. Verify payment webhook endpoint and signature configuration.
7. Verify Zeli master switch ON/OFF and provider disabled.
8. Verify analytics/chat with a synthetic tenant or controlled support account.
9. Monitor errors, latency, provider usage and payment events.

## Rollback

- Application: redeploy the previous successful commit.
- Database: migrations are additive; do not drop tables during rollback.
  Disable Zeli via the master switch first if the issue is Zeli-specific.
- Payments: do not modify payment rows manually; use reconciliation.
- Provider: emergency stop is independent of the Zeli master switch.

## Known limitations

- Staging Paystack test key is shared with production's test key.
- Turnstile widget mode not independently verified.
- No independent penetration test yet.
- No successful live card payment; controlled signed webhook used.
- Recurring auto-charge requires an owner-configured Paystack plan code.
- Revenue report is gross recorded value, not settled revenue.
- Production AI remains locked.

## Required owner approvals

1. Merge PR #4.
2. Production deployment timing.
3. Production migration execution.
4. Privacy/DPC position for external AI (or keep disabled).
5. Independent tester and rules of engagement.
6. Payment/webhook production configuration.

No production action was taken by this work.
