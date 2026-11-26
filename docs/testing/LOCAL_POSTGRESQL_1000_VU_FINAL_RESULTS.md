# Local PostgreSQL 1,000-VU final results

Date: 25 November 2026. Release HELD.

No PostgreSQL-based VU run was completed in this pass. A disposable PostgreSQL
18.6 container was used for the 44-test integration suite and a backup/restore
drill, but not for generated load. Reporting SQLite figures as PostgreSQL
capacity would be false.

Measured local capacity remains: 50 VUs sustainable on disposable SQLite
(890 requests, 19.78 RPS, p95 877 ms, 0 failures); 1,000 VUs not sustained
(33,317 connection refusals, 2,608 timeouts). Source:
`docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md`.

Status: **Unverified** on PostgreSQL. 1,000 VUs: **not sustained**.
No production capacity claim is made.
