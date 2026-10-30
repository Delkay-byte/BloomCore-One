# PRODUCTION RELEASE RUNBOOK — Platform Foundation Activation

**Release:** multi-tenant foundation → Render production (`bik-prestige`)
**Prepared:** 2026-10-30 · **Status:** PREFLIGHT PENDING OPERATOR EXECUTION
**Local HEAD:** `41db51d` (master) · **origin/master & origin/main & production:** `a30d2aa`
**Unpushed:** 7 commits — Phase 1 boundary is `0a765aa`; Phase 2 = `e092681`…`379a465` + docs `41db51d`

## Two-stage release plan (mandatory order)

- **Stage 1 — Phase 1 only:** `git push origin master:<SHA 0a765aa>` — i.e. push
  `0a765aa` as the new `master`/`main` head (fast-forward from `a30d2aa`, no
  force). Render deploys the foundation WITHOUT the UI commits. Verify live
  (platform + BIK + isolation per below).
- **Stage 2 — Phase 2:** only after Stage 1 passes live verification, push
  `41db51d` (fast-forward; ships the 4 UI commits + the docs commits).

> **Rule:** do not push until every stage below has passed. All commands run from
> `Momo module/` with `DATABASE_URL` pointing at the **production** PostgreSQL
> database, supplied by the operator (never committed, never pasted into chat).
> Sanity-check before every stage: `echo ${DATABASE_URL:0:19}…` must read
> `postgresql://…` — never `file:…`.

## REHEARSAL EVIDENCE (PostgreSQL, 2026-10-30)

The complete Stage A–F procedure was executed end-to-end against a throwaway
PostgreSQL 16 container (`bik-release-rehearsal-pg`, port 55444, database
`bik_pilot`) seeded with synthetic pre-tenancy rows covering all 19 models:

- Backup `pg_dump --format=custom` + `pg_restore --list` verification: PASS
- `prisma db push --schema=prisma/schema-pg.prisma`: PASS (additive; platform
  tables + 20 `tenantId` columns confirmed via information_schema)
- Dry-run: read-only, correctly reported 21 unassigned rows / 19 tables
- Bootstrap: created `PlatformSuperAdmin` (separate table; BIK admin untouched)
- Backfill: all 21 rows assigned to `BIK-HQ-001`; counts preserved
- 19-model verification: every row BIK-owned, zero nulls, zero foreign tenants
- Idempotency re-run: PASS; legacy password hash untouched; `primaryAdminUserId`
  set to the existing legacy admin
- **Not production evidence.** Production stages remain operator-run.

---

## Stage A — Production backup (BLOCKING)

From the Render dashboard (Postgres instance → Backups) or locally:

```bash
# Render CLI / dashboard equivalent:
pg_dump "$DATABASE_URL" --no-owner --format=custom \
  -f "backups/prod-pre-tenancy-$(date +%Y%m%d-%H%M).dump"
# Verify it is restorable:
pg_restore --list "backups/prod-pre-tenancy-*.dump" > /dev/null && echo "BACKUP VERIFIED"
```

Record: database identity, dump filename, timestamp, size. **Do not continue if
this cannot be verified.**

Pre-count reference snapshot (also serves Stage F):

```bash
node scripts/inventory-database.ts   # or: the count SQL in Appendix 1
```

## Stage B — Additive schema (old application stays live)

Run **locally** against production (the Render shell checks out the OLD commit
`a30d2aa`, whose schema files predate tenancy — do not run db push from there):

```bash
DATABASE_URL="$PROD_DATABASE_URL" npx prisma db push --schema=prisma/schema-pg.prisma --skip-generate
DATABASE_URL="$PROD_DATABASE_URL" node scripts/ensure-columns.js
```

Verified additive: 3 `CREATE TABLE IF NOT EXISTS` (BusinessTenant,
PlatformSuperAdmin, PlatformAuditLog), 19 nullable `tenantId` columns + indexes,
Location unique swap. No DROP/TRUNCATE/DELETE. The deployed old Prisma client
is column-explicit and unaffected. If anything fails here: STOP — the old app
keeps working (nullable columns are invisible to it).

## Stage C — Backfill dry-run (read-only)

```bash
DATABASE_URL="$PROD_DATABASE_URL" node scripts/backfill-bik-tenant.mjs --dry-run
```

Accept only if: provider prints `PostgreSQL`; every table's "without tenant"
count matches Stage A expectations; zero unexpected/ambiguous ownership is
reported. Investigate any surprise before proceeding.

## Stage D — Platform Super Admin bootstrap

```bash
DATABASE_URL="$PROD_DATABASE_URL" node scripts/bootstrap-platform-admin.mjs \
  --email "<bloomcore operator email>" --name "<operator name>"
```

Either supply `PLATFORM_ADMIN_PASSWORD` (≥12 chars, not displayed) or capture
the printed ONE-TIME password from the script output (shown once). This creates
a `PlatformSuperAdmin` — it never touches the BIK tenant administrator.

## Stage E — Actual backfill

```bash
DATABASE_URL="$PROD_DATABASE_URL" node scripts/backfill-bik-tenant.mjs
```

Idempotent; assigns only rows with `tenantId IS NULL`; keeps all IDs, amounts,
timestamps and relationships. Re-runs are safe.

## Stage F — Backfill verification

Re-run the script once more (must print "none — every row already has a
tenant" and preserve counts), then:

```sql
-- Appendix 1: per-model counts + null check (all must show null_tenant = 0)
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
```

## Stage G — Deploy

```bash
git push origin master        # ships all 6 commits: foundation + UI Phase 2
```

Watch the Render build (`prisma generate` → `db push` → `ensure-columns` →
build), then confirm the live SHA:

```bash
curl -s https://bik-prestige-enterprise.onrender.com/api/health
# "commit" must equal 379a4651bc58538d82269d882039af6f1d49ebf5
```

## Post-deploy verification checklist

Platform: `/platform/login` loads → operator signs in (change generated
password) → dashboard shows BIK-HQ-001 active, both modules → audit trail has
`platform.bootstrap` + backfill events → enrollment page loads.
BIK admin: sign in normally (NO password reset) → dashboard, locations,
workers, staff, reports, Money & History, Susu customers/collectors/
contributions/withdrawals/remittances/history all load with existing data.
MoMo worker + Susu collector + customer portal: sign in, confirm routes and
workflows unchanged.

## Live isolation test (Stage 9)

Create a clearly-marked verification tenant via `/platform/tenants/new`
(name it e.g. "ZZ-VERIFY-DELETEME (Isolation Test)", MoMo+all or the module
being tested, synthetic admin `verify-…@example.com`). Enroll a synthetic
customer, then from the verification tenant's session attempt BIK's real
customer/contribution/withdrawal/daily-account IDs — every attempt must be
rejected ("not found"). Confirm BIK cannot see the test tenant's records.
Then **suspend** the test tenant (records preserved, access blocked) — do not
delete. Document it as a test record in the platform audit trail.

## Rollback procedure

1. **App only:** Render → rollback to the previous deploy (`a30d2aa`). The
   additive DB structures stay; the old app ignores the new columns/tables and
   tenant assignments. No data rollback is needed or wanted.
2. **Data:** only if actual corruption is proven — `pg_restore` the Stage A
   dump into a NEW database first, verify, then repoint. Never restore in place
   over the live DB.
3. Never run `prisma migrate reset`, `DROP DATABASE`, or reverse migrations.

## Known transitional note

While both old and new app versions run, the Location unique constraint is
per-tenant (`tenantId, code`). PostgreSQL treats NULLs as distinct, so two
NULL-tenant rows could share a code between Stage B and Stage E. The window is
minutes and the old single-business app is the only writer — acceptable; the
backfill then re-establishes the invariant. Ensure Stage E follows Stage B
promptly.
