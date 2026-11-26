# Local 1,000-VU load-test results — MaaCash

Run date: 25 November 2026. Git HEAD: `7192f9890df5b1b856b0b0e085c25def9b7e6393`.
Plan: `docs/LOCAL_1000_VU_LOAD_TEST_PLAN.md`. Raw samples:
`tests/local-load-artifacts/`.

## 1. Headline

**Highest sustainable concurrency in this local SQLite environment: 50 VUs.**
At 50 VU all 890 requests returned HTTP 200, p95 was 877 ms and there were no
timeouts, transport errors, auth failures or write failures.

**1,000 VUs were scheduled and VU loops stayed active, but 1,000 VUs were not
sustained successfully.** In the 1,000-VU peak stage only 1,228 of 37,161
requests (3.3%) returned HTTP 200. 33,317 requests failed with `ECONNREFUSED`,
2,608 hit the 9 s client timeout, and 7,862 of 8,219 attempted offline writes
failed. These failures are reported, not suppressed.

These results do **not** certify Render or Neon production capacity. SQLite is
not a PostgreSQL proxy; no Render or Neon target was contacted.

## 2. Environment actually used

| Item | Value |
| --- | --- |
| CPU | 12th Gen Intel(R) Core(TM) i7-12700H, 14 cores / 20 logical processors |
| RAM | 15.69 GiB physical |
| OS | Microsoft Windows 11 Pro `10.0.26300.0` |
| Node / npm | `v22.23.2` / `10.9.8` |
| App | Next.js `16.4.6`, `next start`, port `3101`, build `yYZGQ8dZyvgcZRYmBY0dn` |
| Database | Disposable `tests/local-load.db`, SQLite via `better-sqlite3` |
| Prisma | `7.10.1`, generated client provider `sqlite` |
| Load tool | `scripts/local-load/generator.mjs`, protocol-level HTTP, 8 workers × 125 VUs |
| k6 | Not installed. Documented equivalent used; no dependency added |
| Generator sockets | 64 keep-alive sockets per worker (512 total) |
| Browser VUs | None |

PostgreSQL 16 was available locally but was not used: the hard rule forbids
`prisma generate` with `schema-pg.prisma`, and the SQLite-generated client
rejects the pg adapter. See the plan for the exact error and container cleanup.

## 3. Exact commands

```powershell
npm run build
node scripts/local-load/prepare-db.mjs
node scripts/local-load/start-server.mjs
node scripts/local-load/enroll.mjs
node scripts/local-load/generator.mjs --profile all --workers 8
node scripts/local-load/failure.mjs
node scripts/local-load/stop-server.mjs
```

Two rebuilds were needed. A concurrent workspace process rebuilt `.next` while
this test ran, so one `next start` failed with `Could not find a production
build in the '.next' directory`; after that build completed, the isolated app
started and all profiles ran against the same server process. The SSR dashboard
defect in §7 was fixed by that clean rebuild. No other process was stopped or
modified by this task.

Provider mocks were started separately with
`node scripts/local-load/provider-mocks.mjs` on `127.0.0.1:5599`. The app never
called them; all outbound provider credentials were blank.

## 4. Workload actually issued

Roles: 150 admins, 220 workers, 200 collectors, 380 customers, 50 platform
admins. Read/write mix approximately 85/15. Admin and worker dashboards,
audit, ledger export, risk page, session APIs, offline contribution, offline
withdrawal request and MoMo draft capture were exercised. Customer and platform
SSR dashboards were removed from the VU mix after the initial build defect in
§7; those roles used session APIs and public entry pages instead.

## 5. Profile results

Latency in ms. `status 0` means a transport error (connection refused/reset or
client timeout), not a hidden success. `failedRequests` counts every non-2xx and
every transport error.

### 5.1 Smoke and baseline

| Profile | VUs | Requests | RPS | p50 | p90 | p95 | p99 | max | Status breakdown | Failed | Timeouts | Write failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Smoke | 5 | 61 | 2.03 | 157 | 3,038 | 4,607 | 9,016 | 9,016 | 58×200, 3×0 | 3 | 1 | 0 |
| Baseline | 2 | 50 | 0.83 | 62 | 172 | 612 | 4,388 | 4,388 | 50×200 | 0 | 0 | 0 |

Smoke's three failures were stale keep-alive sockets after server restarts.
Baseline was clean.

### 5.2 Progressive load

| Step | VUs | Requests | RPS | p50 | p90 | p95 | p99 | max | Status breakdown | Failed | Timeouts | Write failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 10 VU | 10 | 205 | 4.56 | 34 | 263 | 368 | 1,035 | 1,330 | 205×200 | 0 | 0 | 0 |
| 50 VU | 50 | 890 | 19.78 | 80 | 670 | 877 | 1,244 | 1,499 | 890×200 | 0 | 0 | 0 |
| 100 VU | 100 | 716 | 15.91 | 3,400 | 9,012 | 9,230 | 9,808 | 10,540 | 625×200, 10×307, 81×0 | 91 | 94 | 0 |
| 250 VU | 250 | 849 | 18.87 | 12,002 | 16,052 | 16,722 | 16,752 | 17,973 | 387×200, 2×307, 460×0 | 462 | 668 | 74 |
| 500 VU | 500 | 2,958 | 65.73 | 677 | 13,847 | 14,949 | 18,084 | 18,126 | 522×200, 1×307, 2,435×0 | 2,436 | 984 | 514 |
| 750 VU | 750 | 9,987 | 221.93 | 3 | 278 | 9,011 | 9,206 | 17,501 | 207×200, 9,780×0 | 9,780 | 691 | 2,060 |
| 1,000 VU | 1,000 | 11,472 | 254.93 | 3 | 8,305 | 9,013 | 9,251 | 16,077 | 690×200, 3×307, 10,779×0 | 10,782 | 1,054 | 2,357 |

The sharp latency jump at 100 VUs and the dominance of `status 0` above 250
VUs are the load finding. At 750 and 1,000 VUs the p50 is near zero because the
majority of samples are failed connection attempts returning almost immediately.

### 5.3 Peak, spike and soak

| Profile / stage | VUs | Requests | RPS | p50 | p90 | p95 | p99 | max | Status breakdown | Failed | Timeouts | Write failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Peak 1,000 VU | 1,000 | 37,161 | 309.68 | 3 | 2,826 | 9,007 | 9,016 | 17,214 | 1,228×200, 8×307, 35,925×0 | 35,933 | 2,635 | 7,862 |
| Spike pre 100 VU | 100 | 472 | 15.73 | 3,572 | 12,026 | 12,305 | 12,751 | 13,246 | 286×200, 4×307, 182×0 | 186 | 180 | 32 |
| Spike to 1,000 VU | 1,000 | 17,295 | 288.25 | 3 | 7,889 | 9,009 | 9,024 | 9,426 | 596×200, 7×307, 16,692×0 | 16,699 | 1,500 | 3,653 |
| Recovery 100 VU | 100 | 1,021 | 17.02 | 2,261 | 6,592 | 7,749 | 8,311 | 9,012 | 994×200, 17×307, 10×0 | 27 | 3 | 2 |
| Soak 100 VU | 100 | 5,183 | 28.79 | 250 | 4,183 | 6,655 | 10,296 | 12,326 | 4,952×200, 67×307, 16×400, 148×0 | 231 | 145 | 31 |

Recovery to 100 VU still showed elevated latency; the service did not return to
baseline within the 60 s recovery window.

`307` responses came from `page.entry` (`/customer/login` or `/platform/login`)
when an assertion was already present for another module. They were counted as
failed iterations. No 401/403 was recorded in any VU stage. No 5xx occurred in
the final profile set; the earlier 5xx run is documented in §7.

## 6. Resource and database observations

CPU% is derived from process CPU-second deltas and wall time; values above 100%
reflect multiple threads in one process. The monitor script had a timestamp-unit
bug in the first run (it reported 0%); the raw samples were recomputed for this
report and the script was corrected.

| Profile | App CPU avg / max | App RSS avg / max | DB file at end | TabProofNonce rows | OfflineTransaction rows | MomoOfflineDraft rows |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Progressive | 56.8% / 111.4% | 374.5 / 655.3 MB | 7.88 MB | 5,848 | 206 | 136 |
| Peak | 64.6% / 127.7% | 570.6 / 785.0 MB | 9.24 MB | 8,893 | 304 | 208 |
| Spike | 57.8% / 115.3% | 592.5 / 657.2 MB | 10.46 MB | 11,851 | 379 | 265 |
| Soak | 53.7% / 97.6% | 688.0 / 726.1 MB | 12.41 MB | 16,583 | 504 | 351 |

Generator saturation: maximum CPU/wall ratio on any one worker was 0.106 in
peak, 0.048 in progressive and 0.05 in soak. **The generator was not the
bottleneck.** Total generator CPU was 102.1 CPU-seconds in the 120 s peak stage.

Database: SQLite has no connection pool, so pool utilisation, query latency and
PostgreSQL lock waits were not observable. `TabProofNonce` grows by one row per
authenticated request; `touchSessionRecord()` and the tab-credential update also
write on every request. With the synchronous better-sqlite3 driver, these writes
block the app event loop. At high VU counts the listener then refuses new
connections, matching the observed `ECONNREFUSED` pattern. This is a verified
observation of the local SQLite build, **not** a claim about Neon.

## 7. Findings and limitations

| Finding | Status | Impact | Next action |
| --- | --- | --- | --- |
| Initial build `7192f989` served 500 for `/customer/dashboard`, `/platform/billing` and other SSR pages with `InvariantError: client reference manifest ... does not exist` at one user | Verified, resolved by clean rebuild | Would block those pages if shipped | Owner: add a post-build protected-route smoke; verify before any release |
| Local SQLite/server refuses connections above roughly 50–100 VUs | Verified locally | 1,000 VU not sustainable here | Owner: repeat on isolated production-equivalent PostgreSQL before any capacity claim |
| App RSS grew to 785 MB during peak and stayed high in soak | Verified, cause not isolated | Possible retention/growth issue | Owner: profile heap and session/proof cleanup on a longer isolated soak |
| Provider timeout path | Unverified | No injectable provider endpoint in app code | Owner: add a test hook or staging-only provider stub if this must be certified |
| Password login, MFA and Turnstile | Not tested in VU loop | Session setup used pre-authenticated synthetic sessions | Owner: add a separate authenticated-login profile |
| Browser-perceived timing | Not tested | Protocol-level only | Owner: run a small optional Playwright journey if needed |

## 8. Explicit non-certification

- No production Neon, Render, custom domain or API was contacted.
- No real customer data, real credential or paid service was used.
- No DDoS, volumetric, destructive or payment test was run.
- No push, merge, deploy or production configuration change was made.
- Local SQLite results do not certify Render/Neon production capacity. An
  isolated production-equivalent PostgreSQL environment with synthetic data and
  owner approval is still required for that claim.
