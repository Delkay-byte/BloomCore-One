> **Dated addendum — 25 November 2026.** Counsel/DPIA/DPO/DPS approval is not a MaaCash requirement, onboarding gate or release gate. Any below reference to it as outstanding is historical and superseded by `docs/privacy/COUNSEL_DPIA_DPO_DPS_REMOVAL_ADDENDUM.md`.

# Owner manual security actions — MaaCash / BIK Prestige Enterprise

**Date:** 2026-11-25. **Audience:** repository/product owner with GitHub admin and Render/Cloudflare/Neon access. **Standard:** BloomCore v1.0 (`BC-SEC-STD-001`). **Read-only audit:** no code, test, workflow, configuration or production setting was changed; nothing was pushed, merged or deployed.

This checklist contains only checks and decisions. Do not paste secret values, tokens, connection strings or customer records into tickets, chat or this file. Record only the result, date, operator and evidence reference.

## Priority 1 — confirm before the next production release

### M-01 — Confirm branch protection on `main`

- **Why:** `gh api repos/Delkay-byte/BloomCore-One/branches` reports `main` as `"protected": false`. Protection/ruleset endpoints returned HTTP 403 because of the GitHub plan, so a ruleset could exist but cannot be verified from this audit. Render uses `autoDeploy: true` on `main`.
- **Action:** Open GitHub → Settings → Rules/Rulesets (and Branches). Confirm `main` cannot be pushed to directly and requires review plus these checks: `sqlite-verify`, `postgres-verify`, `secret-scan`, `codeql`.
- **If missing:** enable a ruleset or classic protection. This is a settings change and must be made by the owner.
- **Evidence to record:** screenshot or exported rule list, date, operator.
- **Verified by:** attempt a direct push with a non-admin identity in a disposable branch/PR; it must be rejected.
- **Related finding:** GH-03. **Status:** unverified.

### M-02 — Confirm Cloudflare WAF, bot and DDoS configuration

- **Why:** Live responses show Cloudflare in front of Render, but no header proves WAF rules, bot controls or a DDoS plan. The standard forbids claiming provider features without evidence.
- **Action:** In Cloudflare, record the zone plan, WAF managed ruleset status, custom rules, bot-fight/bot-management mode, rate-limit rules and exclusion list. Confirm Turnstile is applied to every login, recovery and enquiry submission and that mobile/offline clients have a tested path.
- **Do not** enable blanket challenges that block field devices or integrations without a compatibility check.
- **Evidence to record:** export or screenshots with date and rule IDs.
- **Verified by:** a controlled staging request that is intentionally blocked, plus a legitimate client that succeeds.
- **Related findings:** DEP-01, API-01. **Status:** unverified.

### M-03 — Confirm direct origin access to `maacash.onrender.com`

- **Why:** `render.yaml` says this hostname remains reachable for offline-device migration. If it is still public, Cloudflare rules can be bypassed and `CF-Connecting-IP` becomes attacker-controlled for rate limit buckets.
- **Action:** Confirm whether Render blocks non-CDN traffic or validates a CDN-only secret header. If offline migration is finished, remove public access to the hostname.
- **Boundary:** This audit did not send HTTP requests to that host. Do not run load or DDoS tests against production.
- **Verified by:** authorised request from outside the CDN with a forged `CF-Connecting-IP`; it must not reach application logic.
- **Related findings:** DEP-02, API-01. **Status:** likely / unverified live.

### M-04 — Triage the five E2E failures before release sign-off

- **Why:** Final unit log shows 1828/1828 pass; E2E clean log shows 5 failed, 111 passed. BloomCore §11.1 requires E2E smoke to pass.
- **Action:** Inspect `test-results/` for the five failing journeys, fix them or write a risk acceptance with owner, compensating control and expiry.
- **Do not** describe the release as fully E2E-tested until a clean run exists.
- **Verified by:** attach a fresh `npm run test:e2e` summary from the release candidate.
- **Related findings:** API-08, GH-06. **Status:** verified.

## Priority 2 — schedule within the next maintenance window

### M-05 — Enable GitHub secret scanning and code scanning

- **Why:** API reports secret scanning disabled and code scanning not enabled. CI uploads CodeQL SARIF only as an artifact (`upload: never`). Gitleaks in CI is a compensating control, not a replacement for push protection.
- **Action:** Enable secret scanning and push protection (plan permitting) and enable SARIF upload to code scanning. Keep Gitleaks with its nine narrowly pinned suppressions.
- **Evidence to record:** Security tab status, date, operator. Use a synthetic fake secret for any test.
- **Related findings:** GH-02. **Status:** verified disabled.

### M-06 — Pin CI actions and restrict allowed actions

- **Why:** All `uses:` entries use mutable tags; the Gitleaks image uses `:latest`; `allowed_actions: "all"` and `sha_pinning_required: false`.
- **Action:** Pin `actions/checkout`, `actions/setup-node`, `github/codeql-action/*`, `actions/upload-artifact` to full commit SHAs; pin the Gitleaks image by digest; restrict allowed actions to the needed set. Approve as a normal reviewed CI change.
- **Verified by:** CI check that every `uses:` line is SHA-pinned.
- **Related finding:** GH-01. **Status:** verified.

### M-07 — Confirm database network, identity and backup state

- **Why:** Blueprint has no database network allowlist or private link. Documentation records a historical restore drill, but current live state is unknown and the private compendium lists a web/DB region mismatch and unverified backup state.
- **Action:** Record Neon network policy, app vs migration role privileges, encryption-at-rest confirmation, latest successful restore drill, RTO and RPO. Repeat a restore into a disposable database; never restore over newer financial data.
- **Evidence to record:** provider policy export, drill log, date, operator.
- **Related finding:** DEP-07. **Status:** unverified current state.

### M-08 — Confirm provider signing secrets and scheduler tokens are configured and rotated

- **Why:** Secrets are `sync: false` in `render.yaml`, so this audit could not see them. Paystack, SMS, WhatsApp, OIDC revocation, anomaly scan and retention endpoints depend on them.
- **Action:** Confirm presence (not value) and last rotation date for `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SIGNING_SECRET` (and previous), `TURNSTILE_SECRET_KEY`, `ANOMALY_SCAN_TOKEN`, `RISK_RETENTION_TOKEN`, `WHATSAPP_APP_SECRET` and scheduler bearer tokens. Verify stale credentials are revoked.
- **Do not** print or copy any value into documentation.
- **Related findings:** API-03, DEP-01. **Status:** unverified.

### M-09 — Add rate limits to expensive exports

- **Why:** `/api/zeli/analytics/export`, `/api/association/export` and `/api/audit` have no endpoint-specific rate limit; authenticated heavy use can exhaust shared resources.
- **Action:** Approve tenant-scoped limits and bounded date ranges, then implement as a reviewed code change.
- **Verified by:** API test that returns 429 with `Retry-After` after the agreed threshold and does not share buckets across tenants.
- **Related finding:** API-02. **Status:** verified absence.

## Priority 3 — cleanup and documentation

### M-10 — Remove the stale `/api/diag` public allowlist entry

- **Why:** `src/middleware.ts:77` marks `/api/diag` public but no such route exists. A future diagnostic route there would be public by default.
- **Action:** Approve removal in a normal code change and add a test that only documented public API prefixes bypass auth.
- **Related finding:** RE-06. **Status:** verified latent condition.

### M-11 — Reduce sensitive path enumeration in robots.txt

- **Why:** `robots.txt` lists internal module prefixes. Standard §7.1 says not to list sensitive or hidden paths.
- **Action:** Approve a minimal disallow set that keeps marketing pages indexed and stops enumerating modules.
- **Related finding:** RE-01. **Status:** verified.

### M-12 — Record a live cookie check

- **Why:** Anonymous `GET /` and `/admin/login` returned zero `Set-Cookie` headers. Production uses tab-header sessions; SSO handoff cookies are correct in source but unconfirmed live.
- **Action:** In staging, complete a local login and an SSO login. Capture `Set-Cookie` in browser dev tools and record `Secure`, `HttpOnly`, `SameSite`, `Path`, `Domain`, expiry and rotation. Host-only cookies are preferred.
- **Evidence to record:** redacted header names/attributes only; never paste session values.
- **Related finding:** DEP-04. **Status:** unverified live.

### M-13 — Confirm DPO position on no cookie banner

- **Why:** Public pages have no consent banner and no analytics/tracking SDK. Cookies are limited to necessary auth handoff.
- **Action:** DPO/owner to confirm this position for applicable privacy obligations. Add consent controls before any analytics SDK is introduced.
- **Related finding:** DEP-05. **Status:** verified absence; legal decision pending.

## Risk acceptance record

Any item not completed before release needs a written entry with: finding ID, owner, compensating control, expiry date and reassessment trigger. A green unit suite does not substitute for risk acceptance. No scanner pass or documentation claim is a control by itself.

## Audit boundaries

- No production setting, CI setting, repository setting, database or dependency was modified.
- Only safe GET/HEAD requests to `https://maacash.bloomcoretech.com` were issued. No login, MFA, payment, write, load, stress, fuzz or destructive test was run.
- No secrets, credentials, raw provider errors or customer records were read into these reports.
