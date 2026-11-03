# Zeli — Release Readiness

**Date:** 4 November 2026.
**Production deployment:** NOT AUTHORIZED. Render Auto-Deploy is OFF; merging is
not deployment.

## Status by area

| Area | Status | Notes |
|---|---|---|
| Security closeout | READY | PR #1 merged to `main` (`1d0645c`); daily-account correction screen included. |
| Git integration | READY WITH LIMITATIONS | PR #1 and PR #2 merged; PR #3 open against updated `main` for owner review. No force-push, no deployment. |
| Zeli conversational experience | READY | Providerless deterministic answers; supported intent set; browser-tested. |
| Zeli Business Intelligence | READY WITH LIMITATIONS | Dashboard, charts, filters, explanations and export implemented; staging deployment/verification recorded separately. |
| Subscription entitlements | READY WITH LIMITATIONS | Paystack checkout and controlled signed-webhook lifecycle verified in staging test mode; no live charge. |
| Private intelligence engine | READY | Server-computed metrics, insights and templates; tested. |
| External provider readiness | READY WITH LIMITATIONS | Fixed synthetic staging probe succeeded; production remains locked. |
| Independent penetration-test readiness | BLOCKED | Staging verified; external tester and written authorization still missing. |
| Production release | BLOCKED | Owner authorization and staging validation required. |

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
- Staging is prepared, not deployed.

## Git state

- `main` includes PR #1 merge `1d0645c` and PR #2 merge `2c7afed`.
- Analytics branch: `feat/zeli-business-intelligence-2026-11`.
- Analytics PR: <https://github.com/Delkay-byte/BloomCore-One/pull/3>.
- Production Auto-Deploy: OFF. No deployment performed.

## Release gate

Do not deploy until:

1. PR #1 is merged and CI is green.
2. PR #2 is reconciled without force-push.
3. The analytics PR is reviewed and CI is green.
4. Owner approves production deployment explicitly.
5. `prisma migrate deploy` is run by the operator against the approved database.
6. Staging, privacy and penetration-test approvals are recorded.

## Global availability addendum

- Entire-Zeli master switch implemented and enforced server-side.
- Separate from external-AI mode and DeepSeek emergency stop.
- Migration preserves ON for existing installations; missing/error fails closed.
- Subscription/payment lifecycle remains operational while Zeli is OFF.
- Browser and action tests cover OFF/ON and cross-role denial.

## Staging verification (4 November 2026)

- Commit `76b0356`, host `bloomcore-one-staging.onrender.com`.
- Staging Auto-Deploy OFF.
- 20/20 migrations; 2 tenants, 10 synthetic accounts.
- 26/26 internal staging checks.
- Paystack test checkout initialization and controlled signed webhook lifecycle
  verified; no live payment.
- DeepSeek synthetic probe succeeded; emergency stop restored and environment
  permission returned to false.
- Production untouched; PR #4 remains open.
