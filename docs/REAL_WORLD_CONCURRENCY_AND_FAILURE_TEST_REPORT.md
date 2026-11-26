# Real-world concurrency and failure test report — MaaCash

Run date: 25 November 2026. Environment: local isolated app on
`http://127.0.0.1:3101`, disposable SQLite `tests/local-load.db`, synthetic
tenants only. Raw evidence: `tests/local-load-artifacts/failure-scenarios.json`.

## 1. Scope and method

Eighteen scenarios were run with real application routes and synthetic
identities. Expected outcomes were taken from the existing code rules cited in
the table; no product rule was invented. Verdicts are `as_expected`,
`unexpected` or `unverified`. Final result: **17 as expected, 1 unverified, 0
unexpected**. The initial run produced three unexpected results caused by the
harness itself; those were corrected and the run was repeated. The initial SSR
500 finding was a real build defect and is recorded in §3.

No production host, credential, customer record or payment was involved. No
destructive command was run against production.

## 2. Scenario results

| Scenario | Expected (from existing rules) | Observed | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| Customer/platform SSR dashboards | Authenticated dashboards return 200 with tenant data | Both 200 after clean rebuild; first build `7192f989` returned 500 at one user | as_expected | Route definitions in `src/app/customer/(portal)/dashboard` and `src/app/platform/(console)/billing`; server log from initial build |
| Concurrent same-record updates | Four identical requests with one key post once; same owner/device may continue after unique-key race | `200,200,200,200`; one contribution row | as_expected | `src/app/api/offline/sync-contribution/route.ts` — P2002 race branch, unique ledger reference |
| Duplicate submit | Replayed key posts once and returns stored success | `200,200`; one row | as_expected | Same route — `existing.status === "synced"` replay branch |
| Ambiguous retry (same key, changed payload) | Refuse key reuse with different figures; no rewrite | `409`, one row | as_expected | Same route — payload digest mismatch |
| Duplicate/out-of-order webhooks | Each event id applied once; older status does not regress outbox | `200,200,200`; 1 row per event id; outbox stayed `delivered` | as_expected | `src/lib/messaging/outbox.ts` — `recordCustomerMessageStatus()` uniqueness and rank guard |
| Provider timeout | Provider timeout fails closed, no partial post | App path not exercised; no injectable endpoint; credentials blank | unverified | `src/lib/security/config.ts` and fixed DeepSeek endpoint constants; no test override exists |
| Background retry | Token-gated, bounded sweep; mock provider never sends | `200`, `attempted:0`, `simulated:0`, `pending:0` | as_expected | `src/app/api/internal/messaging/dispatch/route.ts`; `src/lib/messaging/sms.ts` fixed `MockSmsProvider` |
| Expired session | Revoked `SessionRecord` rejected before JWT expiry | `401` | as_expected | `src/lib/security/session-store.ts` `isSessionRecordActive()`; `src/lib/auth.ts` `isSessionCurrent()` |
| Admin revoking access mid-session | `tokenVersion` bump invalidates live session | `401` | as_expected | `src/lib/auth.ts` `isSessionCurrent()` |
| Cross-tenant ID manipulation | Foreign account id cannot be posted under this tenant | `404`, zero foreign rows | as_expected | `src/app/api/offline/sync-contribution/route.ts` tenant-scoped account lookup; `src/lib/tenant.ts` |
| Worker to admin action | MoMo worker cannot read tenant admin audit history | `403` | as_expected | `src/app/api/audit/route.ts` tenant context plus role check |
| Admin to platform action | Tenant admin session cannot open platform console | `307` to `/platform/login` | as_expected | `src/middleware.ts` platform boundary |
| Invalid/oversized fields | Invalid idempotency key refused; oversized webhook body refused before processing | `400` and `413` | as_expected | `src/app/api/offline/momo-draft/route.ts`; `src/app/api/payments/paystack/webhook/route.ts` 256 KiB cap |
| Large pagination | Page size clamped to 100 | `200`, `limit:100` for requested `100000` | as_expected | `src/app/api/audit/route.ts` `Math.min(100, ...)` |
| Concurrent reports | Ten parallel tenant CSV exports succeed, no mutation | Ten `200`, zero 5xx | as_expected | `src/app/api/admin/ledger/export/route.ts` read-only export |
| DB interruption | Locked database fails closed, never claims a stored draft | Transport failure (`status 0`), `ok:false` | as_expected | `src/app/api/offline/momo-draft/route.ts` catch returns `success:false` with 500 |
| Network interruption during write | Client disconnect cannot create more than one post for a key | Zero contribution rows after disconnect at 120 ms | as_expected | Unique `idempotencyKey` and `referenceId` in sync-contribution |
| Restart recovery | Valid server-side session and credential survive app restart | `200` after stop/start | as_expected | `src/lib/security/session-store.ts`, `src/lib/security/tab-proof.ts` |

## 3. Findings

### F-01 — Initial production build served 500 on protected SSR pages

- **Severity:** high if shipped; **status:** verified, resolved by clean rebuild.
- **Evidence:** build `7192f989` returned HTTP 500 and
  `InvariantError: The client reference manifest for route "/customer/dashboard"
  does not exist` at one user. A clean rebuild and restart returned 200 for both
  `/customer/dashboard` and `/platform/billing`.
- **Scenario:** a signed-in customer or platform admin opens a dashboard after a
  build produced while another workspace process was rebuilding `.next`.
- **Impact:** protected dashboards unavailable to those roles.
- **Recommended fix / owner action:** add a post-build smoke that signs in a
  synthetic user and loads one protected page per module; verify a clean build
  before release. No app code was changed by this task.
- **Regression/verification:** rerun the smoke after every clean build; verify
  HTTP 200 and no `InvariantError` in app logs.

### F-02 — Local SQLite app refuses connections above roughly 50–100 VUs

- **Severity:** high for the local configuration; **status:** verified locally.
- **Evidence:** 50 VU stage had zero failures; 100 VU stage had 81 transport
  errors and 94 timeouts; 1,000 VU peak had 33,317 `ECONNREFUSED` and 2,608
  timeouts. Generator saturation stayed below 0.11 core per worker.
- **Scenario:** many authenticated users keep their tab sessions active; every
  request inserts a `TabProofNonce` and touches session/credential rows through
  the synchronous SQLite driver.
- **Impact:** 1,000 VUs are not sustainable in this local SQLite build. This is
  not evidence about Neon/PostgreSQL.
- **Recommended fix / owner action:** repeat with an isolated
  production-equivalent PostgreSQL environment and instrument pool/query
  metrics before making any capacity claim.
- **Regression/verification:** rerun the progressive profile in that environment
  and compare failure rate, p95 and DB pool utilisation.

### F-03 — App memory grew during peak and stayed high in soak

- **Severity:** medium, cause not isolated; **status:** verified observation.
- **Evidence:** RSS 151.8 MB baseline average, 785 MB peak maximum, 688 MB soak
  average with 726 MB maximum. `TabProofNonce` reached 16,583 rows.
- **Impact:** possible retention or cache growth; not proven to be a leak.
- **Recommended fix / owner action:** profile heap and audit proof-nonce/session
  pruning on a longer isolated soak before release.
- **Regression/verification:** repeat a bounded soak and confirm RSS plateaus.

### F-04 — Provider timeout not verified

- **Severity:** unknown; **status:** unverified.
- **Evidence:** no app-level override for provider endpoints exists; credentials
  are blank and local mocks are never called by the app.
- **Impact:** timeout handling under concurrent retries remains untested.
- **Recommended fix / owner action:** add a staging-only injectable provider stub
  or run an approved staging test, then record success/rejection/timeout/
  duplicate/malformed responses.
- **Regression/verification:** assert no partial financial post on provider
  timeout and exactly one post on duplicate callback.

## 4. Harness corrections made during this run

The first execution of `failure.mjs` produced three false `unexpected` results,
all caused by the test harness, not the application:

1. Concurrent same-key requests used four different collector identities, so
   the key-ownership rule correctly returned three `409`s. The scenario now
   uses one identity with four identical requests.
2. Concurrent reports included an admin account whose `tokenVersion` had been
   bumped by the earlier revocation scenario, producing one `401`. The scenario
   now excludes that account.
3. Restart recovery reused keep-alive sockets from the stopped process,
   producing `ECONNREFUSED`. The harness now drops and recreates the agent after
   restart.

The final artifact contains only the corrected results. The earlier raw output
is not overwritten by this section; the run was repeated in full.

## 5. Limits

- No production, staging, Neon or Render target was contacted.
- No live provider call, payment, push, merge, deploy or destructive test.
- Local SQLite behaviour does not certify PostgreSQL pool, MVCC or lock
  behaviour, nor Render cold starts or instance count.
- Password login, MFA and Turnstile were not part of the VU loop.
- Browser-perceived timing and layout stability were not measured.
- A green result here is not proof of security or production readiness. An
  owner must approve the next isolated, production-equivalent test.
