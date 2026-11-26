# Reverse engineering and information exposure audit — MaaCash / BIK Prestige Enterprise

**Date:** 2026-11-25. **Method:** read-only source review plus safe HTTP GET/HEAD against `https://maacash.bloomcoretech.com`. **Standard:** BloomCore v1.0 (`BC-SEC-STD-001`), sections 7.1, 8, 13. **Scope:** public HTML/metadata, `robots.txt`, `sitemap.xml`, public artifacts, source maps, client-exposed environment variables, debug endpoints. **No application, config, test or workflow changes were made. No secrets, tokens or customer records are reproduced in this report.**

## Evidence baseline

| Check | Result |
|---|---|
| `GET /` | 200, 143,626 bytes. No `cookie`, `consent`, `analytics`, `gtag`, `googletagmanager`, `plausible`, `posthog`, `hotjar` or `sourceMappingURL` markers. Only marketing metadata and nonce-tagged Next.js chunks. |
| `GET /robots.txt` | 200, `text/plain`, `Cache-Control: public, max-age=14400, must-revalidate`. |
| `GET /sitemap.xml` | 200. Seven `<loc>` entries, all marketing pages (`/`, `/features`, `/pricing`, `/solutions`, `/about`, `/contact`, `/privacy`). No protected route. |
| `HEAD /admin` | 307 to `/admin/login`, `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`. |
| `GET /api/auth/session` | 401 `{"authenticated":false}`. |
| `GET /api/health/ready` | 200 `{"status":"ready"}`, no connection string or stack trace (`src/app/api/health/ready/route.ts:34`). |
| `GET /_next/static/chunks/webpack-68cd47bbe68f9129.js.map` | 404. |
| `public/` inventory | Icons, SVG branding, `manifest.json`, `tab-session-sw.js`. No archive, key, credential or customer artifact. |
| `.next/` source maps | Three maps under `.next/server/` (edge/middleware build artifacts). `.next` is gitignored; no map reference in live HTML. |

## Findings

### RE-01 — Sensitive route prefixes published in robots.txt

- **Severity:** Low.
- **Affected component/config:** `src/app/robots.ts:14-33`; live `GET /robots.txt`.
- **Evidence:** Live body contains `Disallow: /admin`, `/api`, `/collector`, `/customer`, `/platform`, `/settings`, `/susu`, `/worker`, `/change-password`, `/forgot-password`, `/reset-password`, `/select-workspace`. BloomCore v1.0 §7.1 says not to list sensitive endpoint names or hidden admin paths.
- **Realistic abuse scenario:** A crawler or attacker reads `robots.txt` and gains a cheap, curated map of the authenticated surface and modules, reducing discovery effort.
- **Impact:** Information disclosure of route structure only. It is not access control: live `HEAD /admin` redirects to login and API routes enforce their own authorization.
- **Recommended fix:** Keep a single broad `Disallow: /` for application paths or a minimal disallow set; do not enumerate internal modules. Keep marketing pages crawlable through `Allow` entries and the sitemap.
- **Owner action required:** Approve the crawler policy change and confirm SEO requirements for public pages.
- **Regression test / verification:** Re-fetch `/robots.txt` after change and assert no internal module names appear; assert marketing URLs still return 200 and remain in the sitemap.
- **Status:** **verified**.

### RE-02 — No production source maps exposed

- **Severity:** Informational (positive control).
- **Affected component/config:** `next.config.ts` (no `productionBrowserSourceMaps`), `.next/`, live chunk path.
- **Evidence:** `GET /` HTML has zero `sourceMappingURL` matches; probe of a live `.js.map` returned 404; repository-wide map search found only three maps under `.next/server/`, and `.gitignore` excludes `.next`.
- **Realistic abuse scenario:** An attacker requests `.map` files to reconstruct source. No map is served.
- **Impact:** None observed. Minified browser code remains inspectable by design; it contains no authoritative business decision or secret.
- **Recommended fix:** No code change. Keep `productionBrowserSourceMaps` off and keep `.next` out of deployment artifacts that are served as static content.
- **Owner action required:** None. Re-check if a future build tool enables source maps.
- **Regression test / verification:** On each release candidate, fetch one hashed `/_next/static/chunks/*.js` URL plus its `.map` equivalent; assert 404 for the map.
- **Status:** **verified**.

### RE-03 — Client environment exposure limited to intended public values

- **Severity:** Informational.
- **Affected component/config:** `src/lib/site.ts`, `src/components/marketing/PricingEnquiryForm.tsx`, `src/components/security/TurnstileWidget.tsx`, `src/components/EnvironmentBadge.tsx`, `.env.example`.
- **Evidence:** Source references to `NEXT_PUBLIC_*` are limited to `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (site key is public by design). `EnvironmentBadge.tsx:8-30` reads `APP_ENV`, `NODE_ENV` and `DATABASE_URL`, but these are not `NEXT_PUBLIC_*`; Next.js does not inline them into the browser bundle. Live HTML contains no connection string, API key or secret marker.
- **Realistic abuse scenario:** An attacker inspects the browser bundle for provider secrets. Only the canonical URL and Turnstile site key are present.
- **Impact:** None. Turnstile site keys are intentionally public; the secret key stays server-side (`render.yaml` `TURNSTILE_SECRET_KEY`, `sync: false`).
- **Recommended fix:** Do not prefix any secret with `NEXT_PUBLIC_`. Consider replacing the client-side `DATABASE_URL` string check in `EnvironmentBadge.tsx` with a server-provided label so environment detection does not depend on a non-public env var being absent in the browser.
- **Owner action required:** None now; enforce in code review for new env vars.
- **Regression test / verification:** Grep the built client chunks for provider secret prefixes, database URL schemes, the JWT secret variable name and other secret markers; assert zero matches. Never record the matched values.
- **Status:** **verified** in source and live homepage; full automated scan of every shipped chunk was not run in this audit.

### RE-04 — Public metadata and third-party tracking

- **Severity:** Informational (no finding).
- **Affected component/config:** Live `GET /`, `src/app/(marketing)/privacy/page.tsx:25,150,196`, `package.json`.
- **Evidence:** Live homepage has canonical and OG URLs on the canonical domain, theme color and icons; zero analytics/tracking SDK markers. No analytics dependency in `package.json`. Privacy page states no analytics or tracking pixels.
- **Realistic abuse scenario:** Third-party script or pixel exfiltrates visitor data. None is present.
- **Impact:** None.
- **Recommended fix:** Keep the public site free of analytics SDKs unless a documented consent flow is added. Do not add tracking as part of unrelated UI work.
- **Owner action required:** None.
- **Regression test / verification:** After any marketing change, fetch `/` and assert no `googletagmanager`, `gtag`, `plausible`, `posthog` or `hotjar` string.
- **Status:** **verified**.

### RE-05 — Public service worker reveals session architecture

- **Severity:** Informational.
- **Affected component/config:** `public/tab-session-sw.js` (20,862 bytes, publicly served).
- **Evidence:** File header documents per-tab ECDSA P-256 proof, `x-bloomcore-tab-proof`, `x-bloomcore-tab-assertion`, and states IndexedDB holds no JWT or raw key bytes. Matching server verification exists at `src/lib/security/tab-proof.ts:125-145`.
- **Realistic abuse scenario:** An attacker learns the transport contract and attempts to forge a proof. The private key is non-extractable and verification is server-side; knowledge alone is insufficient.
- **Impact:** Architectural detail disclosure, inherent to shipped client code. No secret or customer data exposed.
- **Recommended fix:** No removal needed. Keep the worker comments free of secret values and keep server-side proof verification mandatory.
- **Owner action required:** None.
- **Regression test / verification:** Confirm a request with a forged or missing `x-bloomcore-tab-proof` is denied by protected server actions.
- **Status:** **verified**.

### RE-06 — Stale public allowlist entry `/api/diag`

- **Severity:** Low.
- **Affected component/config:** `src/middleware.ts:77` `PUBLIC_ROUTES` includes `/api/diag`; no `src/app/api/diag/route.ts` exists in the route inventory.
- **Evidence:** Route inventory lists all API routes; `/api/diag` is absent. Middleware bypasses authentication for any path starting with `/api/diag` at line 347.
- **Realistic abuse scenario:** A future diagnostic route added under `/api/diag` would be public by default, with no auth prompt in review.
- **Impact:** No current exposure, but a latent fail-open path for future diagnostics.
- **Recommended fix:** Remove `/api/diag` from `PUBLIC_ROUTES` unless a deliberately public diagnostic endpoint is required; if one is required, put it under `/api/health*` with explicit tests.
- **Owner action required:** Approve removal during the next code change window; no production change made by this audit.
- **Regression test / verification:** `tests/public-routes.test.ts`-style check that only documented public API prefixes bypass auth; assert `/api/diag` returns 404 or 401.
- **Status:** **verified** (code-level latent condition).

## Explicit unknowns

- No authenticated browser session was available, so authenticated HTML, RSC payloads and API responses were not retrieved.
- Only the homepage, login page, `robots.txt`, `sitemap.xml` and three API probes were fetched. A full crawl of every public URL and every hashed chunk was not performed.
- No production repository artifact (deployment bundle) was downloaded or decompiled.

## Conclusion

No critical or high information-exposure finding. Real exposure is limited to intended public metadata, public client code and a low-severity crawler-policy issue plus one stale public allowlist entry. See `DEPLOYMENT_DDOS_WAF_BOT_AND_COOKIE_AUDIT.md` for live header evidence and `GITHUB_AND_SUPPLY_CHAIN_AUDIT.md` for repository exposure controls.
