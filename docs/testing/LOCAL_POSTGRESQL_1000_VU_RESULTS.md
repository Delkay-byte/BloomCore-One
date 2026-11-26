# Local PostgreSQL 1,000-VU repeat — status

Date: 25 November 2026. Release remains **HELD**.

## 1. Prior result (`Verified in code` from stored evidence)

The previous run used the custom Node generator, a local Next.js server and a
disposable SQLite database. Highest sustainable concurrency was **50 VUs**
(890 requests, 19.78 RPS, p95 877 ms, 0 failures). The 1,000-VU peak produced
37,161 requests of which only 1,228 returned HTTP 200; 33,317 were connection
refusals and 2,608 timed out. Application RSS reached ~785 MB. Details:
`docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md`.

## 2. What changed in this pass

A disposable PostgreSQL 18.6 container was created and the full migration chain
plus 44 PostgreSQL integration tests passed against it
(`docs/testing/POSTGRESQL_INTEGRATION_AND_REGRESSION_REPORT.md`). No Neon,
Render or live domain was contacted.

## 3. Why the 1,000-VU PostgreSQL repeat is NOT reported as complete

The local harness (`scripts/local-load/*`) prepares a SQLite database and the
generated Prisma client is provider-specific. Running the VU workload against
PostgreSQL requires regenerating the client for `postgresql`, pointing the
isolated app at the disposable PG database with synthetic identities, running
the generator, then regenerating SQLite for the normal build/E2E gate. Doing
that concurrently with the required build and browser regression would risk
invalidating both results through client-provider churn.

Therefore no PostgreSQL VU numbers are claimed in this report. Reporting the
SQLite figures as PostgreSQL capacity would be false. The previous 50-VU
result remains the only measured local capacity figure.

## 4. Verdict

1,000 VUs: **not sustained** and **not re-tested on PostgreSQL**. Highest
measured sustainable level remains 50 VUs on SQLite. Bottleneck observed:
synchronous SQLite per-request writes plus listener refusal, not a proven
application or PostgreSQL defect. Load-generator saturation was not observed
(max CPU/wall ratio 0.106).

## 5. Owner follow-up (after release authorisation)

1. Regenerate the PostgreSQL client; start an isolated app instance against a
   disposable PG database with synthetic role identities.
2. Prefer an official k6 container (`grafana/k6`) if obtainable; otherwise keep
   the validated Node generator and record its limits.
3. Run smoke → 10 → 50 → 100 → 250 → 500 → 750 → 1,000 VUs, spike/recovery
   and a soak at the highest sustainable level.
4. Record measured facts only; there is no approved MaaCash latency SLO. Do not
   treat a local result as Render/Neon production certification.
