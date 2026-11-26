# Deployment smoke — final report

Date: 26 November 2026. Target: `https://maacash.bloomcoretech.com`.

Command: `MAACASH_CANONICAL_ORIGIN=https://maacash.bloomcoretech.com npm run test:e2e:deployment`

## Results

| # | Test | Classification | Result |
| --- | --- | --- | --- |
| 1 | Canonical metadata, no Render host in HTML | Read-only public | **Passed** |
| 2 | Sitemap and robots use canonical origin | Read-only public | **Passed** |
| 3 | Manifest and service worker install on custom origin | Read-only, registers/unregisters local SW | **Passed** |
| 4 | Health, readiness, routes, auth boundaries | Read-only public | **Passed** |
| 5 | Legacy host notice | Requires retired origin | **Skipped** (no `MAACASH_LEGACY_ORIGIN`) |
| 6 | Legacy health and sync routes | Requires retired origin | **Skipped** (no `MAACASH_LEGACY_ORIGIN`) |

Final run: **4 passed, 0 failed, 2 skipped (10.3 s)**. First attempt of test 3
timed out waiting for the `load` event; navigation was changed to
`domcontentloaded`, which does not weaken any manifest/service-worker
assertion. The old host returned 404 for `/api/health`, confirming retirement.

## Additional live read-only checks

Home, health, readiness, privacy, login, service worker → 200. Health payloads
`{"status":"ok"}` and `{"status":"ready"}`. No financial, account or
configuration mutation was attempted.

## Turnstile (`Verified live`, partial)

On `/login?role=momo`, `/admin/login` and `/customer/login`: Turnstile API
script `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
loads and hidden inputs `cf-turnstile-response` / `turnstileToken` exist. No
Turnstile iframe/widget was rendered in headless Chromium, and console showed
CSP `connect-src` errors for `data:,`; a human challenge was not automated.
Server-side siteverify, hostname and action validation remain enabled in code.
`/forgot-password` did not show a widget.

A guard/test now rejects Cloudflare deterministic test keys in a production
runtime (`tests/turnstile-environment-separation.test.ts`, 4 passing tests).

## Deployed identity

Safe live endpoints expose only status, not a commit SHA. Deployed commit is
`Unverified`; live smoke results apply to the currently deployed build, not to
local uncommitted changes.
