# API and tenant security audit — MaaCash / BIK Prestige Enterprise

**Date:** 2026-11-25. **Method:** read-only review of API route handlers, server actions, auth/session helpers, rate limiting, webhook verification and error handling. **Standard:** BloomCore v1.0 (`BC-SEC-STD-001`), sections 5, 6 and 10. **No tests that change data were run; no production write requests were sent. No secrets or customer records are reproduced.**

## Verified control baseline

- Role-specific session transport: `src/lib/auth.ts:322-352` issues a token bound to a `jti` and registers a `SessionRecord`; production writes no auth cookie. Header `x-bloomcore-tab-session` is injected by the same-origin service worker (`src/lib/security/tab-session.ts:1-20`, `public/tab-session-sw.js`). Legacy cookie path is double-gated to `NODE_ENV=test` (`tab-session.ts:29-36`).
- Per-tab proof: P-256 ECDSA key pair, non-extractable private key, server verification via `crypto.subtle.verify` (`src/lib/security/tab-proof.ts:117-145`). 120-second route-gating assertion (`src/lib/security/tab-assertion.ts:15,58-82`).
- Passwords: `bcryptjs` with cost 12 (`src/lib/auth.ts:140-148`). Recovery tokens: 32 random bytes, base64url, SHA-256 stored (`src/lib/actions/password-recovery.actions.ts:28-36,127-135`).
- Tenant guards: `getApiTenantContext`, `requireTenantContext`, `assertTenantEntity`, `assertAllTenantEntities` in `src/lib/tenant.ts:255-450`. Tenant-scoped model list at `tenant.ts:401-424`.
- Platform boundary: `/platform/*` checked before tenant rules, requires `kind: "platform"` claims (`src/middleware.ts:245-287`, `113-115`).
- Webhooks: Paystack `Paystack-Signature` HMAC-SHA512 with 300s tolerance and rotation support, `timingSafeEqual` on every candidate (`src/lib/payments/paystack.ts:417-529`); raw body capped at 256 KiB (`src/app/api/payments/paystack/webhook/route.ts:18-20`). SMS and WhatsApp webhooks use constant-time HMAC checks (`src/app/api/webhooks/sms/route.ts:44-45`, `src/lib/messaging/whatsapp.ts:249`).
- Idempotency: offline draft/contribution sync binds an idempotency key to a canonical payload and reserves it before posting money (`src/app/api/offline/sync-contribution/route.ts:145-206,363-393`); platform revocation records event id and revokes sessions in one transaction with P2002 treated as replay (`src/app/api/v1/platform/sessions/revoke/route.ts:79-113`).
- CSRF: state-changing API routes call `isSameOriginRequest` before work (`src/lib/security/same-origin.ts:42-60`; used by `billing/pay`, `submit-otp`, `admin/devices`, all four `offline/*` mutations and `zeli/chat`). Auth routes rely on custom headers that cross-site forms cannot set.

## Findings

### API-01 — Rate-limit IP bucket can be chosen by a client that reaches the origin directly

- **Severity:** Medium.
- **Affected component/config:** `src/lib/security/client-ip.ts:45-75`; `render.yaml` comment on `maacash.onrender.com`; `TRUSTED_PROXY_HEADERS=true` in production blueprint.
- **Evidence:** `getClientIp` returns `cf-connecting-ip` when `TRUSTED_PROXY_HEADERS=true` and deliberately never falls back to `X-Forwarded-For` (`client-ip.ts:56-70`). `render.yaml` states `maacash.onrender.com remains reachable only while devices synchronize offline records` and lists the custom domain as the public origin.
- **Realistic abuse scenario:** If a caller can reach the Render origin without traversing Cloudflare, it supplies its own `CF-Connecting-IP` value and rotates it to obtain fresh rate-limit buckets for login, OTP, password reset or payment OTP flows.
- **Impact:** Per-IP throttles become ineffective for that caller; account takeover and OTP brute-force cost drops. Tenant/user-scoped limits still apply.
- **Recommended fix:** Block direct origin access at Render (IP allowlist / authenticated origin pull / Cloudflare service token), reject requests whose `CF-Connecting-IP` is not accompanied by verified CDN metadata where supported, and alert on origin traffic that lacks the CDN marker. Do not weaken the no-XFF rule.
- **Owner action required:** Confirm in the Render and Cloudflare dashboards whether direct `maacash.onrender.com` access is blocked; provide evidence. This audit could not probe the origin under its allowed scope.
- **Regression test / verification:** In staging, send a request directly to the origin with a forged `CF-Connecting-IP` and assert 403/404 at the edge or origin; send the same request through the CDN and assert the real IP is used.
- **Status:** **likely** (code and config evidence; live origin bypass **unverified**).

### API-02 — Expensive export endpoints have no endpoint-specific rate limit

- **Severity:** Medium.
- **Affected component/config:** `GET /api/zeli/analytics/export`, `GET /api/association/export`, `GET /api/audit`.
- **Evidence:** Rate-limit inventory (`consumeRateLimit` call sites across `src/`) includes billing, offline sync, authentication, recovery, financial reversal and admin actions, but none of these three export routes. `zeli/analytics/export/route.ts:32-48` builds a full tenant snapshot and rule-based insights after authorization; `association/export/route.ts:20` delegates to a tenant-scoped report action.
- **Realistic abuse scenario:** An authenticated tenant admin or a stolen tenant session repeatedly calls the export endpoint with varying date ranges, forcing repeated full-tenant aggregation and CSV generation.
- **Impact:** Database and CPU exhaustion for that tenant and, on shared infrastructure, degraded service for other tenants. No cross-tenant data is exposed.
- **Recommended fix:** Add scoped `consumeRateLimit` checks (for example tenant + route, small window) and bound `from`/`to` range and pagination before the query. Log and alert on repeated 429s for exports.
- **Owner action required:** Approve limit values and range caps based on measured pilot usage; implement in a code-change window.
- **Regression test / verification:** API test that issues N+1 export requests for one tenant and asserts 429 with `Retry-After`, plus a cross-tenant test proving the limit does not leak counts between tenants.
- **Status:** **verified** (absence of rate-limit calls in reviewed routes).

### API-03 — Internal scheduler endpoints rely on static shared secrets with uneven throttling

- **Severity:** Low.
- **Affected component/config:** `POST /api/internal/anomaly/scan`, `POST /api/internal/risk-intelligence/retention`, `POST /api/internal/messaging/dispatch`.
- **Evidence:** `anomaly/scan/route.ts:31-40` checks `ANOMALY_SCAN_TOKEN` with `timingSafeEqual` and caps `limit` at 50 businesses but has no `consumeRateLimit`. `risk-intelligence/retention/route.ts:22-42` checks `RISK_RETENTION_TOKEN` via `runSystemRiskRetentionSweep` then limits to 6 sweeps/hour and serializes with `sweepInProgress`. `messaging/dispatch` uses a constant-time token check.
- **Realistic abuse scenario:** A leaked scheduler token is replayed rapidly against the anomaly scan endpoint; each call performs bounded but real database work across up to 50 tenants.
- **Impact:** Resource exhaustion and duplicate finding/notifications; no tenant authorization boundary is crossed because the token is a system credential.
- **Recommended fix:** Add a scoped rate limit and event-id deduplication to every internal write endpoint, document rotation cadence for the shared tokens, and alert on failures and unusual call volume.
- **Owner action required:** Confirm token rotation cadence and scheduler identity in the deployment environment; do not paste token values into tickets.
- **Regression test / verification:** Replay the same internal event id twice and assert one effect; exceed the limit and assert 429.
- **Status:** **verified** (code-level; token rotation state **unverified**).

### API-04 — Limited error detail returned by two API routes

- **Severity:** Low.
- **Affected component/config:** `src/app/api/zeli/analytics/export/route.ts:142-146`, `src/app/api/zeli/chat/route.ts:70`.
- **Evidence:** Both return `error: error.message`. In the export route the caught value is narrowed to `PeriodValidationError`; other errors become `Export failed`. In chat, the 429 path uses a locally constructed message. `submit-otp/route.ts:108-125` explicitly suppresses unknown provider messages, and `anomaly/scan/route.ts:84-88` reduces exceptions to error class names.
- **Realistic abuse scenario:** A client triggers validation errors and reads messages to learn internal date parsing or rate-limit internals.
- **Impact:** Low-only detail disclosure; no stack trace, SQL, provider body or connection string was found in reviewed responses. Live `GET /api/health/ready` exposes only `{"status":"ready"}`.
- **Recommended fix:** Keep error strings from app-defined error classes; add a regression assertion that provider exception messages never reach a JSON response.
- **Owner action required:** None unless future changes introduce provider errors into these catch blocks.
- **Regression test / verification:** API contract test asserting no response body contains a stack frame, SQL fragment, database URL scheme or provider error body.
- **Status:** likely (low impact; verified that no raw provider error was found in reviewed paths).

### API-05 — Verified tenant isolation on reviewed object routes

- **Severity:** Informational (positive control).
- **Affected component/config:** `GET /api/user/[id]`, `GET /api/evidence/[id]`, `GET /api/zeli/analytics/export`, `GET /api/association/export`.
- **Evidence:** `/api/user/[id]/route.ts:29-43` denies non-admin access to other ids and queries with `tenantId: ctx.tenantId`. `/api/evidence/[id]/route.ts:22-62` validates id format, scopes the attachment by tenant and deleted state, checks dispute ownership for customers, verifies the stored SHA-256 and audits access. Export routes resolve context from session, not from request parameters (`zeli/analytics/export/route.ts:24-47`; `association/export/route.ts:20`). `src/lib/evidence.ts:142-146` resolves stored keys under an evidence root and rejects paths outside it.
- **Realistic abuse scenario:** Tenant A submits tenant B's user id, evidence id or location id.
- **Impact:** Denied by construction in the reviewed paths; cross-tenant reads were not executed in this read-only audit.
- **Recommended fix:** Keep direct-API tenant abuse cases in CI for every new resource family; never add a route that takes `tenantId` from the client.
- **Owner action required:** None.
- **Regression test / verification:** Direct API tests for each role and resource family using synthetic tenants A/B, asserting 403/404 for B's ids. Existing coverage includes `tests/tenant-isolation.test.ts` and `tests/evidence-provenance.test.ts`.
- **Status:** verified by code inspection; runtime abuse tests not re-executed here.

### API-06 — Verified replay and webhook safeguards

- **Severity:** Informational (positive control).
- **Affected component/config:** Paystack webhook, SMS/WhatsApp webhooks, offline sync, platform session revocation.
- **Evidence:** Signature verification uses raw bytes and `timingSafeEqual` with timestamp tolerance and rotation (`paystack.ts:417-529`, `paystack/webhook/route.ts:16-27`). Offline sync reserves an idempotency key before money movement and refuses reuse with a different payload (`sync-contribution/route.ts:145-206,363-393`). Platform revocation commits event id and revocation in one transaction (`sessions/revoke/route.ts:79-113`).
- **Realistic abuse scenario:** Provider retries a webhook twice or a client replays an offline sync after a timeout.
- **Impact:** Duplicate fulfilment is prevented in the reviewed paths.
- **Recommended fix:** Keep event-id uniqueness constraints; add replay tests for every new write path.
- **Owner action required:** None.
- **Regression test / verification:** Duplicate webhook and duplicate idempotency-key tests in the existing suite; re-run in the next authorised release cycle.
- **Status:** verified by code inspection.

### API-07 — Input validation and resource bounds

- **Severity:** Informational (positive control).
- **Affected component/config:** `src/lib/validations.ts` (Zod schemas), API boundary checks.
- **Evidence:** Webhook body capped at 256 KiB; evidence id restricted to `/^[\w-]{8,64}$/` (`evidence/[id]/route.ts:23`); OTP restricted to 4-10 digits after normalization (`submit-otp/route.ts:67-82`); tab public JWK restricted to P-256 EC and 4,096 characters (`auth/tab/enroll/route.ts:72-87`); evidence content type, size and sanitized filename allow-lists (`src/lib/evidence.ts:58-96`).
- **Realistic abuse scenario:** Malformed, oversized or unexpected-type payload sent to a write endpoint.
- **Impact:** Rejected before authoritative work in the reviewed paths.
- **Recommended fix:** Extend the same allow-list pattern to new endpoints; keep body and pagination caps explicit.
- **Owner action required:** None.
- **Regression test / verification:** Boundary tests for oversize, Unicode, empty and wrong-type input per new endpoint.
- **Status:** verified in reviewed code; not an exhaustive review of all 60+ actions.

### API-08 — Test and release evidence is not a clean release gate

- **Severity:** Medium (process risk, not a code vulnerability).
- **Affected component/config:** `.tmp-final-test2.log`, `.tmp-final-test.log`, `.tmp-e2e-clean.log`; BloomCore v1.0 §11.1.
- **Evidence:** `.tmp-final-test2.log` records `Test Files 157 passed (157)` and `Tests 1828 passed (1828)`. `.tmp-e2e-clean.log` records `5 failed` and `111 passed (19.1m)`. An earlier `.tmp-final-test.log` records `5 failed | 1823 passed (1828)`, later fixed in the final log. The standard requires E2E smoke tests to pass before release.
- **Realistic abuse scenario:** A release is approved on the strength of green unit tests while critical role journeys remain broken; regressions in login, collections or reconciliation reach users.
- **Impact:** Reduced confidence in security-critical journeys; no direct exploit path established from the five E2E failures.
- **Recommended fix:** Triage the five E2E failures, fix or formally risk-accept each with owner and expiry, and make E2E smoke a required merge/release gate.
- **Owner action required:** Product owner must sign off on any E2E exception before deployment. No deployment was performed by this audit.
- **Regression test / verification:** Re-run `npm run test:e2e` on the release candidate and attach the exact summary; do not claim a full E2E pass.
- **Status:** verified.

## Explicit unknowns

- Only a subset of server actions (those in the flagged automated scan and high-risk routes) was read in full. A finding of "no issue" is not a proof for every one of the 60+ action modules.
- No authenticated direct-API tenant abuse test was executed, because that would create or modify data.
- Live webhook endpoints were not POSTed to; signature logic was reviewed in source only.
- Production configuration values for `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SIGNING_SECRET`, `ANOMALY_SCAN_TOKEN` and scheduler tokens were not visible: `render.yaml` marks secrets `sync: false`. Their presence and rotation state are **unverified**.

## Conclusion

No critical or high code-level API finding. Two Medium findings need owner attention: potential origin-based rate-limit bucket spoofing (API-01, dependent on unverified origin bypass) and unthrottled expensive exports (API-02). Tenant scoping, webhook HMAC, idempotency and session hygiene are implemented in the reviewed paths.
