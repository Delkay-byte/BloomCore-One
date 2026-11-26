# PostgreSQL capacity recommendations

The existing local evidence does not support a Render/Neon capacity claim.

Before any production capacity decision:

1. Regenerate the Prisma client for `prisma/schema-pg.prisma` and point an
   isolated app instance at a disposable local PostgreSQL database with
   synthetic role identities.
2. Prefer an official Grafana k6 container if it can be obtained locally;
   otherwise use the validated Node generator in `scripts/local-load/` and
   record the generator limits.
3. Run smoke, 10, 50, 100, 250, 500, 750 and 1,000 VUs, then spike/recovery and
   a soak at the highest sustainable level.
4. Record journey success, error rate, RPS, p50/p90/p95/p99, connection pool,
   lock waits and application/host resources.
5. Do not treat a local result as Render/Neon certification. Decide hosting
   capacity only after the owner reviews the evidence.

No paid capacity change is recommended from the current data.
