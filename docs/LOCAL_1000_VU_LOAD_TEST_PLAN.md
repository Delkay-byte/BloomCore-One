# Local 1,000-VU load-test plan — MaaCash

Status: **local, isolated, synthetic-only test plan**. Created 25 November 2026.
This plan is evidence of what will be run, not proof of production capacity.
Results are in `docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md`.

## 1. Safety boundary

| Control | Value / rule |
| --- | --- |
| Application target | `http://127.0.0.1:3101` only |
| Preflight | `assertLocalTarget()` aborts unless host is `localhost`/`127.0.0.1`/`::1` and port is `3101` |
| Database | `tests/local-load.db`, absolute `file:` URL, basename allow-listed as `local-load.db` |
| Database preflight | `assertLocalDatabaseUrl()` aborts unless URL is `file:` and resolves to the disposable load DB |
| E2E isolation | Port `3100`, `tests/e2e.db` and `tests/test.db` are never read, deleted or written |
| Provider egress | All outbound provider credentials blanked; no live Resend, Paystack, Turnstile, DeepSeek, WhatsApp or SMS call |
| Local mocks | `scripts/local-load/provider-mocks.mjs` binds `127.0.0.1:5599`; app is not pointed at it |
| Inbound-only values | Synthetic `SMS_STATUS_WEBHOOK_SECRET` and `MESSAGING_DISPATCH_TOKEN` enable local webhook/retry routes; neither is an outbound credential |
| Prohibited | No production host, no real credential, no push/merge/deploy, no payment, no DDoS/volumetric/destructive test, no paid service |
| Dependencies | Node built-ins (`http`, `crypto`, `perf_hooks`), installed `@prisma/client`, `better-sqlite3`, `jose`, `bcryptjs`. No new dependency |
| Tool substitute | k6 is not installed. `scripts/local-load/generator.mjs` is the documented equivalent: protocol-level HTTP, staged VUs, think times, real signed tab proofs |

`assertNoProviderCredentials()` re-checks the assembled server environment and
refuses to start if an outbound provider credential survived. Secret values are
never printed.

## 2. Hardware, software and environment

| Item | Verified value |
| --- | --- |
| CPU | 12th Gen Intel(R) Core(TM) i7-12700H, 14 cores / 20 logical processors |
| RAM | 15.69 GiB physical |
| OS | Microsoft Windows 11 Pro, build `10.0.26300.0` |
| Node | `v22.23.2` |
| npm | `10.9.8` |
| Next.js | `16.4.6` (`next start --webpack` build output) |
| Prisma / client | `7.10.1`, generated client provider `sqlite` |
| DB driver | `better-sqlite3` `13.0.3` via `@prisma/adapter-better-sqlite3` |
| Browser | Not used for throughput; optional browser check not run |
| Git HEAD | `7192f9890df5b1b856b0b0e085c25def9b7e6393` |

### Database decision (important limitation)

A local PostgreSQL 16 image (`postgres:16`) is present and Docker daemon is
available (`ServerVersion 29.9.2`). A disposable container was provisioned on
`127.0.0.1:55444` for evaluation. The task's hard rule forbids running
`prisma generate` with `schema-pg.prisma`; the existing generated client is
bound to provider `sqlite` and rejects `@prisma/adapter-pg` with
`PrismaClientInitializationError: Driver Adapter ... based on postgres is not
compatible with the provider sqlite`. Therefore the test uses the disposable
SQLite database. The container was removed after the probe.

Behavioural difference: SQLite uses a single writer and file-level locking, not
PostgreSQL pool limits, MVCC or Neon network latency. Connection-pool pressure
and PostgreSQL lock contention are **not** measured. Any sustainable-concurrency
number from this run applies only to this local SQLite process on this machine.

## 3. Architecture

```text
                         ┌──────────────────────────────────────┐
 generator.mjs (host)    │ 8 worker processes, 125 VUs each      │
                         │ staged ramp, think time, seeded RNG   │
                         │ ECDSA P-256 proof per HTTP request     │
                         └───────────────┬──────────────────────┘
                                         │ HTTP/1.1 keep-alive
                                         │ 127.0.0.1:3101
                         ┌───────────────▼──────────────────────┐
                         │ Next.js 16 app (next start)           │
                         │ middleware → tab assertion            │
                         │ route/page → verifyTabProof()         │
                         │ → isSessionCurrent() → tenant resolver│
                         └───────────────┬──────────────────────┘
                                         │ Prisma better-sqlite3
                         ┌───────────────▼──────────────────────┐
                         │ tests/local-load.db (disposable)      │
                         │ 10 tenants, 50 users, 50 customers,   │
                         │ 100 branches, 1,000 sessions/credentials│
                         └──────────────────────────────────────┘
 monitor.mjs ── samples app CPU/RSS, DB row counts and file size
 provider-mocks.mjs ── 127.0.0.1:5599, tooling only, never called by app
```

## 4. Synthetic dataset

`scripts/local-load/prepare-db.mjs` resets only `tests/local-load.db` and
`scripts/local-load/enroll.mjs` creates 1,000 valid VU identities.

| Entity | Count |
| --- | ---: |
| Business tenants | 10 |
| Branches / locations | 20 |
| Staff users (admin/worker/collector) | 50 (10/20/20) |
| Portal customers | 50 |
| Susu accounts and active cycles | 50 each |
| Contributions / withdrawals | 600 / 100 |
| Daily accounts / MoMo transactions | 400 / 60 |
| Audit log rows | 1,200 |
| Platform super admins | 1 |
| VU sessions + tab credentials | 1,000 each |
| Enrolled offline devices | 400 (worker + collector VUs) |

All names, emails, phone numbers and account references begin with `LL-` or use
`@local-load.test`. No real customer data is present.

## 5. Session and identity model (assumptions)

- Each VU is a valid synthetic identity with a server-side `SessionRecord` and
  an ECDSA P-256 `TabCredential`, enrolled through the real
  `POST /api/auth/tab/enroll` route.
- The pre-authenticated JWT is minted locally with the synthetic local-only
  secret. Password entry and Turnstile are therefore **not** part of the VU
  loop. This is a stated assumption, not a hidden bypass: data routes still
  verify the signed proof, live session record, MFA policy, tokenVersion and
  tenant scope on the server.
- The generator reproduces the browser service worker: a fresh nonce per
  request, canonical `v1` proof, 120-second assertion refreshed in-process,
  `x-bloomcore-tab-*` headers, and `origin`/`referer` set to the local app.
- One browser tab per VU. Multi-tab behaviour is out of scope.
- The generator sends `Origin: http://localhost:3101` while connecting to
  `127.0.0.1:3101`. This was verified as the origin that `next start` reports
  in `request.url`; it is still loopback only and satisfies the app's real
  same-origin guard for offline writes.
- Each generator worker caps keep-alive sockets at 64 (8 workers, up to 512
  concurrent sockets). Extra VUs wait for a socket, as browsers do; a socket
  wait is included in latency. This avoids an artificial 1,000-socket burst
  against a single Node listener.
- 1,000 VUs means 1,000 concurrent simulated **users/sessions**, each issuing
  one request at a time with think time. It does not mean 1,000 simultaneous
  requests at one instant or 1,000 simultaneous writes.
- 15% tenant admins, 22% workers, 20% collectors, 38% customers, 5% platform
  admins. These proportions are assumptions; no production telemetry exists.
- Think time: 0.8–3.0 s for reads, 2.5–5.0 s for writes. Varied pagination,
  filter and account selections use a seeded RNG for reproducibility.
- Rate-limit assumption: offline sync is 120/min per user in
  `src/lib/security/config.ts`; per-VU write frequency stays below it. Any 429
  is still counted and reported.

## 6. Workload by role

| Role | Share | Representative steps |
| --- | ---: | --- |
| Tenant admin | 15% | `/api/auth/me?module=admin`, `/api/auth/session`, tab assertion refresh, `/admin/dashboard`, `/api/audit` (paged), `/admin/history`, `/admin/ledger`, `/api/admin/ledger/export`, `/admin/risk-intelligence` |
| MoMo worker | 22% | `/api/auth/me?module=momo`, session status, assertion refresh, `/worker/dashboard`, `/worker/shifts`, `/worker/transfers`, `/worker/settings`, `POST /api/offline/momo-draft` (capture only, posts nothing) |
| Susu collector | 20% | `/api/auth/me?module=susu`, session status, assertion refresh, `/collector/dashboard`, `POST /api/offline/sync-contribution` (idempotent real write), `POST /api/offline/sync-request` (queued withdrawal request, posts nothing), `/collector/settings` |
| Customer | 38% | `/api/auth/me?module=customer`, session status, assertion refresh, `/customer/login` entry page, health. Authenticated customer SSR dashboards are excluded because a verified build defect returns HTTP 500 at one user (see failure report) |
| Platform admin | 5% | assertion refresh, `/platform/login` entry page, health. Platform SSR dashboards are excluded for the same verified build defect |

Read/write mix is approximately 85/15. All paths are real application routes;
no synthetic or stub endpoint is added to the app. Tracking pixels, analytics
beacons and third-party requests are excluded.

## 7. Profiles

| Profile | Command | Shape | Duration |
| --- | --- | --- | ---: |
| Smoke | `node scripts/local-load/generator.mjs --profile smoke --workers 1` | 5 VUs, 2 s ramp | 30 s |
| Baseline | `node scripts/local-load/generator.mjs --profile baseline --workers 1` | 2 VUs, warm single-user reference | 60 s |
| Progressive | `node scripts/local-load/generator.mjs --profile progressive --workers 8` | 10 → 50 → 100 → 250 → 500 → 750 → 1,000 VUs, 5 s ramp per step | 7 × 45 s |
| Peak | `node scripts/local-load/generator.mjs --profile peak --workers 8` | 1,000 VUs held, 10 s ramp | 120 s |
| Spike/recovery | `node scripts/local-load/generator.mjs --profile spike --workers 8` | 100 → 1,000 in 8 s, hold 60 s, drop to 100 for 60 s | 150 s |
| Soak (bounded) | `node scripts/local-load/generator.mjs --profile soak --workers 8` | 100 VUs steady | 180 s |
| All | `node scripts/local-load/generator.mjs --profile all --workers 8` | runs the above in order | ~16 min |

Soak is deliberately bounded to 3 minutes and runs only after the peak and
spike profiles complete without a hard stop. It is **not** a 4-hour production
soak.

## 8. Stop conditions

Stop a profile, record the stop and do not continue that profile if:

- any cross-tenant write or balance invariant break is observed;
- 5xx exceeds 5% of measured requests for 30 s;
- the app process restarts or becomes unreachable;
- provider credentials are detected in the server environment;
- the generator cannot maintain the scheduled VU count because it is saturated
  (>85% of one core on a worker) — report saturation instead of hiding it.

## 9. Exact setup commands

From `C:\Users\SAVIOUR\Documents\DScience\BIK Prestige Ent\BloomCore-One`:

```powershell
npm run build
node scripts/local-load/prepare-db.mjs
node scripts/local-load/start-server.mjs
node scripts/local-load/enroll.mjs
node scripts/local-load/provider-mocks.mjs   # separate shell, optional tooling only
node scripts/local-load/generator.mjs --profile all --workers 8
node scripts/local-load/failure.mjs
node scripts/local-load/stop-server.mjs
```

## 10. Measurements recorded

Per stage: throughput, RPS, p50/p90/p95/p99/max latency, status counts,
transport errors, timeouts, 401/403 counts, failed-request count and rate,
write count and write-failure count, and per-step latency/status breakdown.
Application: CPU% (average/max), RSS MB (average/max), sample count, DB file
size and row counts for sessions, proof nonces, rate counters and offline rows.
Generator: per-worker CPU seconds, wall seconds, RSS, CPU/wall saturation and
whether any worker saturated. Database: SQLite has no pool; pool utilisation,
query latency and MVCC lock waits are **unavailable** and recorded as such.

## 11. Explicit non-claims

- These results do **not** certify Render or Neon production capacity.
- Local SQLite is not a PostgreSQL proxy; Neon pooler limits, network latency
  and MVCC contention are untested.
- The free Render plan's cold start, single instance and restart behaviour are
  untested.
- Password login, Turnstile, MFA, Resend, Paystack checkout, DeepSeek and
  WhatsApp are excluded from the VU workload; provider timeout is recorded as
  unverified because no injectable endpoint exists without changing app code.
- No browser-based VU journey was run; protocol-level simulation is the
  throughput source.
