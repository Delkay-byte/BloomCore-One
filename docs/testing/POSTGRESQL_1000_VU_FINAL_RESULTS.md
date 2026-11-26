# PostgreSQL 1,000-VU capacity — final results

Date: 26 November 2026. Release remains **HELD**. All targets local and synthetic.

## Environment

- PostgreSQL 18.6 (`postgres:18-alpine`, loopback port 55461), matching the
  production engine version. Database `maacash_test*` only; no Neon/Render.
- Real Prisma PostgreSQL adapter, 70 applied migrations, real application
  routes, 10 synthetic tenants, 50 users, 50 customers, 600 contributions and
  1,200 audit rows. 1,000 independent synthetic tab identities (150 admins,
  220 workers, 220 collectors, 380 customers, 50 platform admins) created via
  the real `/api/auth/tab/enroll` route.
- Generator: validated Node protocol-level harness (k6 not available locally).
  Eight forked workers, 64 sockets each, role-weighted journeys with think
  time, ~80/20 read/write. Generator saturation max 0.029 CPU-s/wall-s:
  **generator was not the bottleneck**.
- A verified defect found during the first run: the default pg adapter pool of
  10 connections produced P2028 transaction timeouts. `PG_POOL_MAX` now allows
  a bounded ceiling (default unchanged); this run used 60.

## Progressive results (45 s per stage)

| Stage | VUs | Requests | RPS | p50 ms | p95 ms | p99 ms | Failed | Write failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 208 | 4.62 | 52.24 | 99.68 | — | 0 | 0 |
| 50 | 50 | 939 | 20.87 | 59.23 | 228.92 | — | 0 | 0 |
| 100 | 100 | 1,756 | 39.02 | 88.37 | 673.10 | 1,142.51 | 23 | 0 |
| 250 | 250 | 2,732 | 60.71 | 1,940.70 | 2,825.15 | 3,099.35 | 37 | 1 |
| 500 | 500 | 2,671 | 59.36 | 5,488.83 | 15,017.41 | 15,443.36 | 757 | 146 |
| 750 | 750 | 3,036 | 67.47 | 8,006.24 | 12,035.92 | 13,900.09 | 216 | 8 |
| 1,000 | 1,000 | 3,215 | 71.44 | 13,395.93 | 16,188.75 | 18,085.36 | 2,194 | 251 |

Application CPU avg 81.7% / max 285.3%; RSS avg 437.6 MB / max 877.1 MB.
`TabProofNonce` grew by one row per authenticated request (40,241 rows by the
end).

Peak (1,000 VU, 120 s): 8,052 requests, 67.1 RPS, p95 15,650.94 ms,
6,642 transport failures and 1,269 write failures. App CPU avg 109.2%,
RSS avg 886 MB / max 1,229.4 MB.

Spike/recovery: 100 VU pre-spike had 123 failures; 1,000 VU spike had 3,350
failures of 4,390; recovery at 100 VU had 19 failures of 1,036 and p95 7,020 ms.

## Final optimised run (26 November 2026)

After bounded pool configuration, amortised activity writes and request-scoped
nonce deduplication (see `POSTGRESQL_CAPACITY_OPTIMISATION_REPORT.md`):

| VUs | Requests | RPS | p50 ms | p95 ms | p99 ms | Failed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 209 | 4.64 | 60.00 | 116.77 | 173.93 | 0 |
| 50 | 945 | 21.00 | 59.03 | 134.01 | 172.28 | 0 |
| 100 | 1,823 | 40.51 | 55.03 | 195.04 | 291.61 | 0 |
| 250 | 3,009 | 66.87 | 1,399.69 | 2,585.38 | 3,170.47 | 4 |
| 500 | 3,026 | 67.24 | 5,699.72 | 8,102.53 | 9,728.04 | **0** |
| 750 | 2,855 | 63.44 | 11,553.89 | 14,821.52 | 16,980.37 | 1,017 |
| 1,000 | 3,014 | 66.98 | 13,644.99 | 17,401.34 | 18,091.01 | 2,112 |

Final soak at 50 VU for 10 min: 12,416 requests, 20.69 RPS, p95 915.49 ms;
478 HTTP 400 business-validation failures on duplicate daily contributions,
no transport failures. Generator saturation max 0.033; application CPU avg
84.1% / max 144.1%, RSS avg 529.5 MB / max 972.5 MB.

## Verdict

**1,000 VUs not sustained.** Highest clean concurrency improved from 50 VUs to
**500 VUs** (0 failures). At 1,000 VUs, 2,112 of 3,014 requests failed. The
limiting system is the single local application host under transport timeouts
(status 0) with p50 ~13.6 s; the generator is excluded. No local result
certifies Render/Neon production capacity. Raw samples:
`tests/pg-load-artifacts/profile-*.json`.

No local result certifies Render/Neon production capacity.
