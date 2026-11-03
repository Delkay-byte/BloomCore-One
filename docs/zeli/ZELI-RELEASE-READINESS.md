# Zeli — Release Readiness

**Date:** 3 November 2026.
**Production deployment:** NOT AUTHORIZED. Render Auto-Deploy is OFF; merging is
not deployment.

## Status by area

| Area | Status | Notes |
|---|---|---|
| Security closeout | READY | PR #1 merged to `main` (`1d0645c`); daily-account correction screen included. |
| Git integration | READY WITH LIMITATIONS | PR #1 and PR #2 merged; PR #3 open against updated `main` for owner review. No force-push, no deployment. |
| Zeli conversational experience | READY | Providerless deterministic answers; supported intent set; browser-tested. |
| Zeli Business Intelligence | READY WITH LIMITATIONS | Dashboard, charts, filters, explanations and export implemented; staging review pending. |
| Subscription entitlements | READY WITH LIMITATIONS | Manual audited entitlement only; no billing provider/checkout by design. |
| Private intelligence engine | READY | Server-computed metrics, insights and templates; tested. |
| External provider readiness | BLOCKED | DeepSeek disabled by code policy; no privacy approval. |
| Independent penetration-test readiness | BLOCKED | Handover updated, but hosted staging and written authorization do not exist. |
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
