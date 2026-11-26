# PostgreSQL integration and regression report

Date: 25 November 2026. Release remains **HELD**. No Neon or production target
was contacted.

## 1. Environment (`Verified live` local only)

| Item | Value |
| --- | --- |
| Engine | PostgreSQL 18.6 (`postgres:18-alpine`, Docker v29.9.2) |
| Production reference | Neon PostgreSQL 18.6 (`docs/NEON-RENDER-DEPLOYMENT.md:22`) |
| Container | disposable `maacash-remediation-pg18`, loopback port 55461 |
| Database | disposable `maacash_test_local` (synthetic data only) |
| Client | Prisma 7.10.1 generated from `prisma/schema-pg.prisma` |
| Safety guard | `scripts/pg-safety.mjs`: `PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`, loopback host, `maacash_test*` name, production/Render/Neon refused |

Connection values are intentionally not recorded.

## 2. Commands and results

```
npx prisma generate --schema=prisma/schema-pg.prisma
npm run test:pg
npx prisma migrate status --config prisma.pg.config.ts
```

- `npm run test:pg` applied the full migration chain (including the new
  `20261226_system_job_lease` migration) to the fresh database:
  **"All migrations have been successfully applied."**
- `prisma migrate status`: **70 migrations found; Database schema is up to date!**
- `npm run test:pg`:
  **10 test files passed, 44 tests passed, 0 failed** (28.53 s).

## 3. Coverage executed

`tests/pg-*.test.ts`: authentication migration, dual control, financial
corrections, operational flows, MFA replay, offline idempotency, step-up,
Susu, withdrawal concurrency, Zeli analytics. These exercise tenant isolation,
transaction rollback, unique constraints, idempotency and concurrent updates
against real PostgreSQL.

The new F5 lease is exercised by the SQLite suite
(`tests/f5-retention-cross-process-lock.test.ts`) including genuinely separate
Node processes. A PostgreSQL-specific multi-instance lease test remains
`Unverified` but the claim is a standard atomic `UPDATE`, portable to both
providers.

## 4. SQLite unit suite context

`npm test`: **159 files passed, 1 failed file, 1,849 tests passed, 2 failed**
on the full run. Both failures were 5-second timeouts in
`tests/commercial-lifecycle.test.ts` ("founding allocation …" and "Zeli monthly
allowance … cannot be exceeded by concurrent requests"). The same file passed
**18/18 in isolation in 3.02 s**, so these are full-suite load timeouts, not
assertion failures or a regression. No timeout, retry or assertion was changed
to obtain a green result.

## 5. Unverified

- Production Neon behaviour, region latency and multi-instance Render
  concurrency were not tested.
- A Neon provider-side restore was not executed; see
  `docs/operations/LOCAL_BACKUP_AND_RESTORE_DRILL.md`.
