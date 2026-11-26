> **Dated addendum — 25 November 2026.** Counsel/DPIA/DPO/DPS approval is not a MaaCash requirement, onboarding gate or release gate. Any below reference to it as outstanding is historical and superseded by `docs/privacy/COUNSEL_DPIA_DPO_DPS_REMOVAL_ADDENDUM.md`.

# Deployment, DDoS/WAF/bot and cookie audit — MaaCash / BIK Prestige Enterprise

**Date:** 2026-11-25. **Method:** read-only deployment config review plus safe HTTP GET/HEAD against `https://maacash.bloomcoretech.com`. **Standard:** BloomCore v1.0 (`BC-SEC-STD-001`), sections 5.2, 6.2, 7 and 12. **No volumetric, stress, destructive or login tests were run. No provider-account credentials were accessed. No secrets are reproduced.**

## Observed request path

| Signal | Evidence |
|---|---|
| CDN in path | `Server: cloudflare`, `cf-cache-status: MISS/DYNAMIC/HIT`, `CF-RAY`, `Nel`/`Report-To` on live responses. |
| Render origin | `x-render-origin-server: Render`, `rndr-id` on live responses. |
| Blueprint | `render.yaml`: service `maacash`, region `oregon`, plan `free`, `autoDeploy: true`, `SITE_URL`/`NEXT_PUBLIC_SITE_URL`/`NEXTAUTH_URL` = canonical domain, secrets `sync: false`. |
| Legacy origin | `render.yaml` comment: `maacash.onrender.com remains reachable only while devices synchronize offline records that were created on that browser origin.` It is described as a transition address, not a second product identity. |
| Custom domain | `TURNSTILE_ALLOWED_HOSTNAMES=maacash.bloomcoretech.com`; canonical/OG URLs in live HTML use the same domain. |
| Health | `GET /api/health` 200, `Cache-Control: no-store`; `GET /api/health/ready` 200 `{"status":"ready"}`. |

## Layer separation (required by standard)

| Layer | What was verified | What remains unverified |
|---|---|---|
| Network/volumetric DDoS | Cloudflare is the visible edge for the canonical domain. | Actual DDoS plan, scope, limits, provider evidence and date checked. Do **not** claim volumetric protection is enabled. |
| Edge WAF / managed rules | No evidence available from response headers. | Managed rulesets, custom WAF rules, rule actions, exclusions and change history. |
| Bot control | Turnstile is configured in blueprint (`TURNSTILE_ENABLED=true`, site key public, secret `sync: false`) and the CSP allows `challenges.cloudflare.com`. Live login page markup contains Turnstile references (6 matches). | Whether Turnstile actually verifies on every login/recovery submit in production, challenge mode, bot-fight settings and exception paths for mobile/offline clients. |
| Application abuse | Persistent DB-backed fixed-window rate limiting (`src/lib/security/rate-limit.ts`), keyed HMAC identifiers, fail-closed on store error; same-origin guard on mutations; Turnstile verification in auth/recovery/enquiry flows; export gap recorded as API-02. | Effective limits under real traffic; per-tenant resource ceilings. |
| Origin protection | Custom domain terminates at Cloudflare before Render (headers above). | Whether direct `maacash.onrender.com` requests are blocked or can bypass Cloudflare. This audit did not probe that host. |
| Resilience / monitoring | `/api/health` and `/api/health/ready`; security event logging (`logSecurityEvent`); maintenance guard in middleware; rate-limit block/error logs. | Alert routing, dashboards, on-call rotation, RTO/RPO and backup restore drill state. |

## Findings

### DEP-01 — Provider DDoS/WAF/bot features are unevidenced

- **Severity:** Medium (evidence gap, not a confirmed weakness).
- **Affected component/config:** Cloudflare zone for `maacash.bloomcoretech.com`; `render.yaml` edge-related env vars.
- **Evidence:** Live headers prove a Cloudflare edge is in front of Render, but contain no field asserting WAF, bot management or DDoS plan state. `render.yaml` sets `TURNSTILE_ENABLED=true` and `TURNSTILE_ALLOWED_HOSTNAMES`, which is application-level bot control only.
- **Realistic abuse scenario:** Operators believe "Cloudflare" means WAF and bot rules are active; a credential-stuffing or scraping campaign reaches the origin with no rule intervention.
- **Impact:** False assurance; application-layer abuse relies solely on in-app limits.
- **Recommended fix:** Record provider evidence (plan, enabled WAF ruleset, bot settings, rate-limit rules, date checked) in an owner-controlled document. Enable WAF managed rules and selective bot challenges only after compatibility testing with mobile/offline clients.
- **Owner action required:** Export or screenshot the Cloudflare security settings and attach to this audit; do not accept a verbal "it is on".
- **Regression test / verification:** With written scope, run a controlled staging check of one blocked path and one allowed integration path; record rule IDs and outcomes.
- **Status:** **unverified**.

### DEP-02 — Direct origin bypass possibility

- **Severity:** Medium.
- **Affected component/config:** `render.yaml` legacy-origin comment; `maacash.onrender.com`; `src/lib/security/client-ip.ts:56-70`.
- **Evidence:** Blueprint explicitly says the Render hostname remains reachable for offline-device migration. Production sets `TRUSTED_PROXY_HEADERS=true`, so a request reaching Render directly can supply its own `cf-connecting-ip`; the code intentionally has no `X-Forwarded-For` fallback.
- **Realistic abuse scenario:** An attacker discovers the legacy hostname, sends requests directly, controls the IP bucket used by rate limiting and bypasses any Cloudflare-side rules.
- **Impact:** Edge WAF/bot/rate rules can be bypassed; per-IP application limits can be rotated (see API-01).
- **Recommended fix:** Block public access to the Render hostname once offline migration is complete, or require a CDN-only secret header validated at the origin. Document the cutover date and keep `maacash.onrender.com` out of public links.
- **Owner action required:** Confirm in Render/Cloudflare whether direct origin access is currently blocked and whether any devices still require the legacy origin. HTTP probing of that host was outside this audit's allowed scope.
- **Regression test / verification:** Authorised check from outside the CDN: direct request to the origin must fail; a request with a forged `CF-Connecting-IP` must not reach application logic.
- **Status:** **likely** (config evidence); live reachability **unverified**.

### DEP-03 — Live security headers are correctly applied

- **Severity:** Informational (positive control).
- **Affected component/config:** `next.config.ts` `securityHeaders`; `src/middleware.ts:224-233` nonce-based CSP.
- **Evidence:** Live `GET /` and `HEAD /robots.txt` include `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` with camera/microphone/geolocation/payment/usb disabled, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-Permitted-Cross-Domain-Policies: none`, and a per-request CSP nonce with `strict-dynamic`. No `x-powered-by` header (`poweredByHeader: false`). `HEAD /admin` returns 307 to `/admin/login` with no-store cache headers.
- **Realistic abuse scenario:** Clickjacking, MIME sniffing, mixed content or script injection through an untrusted source.
- **Impact:** Header layer provides defence in depth; CSP `style-src 'unsafe-inline'` remains a known relaxation noted for future review.
- **Recommended fix:** Keep header configuration; do not relax CSP to solve unrelated issues without a documented threat review.
- **Owner action required:** None.
- **Regression test / verification:** Release smoke check asserting the eight security headers and a fresh nonce per response.
- **Status:** verified live.

### DEP-04 — No session `Set-Cookie` observed on anonymous pages

- **Severity:** Informational, with an explicit verification gap.
- **Affected component/config:** `src/lib/auth.ts:318-352`, `src/lib/platform-auth.ts:182-198`, `src/lib/security/tab-session.ts:1-36`, `src/app/platform/login/sso/callback/route.ts:209-234`.
- **Evidence:** `GET /` and `GET /admin/login` were inspected: **0** `Set-Cookie` headers. Production architecture deliberately avoids browser-wide auth cookies; the session handle travels in a service-worker-injected custom header. Legacy cookie settings (`httpOnly: true`, `secure: true`, `sameSite: lax/strict`, `path: "/"` , absolute max age) exist only in test-gated code. SSO handoff cookies are `HttpOnly`, `secure` when `NODE_ENV=production`, `SameSite=Lax`, scoped to `/platform/login/sso`, 60-second max age, and consumed once.
- **Realistic abuse scenario:** Cookie theft or CSRF through an ambient session cookie. In this design there is no ambient cookie to steal; cross-site forms cannot set the custom headers.
- **Impact:** No live cookie attribute can be confirmed from anonymous requests. Cookie controls for SSO handoff are verified in source only.
- **Recommended fix:** Keep the header transport and same-origin checks. Do not reintroduce ambient auth cookies without re-review of CSRF and multi-tab isolation.
- **Owner action required:** In staging, complete one real SSO login and one local login, capture `Set-Cookie` headers in browser dev tools, and record `Secure`, `HttpOnly`, `SameSite`, `Path`, `Domain`, expiry and rotation. No live login was attempted in this audit.
- **Regression test / verification:** Automated response-header test in a disposable environment for each cookie-setting flow; assert no `Domain` attribute (host-only preferred) and 60s handoff lifetime.
- **Status:** verified for source and anonymous live responses; **unverified** for authenticated/SSO live `Set-Cookie`.

### DEP-05 — No cookie consent or analytics observed on public pages

- **Severity:** Informational.
- **Affected component/config:** Live `GET /`; `src/app/(marketing)/privacy/page.tsx:25,150,196`; `package.json`.
- **Evidence:** Live homepage has zero matches for `cookie`, `consent`, `analytics`, `gtag` or tracking provider names. No analytics SDK dependency exists. The privacy page states no analytics or tracking pixels. Any cookies are strictly necessary for the auth handoff/session design described above.
- **Realistic abuse scenario:** Non-essential tracking without consent. None found.
- **Impact:** Legal adequacy of "no banner because no non-essential cookies" is a DPO decision, not a technical finding.
- **Recommended fix:** If a future analytics or tracking SDK is added, add consent controls before deployment.
- **Owner action required:** DPO/owner to confirm the no-banner position for Ghana/GDPR-style obligations.
- **Regression test / verification:** Add a public-page test asserting no tracking SDK marker and no non-essential cookie is set.
- **Status:** verified.

### DEP-06 — Crawler directives are used only as preferences

- **Severity:** Informational.
- **Affected component/config:** `src/app/robots.ts`; live `/robots.txt` and `/sitemap.xml`.
- **Evidence:** `robots.txt` disallows application prefixes; live `HEAD /admin` still requires auth; sitemap contains only seven marketing URLs. Robots directives cannot protect private data.
- **Realistic abuse scenario:** A non-compliant crawler or attacker ignores robots.txt. Server-side guards still deny access.
- **Impact:** None; note the low-severity route enumeration finding RE-01.
- **Recommended fix:** Keep private content behind authentication; refine disallow entries per RE-01.
- **Owner action required:** None beyond RE-01.
- **Regression test / verification:** Request a disallowed URL without a session and assert 401/403/redirect, not data.
- **Status:** verified.

### DEP-07 — Database exposure, encryption and backup recovery state

- **Severity:** Medium (evidence gap).
- **Affected component/config:** `render.yaml` (`DATABASE_URL`, `DIRECT_URL` `sync: false`), Neon PostgreSQL, local SQLite test databases, `docs/deployment/PRODUCTION-RELEASE-RUNBOOK.md`.
- **Evidence:** Blueprint contains no database network allowlist or private-link setting. Documentation records a verified `pg_dump`/`pg_restore` drill before a 2026-11-16 schema change (runbook line 50). Earlier in this session a pre-migration Neon snapshot was created and confirmed, and `prisma migrate status` reported "Database schema is up to date!" with existing records preserved. No restore drill was performed after that snapshot. `docs/private/MAACASH_PRODUCT_AND_OPERATIONS_COMPENDIUM.md` records an Oregon web / `us-east-2` DB region mismatch as a readiness risk.
- **Realistic abuse scenario:** Credential compromise allows database access from outside the application; or a migration incident needs a restore that has not been re-verified against current data.
- **Impact:** Unknown blast radius for DB credential theft; recovery confidence depends on an older drill, not current state.
- **Recommended fix:** Enforce database IP allowlist/private networking, separate least-privilege identities for app and migrations, confirm encryption at rest with the provider, and repeat a restore drill into an isolated database on a defined cadence. Never restore over newer financial data.
- **Owner action required:** Provide current Neon network policy, role privileges and a recent restore-drill record; set RTO/RPO with the product owner.
- **Regression test / verification:** Restore the latest backup into a disposable database and compare table counts and a synthetic fingerprint; record date, operator and result.
- **Status:** **unverified** for current live state; historical drill **verified in documentation**.

## Explicit unknowns

- Cloudflare account/WAF/bot/DDoS configuration was not available.
- No HTTP request was sent to `maacash.onrender.com`; direct-origin reachability is **unverified** by design of this audit scope.
- No authenticated session, login, MFA challenge or SSO flow was executed, so live authenticated cookies and Turnstile enforcement remain **unverified**.
- No load, spike, stress or volumetric test was run. Performance claims must come from the separate authorised report, not this audit.

## Conclusion

Headers, crawler behaviour and origin/custom-domain routing look consistent with the blueprint. The two actionable risks are unevidenced edge WAF/bot/DDoS configuration (DEP-01) and possible direct-origin bypass with rate-limit bucket spoofing (DEP-02, also API-01). Cookie attributes are sound in source but cannot be confirmed live without an authenticated check.
