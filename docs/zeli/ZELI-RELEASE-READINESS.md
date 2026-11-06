# Zeli — Release Readiness

**Date:** 4 November 2026.
**Production deployment:** NOT AUTHORIZED. Production Render Auto-Deploy is
**ON**, so merging PR #4 into `main` may deploy production automatically. No
merge, push to `main`, production migration or production credential change was
performed by this workstream.

## Status by area

| Area | Status | Notes |
|---|---|---|
| Security closeout | READY | PR #1 merged to `main` (`1d0645c`); daily-account correction screen included. |
| Git integration | READY WITH LIMITATIONS | PR #1, #2 and #3 merged. PR #4 at `53ceae8` against `main` `06ea9df`, mergeable, CI green. No force-push. |
| Zeli conversational experience | READY | Providerless deterministic answers; supported intent set; browser-tested. |
| Zeli Business Intelligence | READY WITH LIMITATIONS | Dashboard, charts, filters, explanations and export implemented; staging verified at `53ceae8`. |
| Subscription checkout | READY WITH LIMITATIONS | Paystack checkout and signed-webhook lifecycle verified in staging test mode; no live charge. |
| Paystack staging verification | READY WITH LIMITATIONS | Test-mode lifecycle and signed test webhook verified. Production also holds a test key, so production checkout stays closed until the owner sets a LIVE key. |
| Private intelligence engine | READY | Server-computed metrics, insights and templates; tested. |
| DeepSeek synthetic integration | READY | Approved staging probe succeeded; permission returned to `false`; provider disabled. |
| Approved production AI | BLOCKED | Locked by `PRODUCTION_PROVIDER_APPROVED = false` and missing DPIA approval. |
| Entire-Zeli master switch | READY | Database-backed, fail-closed, Super Admin only; enforced on tenant routes, actions, APIs and exports; separate from provider control. |
| Internal security testing | READY | Automated regression, PostgreSQL, browser and staging checks. Not independent. |
| Independent penetration testing | DEFERRED | Owner intends to arrange it later; no tester engaged or contacted. |
| Production release preparation | READY WITH LIMITATIONS | Dossier, migrations, backup, deployment and rollback documented; owner approvals outstanding. |
| Production deployment | BLOCKED | Owner authorisation and production backup required. |

## Implemented and available without external AI

- `/zeli` supported intents and role-scoped summaries.
- `/admin/zeli-analytics` KPIs, charts, filters, refresh, export.
- Rule-based insights with calculation/source/freshness/limitations.
- Platform `/platform/zeli` entitlement management and aggregate health.
- Daily-account correction screen.
- Provider-disabled status on both admin surfaces.

## Implemented but denied by policy

- DeepSeek adapter (inert).
- Outbound gateway delivery (evaluates and denies; audit only).
- External provider credential use.

## Planned / requiring external approval

- Automatic add-on billing.
- DPIA sign-off for any external provider.
- Hosted staging for independent testing.
- Local inference host (optional future work).
- Production deployment.

## Known limitations

- Analytics refresh is on-demand with a 60-second TTL, not real-time streaming.
- Branch attribution uses the recording user's or collector's assigned location.
- Customer analytics counts are aggregate; branch-level new-customer counts are
  tenant-wide only.
- Existing dev-tool dependency advisories remain; no critical advisory.
- E2E runs on synthetic SQLite fixtures, not staging.
- No pricing or checkout exists because the repository had no billing system.

## Commerce/provider addendum

- Subscription checkout and lifecycle implemented; no price seeded.
- DeepSeek adapter uses the fixed official endpoint and aggregate package.
- Global AI control has disabled/synthetic/approved states and emergency stop.
- Production AI remains locked by code and approval gates.
- Staging is deployed and verified at `53ceae8`.

## Git state

- `main` includes PR #1 merge `1d0645c`, PR #2 merge `2c7afed` and PR #3 merge
  `06ea9df`.
- PR #4: <https://github.com/Delkay-byte/BloomCore-One/pull/4> — OPEN,
  mergeable, head `53ceae8`, base `main` `06ea9df`.
- CI on `53ceae8`: `Lint, typecheck, test, build` — pass.
- Production Auto-Deploy: **ON** (deploys on CI pass). Not triggered by this work.

## Release gate

Do not deploy until:

1. Owner reviews the PR #4 diff at the release SHA.
2. CI is green on the final head.
3. Owner takes and records a production database backup.
4. Owner approves production deployment explicitly.
5. `prisma migrate deploy` is run by the operator against the approved direct URL.
6. Privacy decisions and the deferred penetration test are recorded as accepted
   residual risks.

## Global availability addendum

- Entire-Zeli master switch implemented and enforced server-side.
- Separate from external-AI mode and DeepSeek emergency stop.
- Migration preserves ON for existing installations; missing/error fails closed.
- Subscription/payment lifecycle remains operational while Zeli is OFF.
- Browser and action tests cover OFF/ON and cross-role denial.

## Staging verification (4 November 2026)

- Commit `53ceae8`, host `bloomcore-one-staging.onrender.com`; live `/api/health`
  reports the same commit and `env=STAGING`.
- Staging Auto-Deploy OFF; deployed manually.
- 21/21 migrations; 2 tenants, 10 synthetic accounts; database up to date.
- 26/26 internal staging checks ran on the earlier `81d6031` candidate; the same
  application paths are unchanged in `53ceae8`. API-level checks on `53ceae8`:
  health ready, chat 401 same-origin, chat 403 cross-origin, unsigned webhook 401.
  Interactive browser login on `53ceae8` was blocked by a Cloudflare Turnstile
  challenge for the automation browser; recorded as a limitation.
- Paystack test checkout initialization and controlled signed webhook lifecycle
  verified; no live payment and no customer charge.
- Paystack test/live separation and Turnstile Managed mode are owner-confirmed.
- DeepSeek synthetic probe succeeded; emergency stop restored and environment
  permission returned to false.
- Production untouched; PR #4 remains open and unmerged.

## Production release (4 November 2026)

- PR #4 merged to `main` as `f4ef601`; production deployed and verified at that
  commit (`env=production`, `database=ok`).
- Migrations applied to production: 14 → 21, all additive.
- Zeli global availability: **ON** (`ZeliAvailability.enabled=true`, seeded by
  the rollout migration; no audited operator entry because no Super Admin
  session was used).
- External AI: **OFF**. `ZeliProviderControl` has no row, so the effective
  policy is `DEFAULT_CONTROL` (disabled and emergency-disabled), and
  `PRODUCTION_PROVIDER_APPROVED=false`.
- Smoke: chat 401 same-origin, chat 403 cross-origin, unsigned webhook 401,
  `/platform/login` 200, `/admin/login` 200.
- Staging unchanged at `53ceae8`, Auto-Deploy OFF.
- Paystack on production is now a LIVE key; checkout is open for real charges.
  No live charge was made.

## Scheduler fix after release (4 November 2026)

- The expiry hook was at the repository root; with `src/app` Next ignores that
  location, so no sweep ran. PR #7 moved it to `src/instrumentation.ts` and added
  regression tests.
- Production deployed `030ff1c`; Render logs show
  `[zeli-expiry] sweep completed` at 14:14:50Z and 14:29:44Z, 15 minutes apart.
- Zeli availability was explicitly re-enabled with an audited reason after the
  release; `PlatformAuditLog` contains `zeli.availability_enabled`.
- External AI remains disabled: `ZeliProviderControl` has no row and
  `PRODUCTION_PROVIDER_APPROVED=false`.
