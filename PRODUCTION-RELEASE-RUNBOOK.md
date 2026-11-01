# PRODUCTION RELEASE RUNBOOK — Multi-Tenant SaaS Activation

**Release:** multi-tenant platform foundation + Phase 2 UI → Render production
**Executed:** 2026-10-31 · **Status:** DATABASE MIGRATED — MAIN PROMOTION PENDING
**Production branch:** `main` · **Previous `main`:** `b88a10a`
**Neon:** project `BIK Prestige`, database `neondb`, PostgreSQL 18.6, region `us-east-2`
**Render:** `bloomcore-one` (`srv-dbihvrmgekts73fdcbj0`), Oregon, tracks `main`

This runbook is now the record of an executed release, not a plan. The two-stage
Phase 1 / Phase 2 split below is superseded: the whole foundation and the UI
transformation ship together because the database was migrated and verified
first. Keep the verification and rollback sections as the standing procedure.

> All commands run from `Momo module/`. Connection strings come from the Render
> service's environment variables (`DIRECT_URL` for schema administration) and
> are never committed, printed or pasted into chat.

## What actually happened (order matters)

| Step | Action | Result |
|---|---|---|
| 1 | Integration branch `promotion/multitenant-saas` from `origin/main` (`b88a10a`), `git merge --no-ff master` (`0b372a3`) | merge commit `c075aad`, **no conflicts** |
| 2 | Neon migration-history inspection | `_prisma_migrations` **absent** — database built by `db push` |
| 3 | Baseline: 9 historical migrations marked applied | proven additive-superset, see below |
| 4 | `prisma migrate deploy` → `20261029_multitenant_platform_foundation` | applied |
| 5 | `prisma migrate deploy` → `20261031_tenant_ownership_integrity` | applied |
| 6 | `prisma migrate diff` Neon → schema | **empty** (no drift) |
| 7 | `node scripts/backfill-bik-tenant.mjs --dry-run` then apply | tenant `BIK-HQ-001` created, ACTIVE, MoMo + Susu enabled |
| 8 | Local verification: generate, typecheck, lint, 196 tests, build | all pass |
| 9 | Push integration branch → `main` (fast-forward) | Render deploys |
| 10 | Owner runs the two bootstrap scripts | Platform Super Admin + BIK tenant admin |

## Stage 0 — Pre-release state (verified)

- `origin/main` = `b88a10a`, `origin/master` = `a30d2aa`, local `master` = `0b372a3` (8 commits ahead, preserved as backup).
- Neon: 19 tables, 94 indexes, 202 constraints, **0 rows in every table**.
- No `_prisma_migrations` table → the schema had been created by the old build's
  `prisma db push`, so migration history had to be baselined before any
  `migrate deploy`.

## Stage 1 — Migration baseline (the part that must never be skipped)

`prisma migrate deploy` on a database with no `_prisma_migrations` table would
try to re-run `20260823_init_postgresql` and fail. Marking migrations applied
without proof would be falsifying history. The proof used:

1. A throwaway **PostgreSQL 18.6** container (`bik-pg18-rehearsal`) was brought
   to the exact historical end-state with the 9 pre-tenancy migrations.
2. `prisma migrate diff --from-url <Neon> --to-url <rehearsal>` produced a single
   statement: `DROP INDEX "OfflineTransaction_idempotencyKey_idx"`. That index is
   declared in `schema-pg.prisma` (`@@index([idempotencyKey])`) and was created by
   `db push`, so **Neon was a strict superset of the historical end-state** —
   every historical migration's effects were proven present.
3. Each of the 9 migrations was then recorded with
   `prisma migrate resolve --applied <name>`.

Never baseline a migration whose objects are not proven present. If the diff
above had shown missing tables, columns or constraints, the correct action is to
stop and report, not to resolve.

## Stage 2 — Tenant migration (applied)

`20261029_multitenant_platform_foundation` is additive: 3 tables
(`BusinessTenant`, `PlatformSuperAdmin`, `PlatformAuditLog`), 19 nullable
`tenantId` columns, 19 tenant indexes, the `Location` unique swap, and one audit
foreign key. 19 statements are `ADD COLUMN IF NOT EXISTS`; there is no
`DROP TABLE`, `TRUNCATE` or `DELETE`.

Two defects in that migration were found during review and are closed by
`20261031_tenant_ownership_integrity` (kept as a separate migration so the
original file stays byte-identical to the authored commit):

1. It never created the 19 `tenantId` foreign keys that the Prisma schema
   declares, so the migrated database did not match `schema-pg.prisma`.
2. It removed the global `Location.code` unique with
   `ALTER TABLE … DROP CONSTRAINT IF EXISTS`, which is a **no-op** when that
   object is a unique *index* — which is what `prisma db push` creates. The
   corrective migration drops the constraint *and* the index, creates the
   missing `OfflineTransaction_idempotencyKey_idx` only when absent, and adds the
   19 foreign keys inside `DO $$ … EXCEPTION WHEN duplicate_object` blocks.

Both migration paths were rehearsed before touching production:

- drifted database (10 migrations applied, index still present) → residual diff empty
- empty database → all 11 migrations → residual diff empty

Post-migration production state: **22 tables, 128 indexes, 252 constraints,
19 `tenantId` foreign keys, `prisma migrate diff` empty, `migrate status` "up to
date"**.

## Stage 3 — BIK tenant

```bash
DATABASE_URL="$NEON_DIRECT" node scripts/backfill-bik-tenant.mjs --dry-run
DATABASE_URL="$NEON_DIRECT" node scripts/backfill-bik-tenant.mjs
```

Result: exactly one tenant — `BIK-HQ-001`, name `BIK Prestige Enterprise`,
`status = ACTIVE`, `onboardingStatus = COMPLETED`, `momoEnabled = true`,
`susuEnabled = true`, `primaryAdminUserId = null` (set later by the tenant admin
bootstrap). Re-running the script neither duplicates the tenant nor creates rows;
it appends one `tenant.onboarding_updated` audit event per run, so run it once in
production and use `--dry-run` for later checks.

## Stage 4 — Administrator provisioning (owner-run, one time)

Two separate identities, two separate scripts, two separate login routes. Do not
substitute one for the other.

```bash
# Platform control plane (/platform/login) — NOT a tenant user
DATABASE_URL="$NEON_DIRECT" node scripts/bootstrap-first-platform-super-admin.mjs \
  --email "<owner email>" --name "<owner name>"

# BIK business administration (/admin/login) — ordinary tenant User, role admin
DATABASE_URL="$NEON_DIRECT" node scripts/bootstrap-bik-tenant-admin.mjs \
  --email "<bik admin email>" --name "<bik admin name>"
```

Both prompts hide the password. Non-interactive alternative: export
`PLATFORM_SUPER_ADMIN_PASSWORD` / `TENANT_ADMIN_PASSWORD` in the local shell for
that one command and unset it afterwards. Neither variable belongs on Render.
`PLATFORM_ADMIN_PASSWORD` and `scripts/bootstrap-platform-admin.mjs` are the
older variants and remain unused by this release.

## Stage 5 — Promotion

```bash
git push origin promotion/multitenant-saas:main   # fast-forward only, never --force
```

Then confirm the deployed SHA, not the deploy event:

```bash
curl -s https://bik-prestige-enterprise-pcxi.onrender.com/api/health
# commit must equal the promoted main SHA
curl -s -o /dev/null -w '%{http_code}\n' https://bik-prestige-enterprise-pcxi.onrender.com/api/health/ready
```

## Stage 6 — Backfill verification SQL

```sql
-- Per-model counts + null check (all must show null_tenant = 0)
SELECT 'User' t, COUNT(*) total, COUNT(*) FILTER (WHERE "tenantId" IS NULL) null_tenant FROM "User"
UNION ALL SELECT 'Location', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "Location"
UNION ALL SELECT 'DailyAccount', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "DailyAccount"
UNION ALL SELECT 'Expense', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "Expense"
UNION ALL SELECT 'Customer', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "Customer"
UNION ALL SELECT 'SusuAccount', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "SusuAccount"
UNION ALL SELECT 'SusuCycle', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "SusuCycle"
UNION ALL SELECT 'Contribution', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "Contribution"
UNION ALL SELECT 'ContributionAllocation', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "ContributionAllocation"
UNION ALL SELECT 'Withdrawal', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "Withdrawal"
UNION ALL SELECT 'Commission', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "Commission"
UNION ALL SELECT 'CardFee', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "CardFee"
UNION ALL SELECT 'Collector', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "Collector"
UNION ALL SELECT 'CollectorCustomerAssignment', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "CollectorCustomerAssignment"
UNION ALL SELECT 'CollectorRemittance', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "CollectorRemittance"
UNION ALL SELECT 'PasswordResetToken', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "PasswordResetToken"
UNION ALL SELECT 'DeviceEnrollment', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "DeviceEnrollment"
UNION ALL SELECT 'OfflineTransaction', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "OfflineTransaction"
UNION ALL SELECT 'AuditLog', COUNT(*), COUNT(*) FILTER (WHERE "tenantId" IS NULL) FROM "AuditLog";

-- unexpected tenant IDs (must return exactly one row: BIK-HQ-001)
SELECT t.code, COUNT(*) FROM "User" u JOIN "BusinessTenant" t ON t.id = u."tenantId" GROUP BY t.code;

-- orphaned ownership (both must be 0)
SELECT COUNT(*) FROM "User" WHERE "tenantId" IS NOT NULL
  AND "tenantId" NOT IN (SELECT id FROM "BusinessTenant");
```

## Post-deploy verification checklist

**Platform control plane** — `/platform/login` loads → the bootstrap operator can
sign in → dashboard counts load → tenant directory lists `BIK-HQ-001` as ACTIVE
with MoMo + Susu → the tenant detail page shows its administrators → a platform
action writes a `PlatformAuditLog` row → a tenant cookie alone cannot open
`/platform/*` (redirects to `/platform/login`).

**BIK tenant** — `/admin/login` loads → the tenant admin signs in → dashboard,
locations, staff, Money & History, Susu customers/collectors/contributions/
withdrawals/remittances/history load → MoMo and Susu are reachable because both
are entitled → `/platform/dashboard` is unreachable with the tenant cookie.

**Isolation** — use the isolated test database, never production: create tenants
A and B, then confirm A cannot read or modify B's customers, contributions,
withdrawals and daily accounts, that search and CSV export stay tenant-scoped,
that offline sync rejects a foreign `accountId`, and that a suspended tenant
(`status != ACTIVE`) is denied by `getTenantContext`. Production itself must hold
exactly one tenant.

## Rollback procedure

1. **App only:** Render → *Rollback* to the previous deploy. The schema stays; the
   old client is column-explicit and ignores the new columns/tables.
2. **Schema:** the tenant migration is additive, so no reverse migration is
   needed. If an object must be removed, write a new forward migration — never
   delete a migration file that has been applied.
3. **Data:** there is no business data yet. Once records exist, take
   `pg_dump --format=custom` from the direct host, verify with `pg_restore --list`,
   and restore into a **new** Neon branch/database — never in place.
4. Never run `prisma migrate reset`, `DROP DATABASE`, `--accept-data-loss`, or
   force-push.

## Known transitional notes

- `tenantId` is intentionally **nullable** so the migration is safe on a live
  database. Orphaned rows are prevented by the 19 foreign keys but *not* by
  `NOT NULL`. Tightening to `NOT NULL` is a future migration, after the backfill
  is confirmed and no code path inserts without a tenant.
- Retention is `ON DELETE SET NULL` (Prisma's default for an optional relation).
  Deleting a `BusinessTenant` row would therefore orphan its records rather than
  delete them. Tenants must be suspended/archived, never deleted.
- `Location.code` is now unique per tenant. PostgreSQL treats NULL tenants as
  distinct, so two unassigned locations could share a code; no such rows exist.
- `scripts/ensure-columns.js` is a legacy additive drift patcher and is **not**
  part of the build or the release path.
