# Deployment smoke test matrix

Date: 25 November 2026. Release remains **HELD**. No deployed origin was
contacted in this task.

## 1. Change made (`Verified in code`)

The six deployed-origin checks were in `e2e/custom-domain.spec.ts` and skipped
in every local run. They were moved unchanged to
`e2e/deployment-smoke.spec.ts` and given a separate config
(`playwright.deployment.config.ts`) and script (`npm run test:e2e:deployment`).
The normal `playwright.config.ts` now ignores that file, so the local functional
E2E suite contains no unexplained deployment skips.

No assertion was deleted or weakened. No deployment check is reported as a
local pass.

## 2. Individual check inventory

| # | Exact test name | Verifies | Mutating? | Required environment | Why not local | Local equivalent? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `serves canonical metadata and no Render host in public HTML` | canonical link/OG URL, no Render host in HTML | No | `MAACASH_CANONICAL_ORIGIN` | Needs the deployed canonical response | Local metadata unit tests exist; deployed value cannot be proven locally |
| 2 | `sitemap and robots use the canonical origin` | sitemap `<loc>` and robots `Sitemap:` | No | `MAACASH_CANONICAL_ORIGIN` | Origin-bound generated values | Local generation is covered by unit tests; deployed value is deployment-only |
| 3 | `manifest and service worker install on the custom origin` | manifest fields, SW script, registration scope | Registers/unregisters a local SW only | `MAACASH_CANONICAL_ORIGIN` | SW scope is origin-bound | Local SW behaviour is covered by other E2E specs; deployed scope is deployment-only |
| 4 | `health, readiness, routes and auth boundaries respond` | public `200`, health/ready `200`, protected redirects | No | `MAACASH_CANONICAL_ORIGIN` | Needs deployed routing/proxy path | Local route/auth tests exist; deployed path is deployment-only |
| 5 | `stays reachable without a blanket redirect and shows the notice` | legacy host notice, no blanket redirect | No | `MAACASH_LEGACY_ORIGIN` | Needs the deployed transition host | Cannot be simulated without asserting a mock |
| 6 | `keeps health and synchronization routes reachable` | legacy health and sync routes not `404` | No | `MAACASH_LEGACY_ORIGIN` | Needs the deployed transition host | Local sync API tests exist; deployed reachability is deployment-only |

## 3. Execution rule

Run only after the owner confirms an authorised deployment or isolated staging
origin that is not production and uses synthetic data:

```
$env:MAACASH_CANONICAL_ORIGIN='<authorised origin>'
$env:MAACASH_LEGACY_ORIGIN='<authorised transition origin>'
npm run test:e2e:deployment
```

Report this suite separately from the local functional E2E suite; do not add
its skips or passes to the local count.

## 4. Status

Local functional E2E: no unexplained skips. Deployment smoke: **not executed**
(`Owner action`/`Unverified`).
