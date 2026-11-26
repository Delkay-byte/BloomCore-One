# Local PostgreSQL backup and restore drill

Date: 25 November 2026. Release remains **HELD**. No Neon or production target
was used. All records were synthetic.

## 1. Environment (`Verified live` local only)

- Source: disposable Docker container `maacash-remediation-pg18`, PostgreSQL
  18.6, database `maacash_test_local` (matches production engine version).
- Restore target: separate empty database `maacash_restore_final` in the same
  disposable container. The source snapshot/database was not modified.
- Migration state before drill: 70 migrations applied, "Database schema is up to date!".

## 2. Steps and evidence

1. Applied all Prisma migrations to a fresh database (see
   `docs/testing/POSTGRESQL_INTEGRATION_AND_REGRESSION_REPORT.md`).
2. Inserted synthetic rows only: 2 `BusinessTenant` rows and 3 `AuditLog` rows.
3. `docker exec maacash-remediation-pg18 pg_dump -Fc -U maacash_test -d maacash_test_local > <temp>/maacash-synthetic-final.dump`
   (binary-safe redirection via `cmd /c`). Dump written to the OS temp folder,
   never into the repository.
4. Created empty `maacash_restore_final` and ran
   `pg_restore -U maacash_test -d maacash_restore_final --no-owner --no-privileges /tmp/maacash-synthetic-final.dump`.
   No restore errors were reported.

## 3. Aggregate verification (counts only, no row values)

| Check | Source | Restored |
| --- | ---: | ---: |
| Public tables | 138 | 138 |
| Primary-key constraints | 138 | 138 |
| Foreign-key constraints | 176 | 176 |
| Indexes | 553 | 553 |
| `BusinessTenant` rows | 2 | 2 |
| `AuditLog` rows | 3 | 3 |
| `SystemJobLease` rows | 0 | 0 |
| Orphan audit rows (non-null tenant id with no tenant) | 0 | 0 |

Foreign keys, primary keys and index counts match; no orphan audit rows were
introduced. Restore completed without errors.

## 4. Application-level check

The restored database was not connected to the public application. A local
read-only connection was used for aggregate checks only. No production data
was exported, and no third-party service received restored data.

## 5. Distinction from provider restore

This drill proves a local `pg_dump`/`pg_restore` round trip on synthetic data.
It does **not** prove a Neon point-in-time restore or branch restore. That
provider-side verification remains an owner action; no paid Neon branch was
created and no production snapshot was altered.

## 6. Cleanup

Temporary dumps were kept outside the repository in the OS temp folder and can
be deleted by the operator. The disposable container and restored database were
not used for any production purpose.
