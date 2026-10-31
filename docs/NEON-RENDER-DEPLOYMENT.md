# BIK Prestige Enterprise — Multi-Tenant SaaS on Neon + Render

**Verified on 2026-10-31.** This document describes the multi-tenant SaaS
deployment: one Render web service, one Neon PostgreSQL database, a platform
control plane and tenant-scoped business operations.

| Item | Value |
|---|---|
| GitHub repo | `https://github.com/Delkay-byte/BIK-Prestige-Enterprise` |
| Deployment branch | `main` |
| Render service | `BIK-Prestige-Enterprise` — `srv-dbihvrmgekts73fdcbj0` (Oregon, Free) |
| Live URL | `https://bik-prestige-enterprise-pcxi.onrender.com` |
| Neon project | `BIK Prestige` — database `neondb`, role `neondb_owner` |
| Neon server | PostgreSQL 18.6, AWS `us-east-2` (Ohio) |
| Prisma | 6.19.3 |
| Node | 22.23.2 (`.node-version`) |
| Schema | 22 tables (19 business + 3 platform), 128 indexes, 252 constraints, 19 tenant foreign keys |
| Tenants | exactly one: `BIK-HQ-001` — BIK Prestige Enterprise, ACTIVE, MoMo + Susu enabled |
| Migration history | 11 migrations, all applied, `prisma migrate diff` empty |

---

## 1. Architecture

```
GitHub main
   |
   +--> Render Web Service "BIK-Prestige-Enterprise" (Oregon, Free)
          Next.js 16 full server runtime: pages, server actions, API routes, middleware
          |
          | DATABASE_URL (Neon pooled host)  — application queries
          v
        Neon PostgreSQL 18.6 — database neondb (us-east-2)
          ^
          | DIRECT_URL (Neon direct host) — schema administration only
```

Two authentication boundaries share the service but never each other's cookies:

| Surface | Cookie | Identity table |
|---|---|---|
| `/platform/*` | `bik-platform-session` | `PlatformSuperAdmin` |
| `/admin/*` | `bik-admin-session` | `User` (role `admin`, `tenantId` set) |
| `/worker/*` | `bik-worker-session` | `User` (role `worker`) |
| `/collector/*` | `bik-collector-session` | `User` (role `collector`) |
| `/customer/*` | `bik-customer-session` | `Customer` |

`src/middleware.ts` evaluates the platform boundary first and reads only the
platform cookie there; a platform token must carry `kind: "platform"`. Tenant
routes read only the four tenant cookies. Neither cookie can be replayed as the
other.

---

## 2. Tenant model and isolation

`src/lib/tenant.ts` is the single way to obtain a tenant. The chain is
session cookie → verified JWT (`isSessionCurrent`, token `tokenVersion`) →
`User` row (status, `tenantId`) → `BusinessTenant` row (status, module flags) →
`TenantContext`. A browser-supplied `tenantId` is never an input, so
cross-tenant ID substitution has no entry point.

- **Fail closed:** missing session, unknown user, user without a tenant, missing
  tenant, tenant `status != ACTIVE`, or module not entitled ⇒ `null`, and every
  guard treats `null` as denial. There is no fallback tenant.
- **Entitlement:** `momoEnabled` / `susuEnabled` on the tenant decide which
  modules exist for that business; a user's own flags are intersected with them.
  A tenant administrator gets the union of the tenant's entitled modules.
- **Cross-tenant references:** `assertTenantEntity` / `assertAllTenantEntities`
  verify that every client-supplied id belongs to `ctx.tenantId` before use.
- **Scope coverage:** tenant-scoped tables are `User`, `Location`,
  `DailyAccount`, `Expense`, `Customer`, `SusuAccount`, `SusuCycle`,
  `Contribution`, `ContributionAllocation`, `Withdrawal`, `Commission`,
  `CardFee`, `Collector`, `CollectorCustomerAssignment`, `CollectorRemittance`,
  `PasswordResetToken`, `DeviceEnrollment`, `OfflineTransaction`, `AuditLog`.
- **Where filtering happens:** the UI is a client-rendered Next.js app whose
  data comes from server actions. Every action resolves `TenantContext` first
  and scopes its `where` clauses with `ctx.tenantId`; API routes use
  `getApiTenantContext` and return 401/403 instead of redirecting. Offline
  synchronization (`/api/offline/sync-contribution`) filters by `tenantId` on
  every read and stamps it on every write, including the idempotency lookup.
- **Audit:** tenant actions write `AuditLog` rows carrying `tenantId`
  (`src/lib/audit.ts`); platform actions write `PlatformAuditLog` rows
  (`src/lib/platform-audit.ts`). The two logs are separate tables.
- **Lifecycle:** `Status` is `PROVISIONING` | `ACTIVE` | `SUSPENDED` |
  `ARCHIVED`. Suspension keeps records and blocks access because only `ACTIVE`
  is operable. Tenants are never deleted.

> `tenantId` is nullable by design (safe on a live database). Referential
> integrity comes from the 19 foreign keys; `NOT NULL` tightening is a future
> migration once no code path can insert without a tenant.

---

## 3. Build, start, health

| Setting | Value |
|---|---|
| Build command | `npm ci --include=dev && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build` |
| Start command | `npm start` (`next start`, reads `PORT`) |
| Health check path | `/api/health` |
| Auto-deploy | on `main` |

`--include=dev` is required. The service sets `NODE_ENV=production`, which makes
`npm ci` install production dependencies only (216 packages), but `next build`
type-checks `tests/`, which import `vitest`. Without devDependencies the build
fails with `TS2307: Cannot find module 'vitest'`. With the flag it installs the
full set (564 packages) and the build passes.

The build performs **no** database work: no `prisma db push`, no
`prisma migrate dev`, no `migrate deploy`, no seed, no `scripts/ensure-columns.js`.
`prisma generate` succeeds with no `DATABASE_URL` and no `.env`, so the build
cannot fail on a missing connection string.

`/api/health` is liveness only and never touches the pool, so a database outage
cannot cause a restart loop. `/api/health/ready` runs `SELECT 1` with a 5 s
timeout and returns 503 when Neon is unreachable. Both echo the deployed commit.

---

## 4. Environment variables (names only)

Legend — **Build**: needed to build. **Runtime**: read by the running app.
**Admin**: scripts only.

| Variable | Build | Runtime | Optional | Default | Format / values |
|---|---|---|---|---|---|
| `DATABASE_URL` | no | **yes** | no | — | pooled Neon `postgresql://…-pooler…` |
| `DIRECT_URL` | no | no | yes at runtime; required for schema administration | — | direct Neon host (no `-pooler`) |
| `JWT_SECRET` | **yes** | **yes** | no | — | secret, 32+ chars recommended |
| `NODE_ENV` | no | yes | yes | — | `production` |
| `APP_ENV` | no | yes | yes | derived | `DEVELOPMENT` \| `STAGING` \| `PILOT` \| `TEST` \| `production` |
| `SESSION_IDLE_TIMEOUT_SECONDS` | no | yes | yes | `28800` | positive integer |
| `SESSION_BACKGROUND_TIMEOUT_SECONDS` | no | yes | yes | `7200` | positive integer |
| `SESSION_ABSOLUTE_TIMEOUT_SECONDS` | no | yes | yes | `28800` | positive integer |
| `OFFLINE_COLLECTIONS_ENABLED` | no | no | yes | — | `true`/`false`; declared in `.env.example`, referenced by offline sync |
| `OFFLINE_MOMO_ENABLED` | no | no | yes | — | `true`/`false`; same |
| `NEXTAUTH_URL` | no | no | yes | — | absolute URL; nowhere in code |
| `PLATFORM_SUPER_ADMIN_PASSWORD` | no | no | yes | — | local one-shot for the platform bootstrap only — **never on Render** |
| `TENANT_ADMIN_PASSWORD` | no | no | yes | — | local one-shot for the tenant admin bootstrap only — **never on Render** |
| `PLATFORM_ADMIN_PASSWORD` | no | no | yes | — | legacy script `bootstrap-platform-admin.mjs`; unused by this release |
| `PG_DATABASE_URL`, `SOURCE_DATABASE_URL` | no | no | yes | — | admin scripts in `prisma/` only |
| `PORT` | no | yes | — | `3000` | **provided by Render** |
| `RENDER_GIT_COMMIT` | no | yes | — | — | **provided by Render**, echoed by health |

`JWT_SECRET` is read inside `src/middleware.ts`, which Next compiles into the
Edge bundle — it is **inlined at build time**. Changing it in the dashboard does
nothing until the service is rebuilt, and it signs every session out.

---

## 5. Database provisioning and migration history

The Neon database was originally created by an early `prisma db push`, so it
**had no `_prisma_migrations` table**. Redeploying migrations blindly would have
failed on `20260823_init_postgresql`.

Baseline procedure actually used:

1. A throwaway PostgreSQL **18.6** container was brought to the historical
   end-state with the 9 pre-tenancy migrations.
2. `prisma migrate diff --from-url <Neon> --to-url <rehearsal>` returned exactly
   one statement (`DROP INDEX "OfflineTransaction_idempotencyKey_idx"`), proving
   Neon already contained every historical migration's effects — the missing
   index is declared in the Prisma schema and was created by `db push`.
3. The 9 migrations were recorded with `prisma migrate resolve --applied <name>`.
4. `prisma migrate deploy` applied:
   - `20261029_multitenant_platform_foundation` — 3 platform tables, 19 nullable
     `tenantId` columns, 19 indexes, `Location` per-tenant unique, audit FK.
   - `20261031_tenant_ownership_integrity` — the 19 `tenantId` foreign keys, the
     `OfflineTransaction_idempotencyKey_idx` backfill, and the removal of the
     legacy global `Location_code_key` in both its constraint and index forms.

   The second migration exists because the first (a) never created the foreign
   keys the schema declares and (b) used `DROP CONSTRAINT IF EXISTS`, which is a
   no-op when the object is a unique index — the form `db push` produces. The
   original migration file was left byte-identical to its authored commit.
5. `prisma migrate diff` against `schema-pg.prisma` is now **empty** and
   `prisma migrate status` reports the schema up to date.

Both migration paths were rehearsed on PostgreSQL 18.6 before production:
drifted database → empty residual; empty database → 11 migrations → empty
residual.

Future schema changes: add a migration, apply it with `DIRECT_URL` **before**
pushing the application code to `main` (Render auto-deploys `main`). Never
`migrate reset`, never `--accept-data-loss`, never `db push` in a build.

---

## 6. Tenant bootstrap

```bash
DATABASE_URL="$NEON_DIRECT" node scripts/backfill-bik-tenant.mjs --dry-run
DATABASE_URL="$NEON_DIRECT" node scripts/backfill-bik-tenant.mjs
```

Creates (or reuses) `BIK-HQ-001` — name `BIK Prestige Enterprise`, `ACTIVE`,
onboarding `COMPLETED`, MoMo + Susu enabled — then assigns only rows whose
`tenantId IS NULL`, preserves every identifier and count, and writes platform
audit events. It is additive and idempotent; it never deletes, never creates
financial records, and never overwrites an existing tenant's profile. Each run
appends one `tenant.onboarding_updated` audit row, so use `--dry-run` for later
checks.

Current production state: 1 tenant, 0 business rows, 0 users, 0 platform
super admins, 3 platform audit rows (tenant.created + two backfill runs from
verification).

---

## 7. Administrator provisioning (owner, one time each)

Two identities, two scripts, two login routes. Never substitute one for the other.

```bash
# Platform control plane — /platform/login
DATABASE_URL="$NEON_DIRECT" node scripts/bootstrap-first-platform-super-admin.mjs \
  --email "<owner email>" --name "<owner name>"

# BIK business administration — /admin/login (ordinary tenant User, role admin)
DATABASE_URL="$NEON_DIRECT" node scripts/bootstrap-bik-tenant-admin.mjs \
  --email "<bik admin email>" --name "<bik admin name>"
```

Both scripts:

- read the password from a hidden interactive prompt, or from
  `PLATFORM_SUPER_ADMIN_PASSWORD` / `TENANT_ADMIN_PASSWORD` for that one command;
- hash with **bcrypt cost 12**, matching `hashPassword()` in `src/lib/auth.ts`;
- require ≥ 12 characters plus an uppercase letter and a digit (the application's
  own login policy, so the account is usable);
- normalise the email to lowercase, validate its shape, and refuse duplicates;
- refuse to run when an administrator already exists (`--allow-additional` opts
  in deliberately) and never reset or overwrite an existing password;
- run creation plus audit rows in one transaction and print no credential;
- refuse cleanly, writing nothing, when the database is unreachable.

`scripts/bootstrap-first-admin.mjs` (single-tenant) and
`scripts/bootstrap-platform-admin.mjs` (older platform variant) are **not** used
by this release. `prisma/seed.ts` must never run in production: it inserts demo
locations, staff and sample financial records.

---

## 8. Health checks and smoke tests

```bash
curl -s https://bik-prestige-enterprise-pcxi.onrender.com/api/health
curl -s -o - -w '\n%{http_code}\n' https://bik-prestige-enterprise-pcxi.onrender.com/api/health/ready
curl -s -o /dev/null -w '%{http_code}\n' https://bik-prestige-enterprise-pcxi.onrender.com/platform/login
curl -s -o /dev/null -w '%{http_code}\n' https://bik-prestige-enterprise-pcxi.onrender.com/admin/login
```

`/api/health` must report the deployed commit SHA — use it to prove a deploy,
never assume one. Until the owner runs the bootstrap scripts, both login pages
load but no account can sign in.

---

## 9. Rollback

- **Application:** Render → service → *Rollback* to a previous deploy. The
  schema is additive; the older client ignores the new columns and tables.
- **Schema:** no reverse migration is needed. Remove an object only through a new
  forward migration; never edit or delete an applied migration.
- **Data:** no business data exists yet. Once it does, take
  `pg_dump --format=custom` from the direct host, verify with
  `pg_restore --list`, and restore into a new Neon branch/database — never in
  place.
- Never `prisma migrate reset`, `DROP DATABASE`, `--accept-data-loss`, or
  force-push.

---

## 10. Free-tier and environment limitations

- **Render Free** sleeps after ~15 min idle; cold start ~30–60 s. Move to
  `Starter` before handing the URL to field staff.
- **Neon Free** suspends compute when idle, with limited compute hours, storage
  and point-in-time restore. Keep your own `pg_dump` archives.
- **Region mismatch:** Render Oregon vs Neon `us-east-2` (Ohio). Readiness over a
  cold connection measures ~1 s. Recreate the Render service in Ohio (or move the
  Neon project to `us-west-2`) before go-live.
- **Native module:** `better-sqlite3@13.0.3` ships no prebuilt binary and is
  unused by the app, but `npm ci` still compiles it. It builds on Render's Linux
  image. Local fallback on Windows: `npm ci --include=dev --ignore-scripts`.
- **Advisories (recorded, not fixed):** `npm audit` reports 13 — 1 critical
  (`next` 16.3.2), 9 high (`prisma` 6.19.3, `zod` < 4.6.6), 3 moderate (`vitest`).
  No forced upgrades were applied.

---

## 11. Local verification (integration branch)

| Check | Result |
|---|---|
| `prisma generate` (PostgreSQL client) | PASS |
| `npm run typecheck` | PASS, no errors |
| `npm run lint` | PASS, 0 errors, 89 warnings (main alone: 19 errors, 86 warnings) |
| `npm test` | **196 passed / 196**, 12 files, 0 failures |
| `npm run build` | PASS, `/platform/*` routes present |
| Migration rehearsals (PG 18.6) | drifted + empty paths both end schema-exact |
| Bootstrap scripts (PG 18.6) | create/refuse/idempotency/policy verified; hashes verify with bcrypt cost 12 |
| Production Neon drift | `prisma migrate diff` empty; `migrate status` up to date |
