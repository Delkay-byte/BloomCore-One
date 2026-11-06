# Zeli — PostgreSQL 18 Migration Rehearsal

**Date:** 4 November 2026.
**Engine:** PostgreSQL 18.6 (`postgres:18-alpine`), isolated Docker container.
**Candidate migration:** `20261105_zeli_renewal_checkout_refund_expiry`.

## Scope

The production Neon database is PostgreSQL 18.6. Every migration in the
repository was rehearsed on PostgreSQL 18.6 before the production release,
using a disposable database that has no connection to production.

## 1. Empty database

```bash
DATABASE_URL=postgresql://.../bloomcore_test \
DIRECT_URL=postgresql://.../bloomcore_test \
  npx prisma migrate deploy --schema=prisma/schema-pg.prisma
```

- 21 migrations applied, no failure.
- `prisma migrate status` reported “Database schema is up to date.”
- `prisma migrate diff --from-url <rehearsal> --to-schema-datamodel prisma/schema-pg.prisma --exit-code`
  returned **No difference detected** (exit 0).

## 2. Upgrade path from the existing schema

The 20 pre-existing migrations were applied to a second empty database
(`bloomcore_upgrade`) to reproduce the schema that production runs today. Then
representative rows were inserted:

| Table | Rows |
|---|---|
| `BusinessTenant` | 1 |
| `ZeliPlan` | 1 |
| `ZeliSubscription` | 1 (`active`, paid period, no new columns) |
| `ZeliEntitlement` | 1 (`active`, `expiresAt` in 20 days) |
| `ZeliPaymentEvent` | 1 (`processed`) |

The new migration was then applied:

| Check | Before | After |
|---|---|---|
| `BusinessTenant` | 1 | 1 |
| `ZeliSubscription` | 1 | 1 |
| `ZeliEntitlement` | 1 | 1 |
| `ZeliPaymentEvent` | 1 | 1 |
| Existing subscription `periodGranted` | n/a | `false` (default) |

- No row was deleted or rewritten.
- `pendingKey` and `refundStatus` were `NULL` for the existing row.
- The new unique indexes were created:
  `ZeliSubscription_pendingKey_key`,
  `ZeliSubscription_refundReference_key`,
  `ZeliSubscription_refundStatus_idx`.
- `ZeliPaymentException` and its unique `dedupeKey` index were created.
- The migration contains only `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX` and
  `CREATE TABLE`; no `DROP`, `DELETE` or `TRUNCATE`.

## 3. PostgreSQL suite on 18.6

```bash
DATABASE_URL=postgresql://.../bloomcore_test \
DIRECT_URL=postgresql://.../bloomcore_test \
PG_DATABASE_URL=postgresql://.../bloomcore_test \
  npx vitest run --config vitest.pg.config.ts
```

Result: **6 files, 32 tests passed**. The first cold run had one transient
10-second `beforeEach` hook timeout in `pg-offline-idempotency`; an immediate
re-run passed 32/32. No timeout was raised and no assertion changed.

PostgreSQL 16.15 was also run for parity: **32/32 passed**.

## 4. Production sequencing

- The migration is additive, so the previous application version keeps working
  while the new version rolls out.
- Apply it with `prisma migrate deploy` against the production direct URL.
- Run it before or immediately at release; the application reads the new
  columns only after the new code is live.
- Do not use `prisma db push`, `migrate reset` or manual `DROP`.

## 5. Recovery

- Application rollback alone does not reverse the migration. The added columns
  and table are nullable/defaulted, so the previous application version remains
  compatible.
- If the migration fails, stop and restore the pre-release Neon branch or
  point-in-time recovery target recorded before deployment.
- Prefer a forward-fix migration over destructive SQL.
- Before production: record the Neon recovery point identifier, the current
  production commit and the last successful Render deployment.

## 6. Cleanup

The rehearsal containers and databases are local and disposable. They are not
connected to production, staging or any Neon project.
