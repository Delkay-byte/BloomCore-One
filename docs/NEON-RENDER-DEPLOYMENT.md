# BIK Prestige Enterprise — Neon + Render Deployment (main)

**Verified on 2026-10-31.** The new environment is live and verified; the first
administrator account has not been created yet (no user exists in the database).

| Item | Value |
|---|---|
| GitHub repo | `https://github.com/Delkay-byte/BIK-Prestige-Enterprise` |
| Deployment branch | `main` |
| Deployed commit | `44d3a99a0fa5c4fd521d2eb116984aa27a8f6b62` |
| Render service | `BIK-Prestige-Enterprise` — `srv-dbihvrmgekts73fdcbj0` (Oregon, Free) |
| Live URL | `https://bik-prestige-enterprise-pcxi.onrender.com` |
| Neon project | `BIK Prestige` — database `neondb`, role `neondb_owner` |
| Neon server | PostgreSQL 18.6, AWS **us-east-2** (Ohio) |
| Prisma | 6.19.3 (unchanged) |
| Node | 22.23.2 (`.node-version`) |
| Schema | 19 tables, 94 indexes, 202 constraints, **0 rows in every table** |

---

## 1. Architecture

```
GitHub main (44d3a99)
   |
   +--> Render Web Service "BIK-Prestige-Enterprise" (Oregon, Free)
          Next.js 16 full server runtime: pages, server actions, 9 API routes, middleware
          |
          | DATABASE_URL  (Neon pooled host)
          v
        Neon PostgreSQL 18.6 — project "BIK Prestige", database neondb (us-east-2)
          ^
          | DIRECT_URL (Neon direct host) — schema administration only
```

One full-stack service. There is no separate API service and none is needed.

> The previous Render service and its PostgreSQL are no longer part of this
> setup and were not modified by this work.

---

## 2. Build, start, health

| Setting | Value |
|---|---|
| Build command | `npm ci && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build` |
| Start command | `npm start` (`next start`, reads `PORT`) |
| Health check path | `/api/health` |
| Auto-deploy | on `main` |

The build performs **no** database work: no `prisma db push`, no
`prisma migrate dev`, no seed, no `scripts/ensure-columns.js`. Verified:
`prisma generate` succeeds with no `DATABASE_URL` and no `.env` present, so the
build cannot fail on a missing connection string the way the previous setup did.

`scripts/ensure-columns.js` remains in the repository as an additive drift
patcher (3 `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, 4 indexes;
no DROP/TRUNCATE/DELETE) and must only be run as a deliberate operator step.

---

## 3. Environment-variable checklist (names only)

Legend — **Build**: needed to build. **Runtime**: read by the running app.
**Admin**: administrative scripts only.

| Variable | Build | Runtime | Optional | Default | Format / values | Notes |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | no | **yes** | no | — | `postgresql://…-pooler…/neondb?sslmode=require` | Pooled Neon host. Also read by `EnvironmentBadge` to pick the badge label. |
| `DIRECT_URL` | no | **no** | yes at runtime, required for schema admin | — | `postgresql://…` (direct host, no `-pooler`) | Prisma `directUrl`. Used by `prisma db push` / `migrate`. Application queries never use it. |
| `JWT_SECRET` | **yes** | **yes** | no | — | any secret string, 32+ chars recommended | Read in `src/middleware.ts` (Edge bundle) **at build time** — it is inlined. Changing it requires a redeploy and signs every user out. |
| `APP_ENV` | no | yes | yes | derived from `NODE_ENV`/`DATABASE_URL` | `DEVELOPMENT` \| `STAGING` \| `PILOT` \| `TEST` \| `production` | UI badge only. `production` = no badge. |
| `NODE_ENV` | no | yes | yes | — | `production` | Set it explicitly on Render. |
| `SESSION_IDLE_TIMEOUT_SECONDS` | no | yes | yes | `28800` | positive integer (seconds) | `src/lib/auth.ts` |
| `SESSION_BACKGROUND_TIMEOUT_SECONDS` | no | yes | yes | `7200` | positive integer | `src/lib/auth.ts` |
| `SESSION_ABSOLUTE_TIMEOUT_SECONDS` | no | yes | yes | `28800` | positive integer | `src/lib/auth.ts` |
| `OFFLINE_COLLECTIONS_ENABLED` | no | **no** | yes | — | `true` \| `false` | Declared in `.env.example`, not referenced by code at this commit. |
| `OFFLINE_MOMO_ENABLED` | no | **no** | yes | — | `true` \| `false` | Same as above. |
| `NEXTAUTH_URL` | no | **no** | yes | — | absolute URL | Declared in `.env.example`; not read anywhere in the code. Set for documentation value. |
| `PLATFORM_ADMIN_PASSWORD` | no | **no** | yes | — | secret | **Not used on `main`.** Only the unpushed `master` bootstrap script consumes it. |
| `PG_DATABASE_URL` | no | no | yes | — | PostgreSQL URL | Admin script `prisma/staging-rehearsal.ts` only. |
| `SOURCE_DATABASE_URL` | no | no | yes | — | PostgreSQL URL | Admin script `prisma/migrate-data.ts` only. |
| `PORT` | no | yes | no | `3000` | integer | **Provided automatically by Render.** |
| `RENDER_GIT_COMMIT` | no | yes | — | — | 40-char SHA | **Provided automatically by Render**; echoed as `commit` by both health endpoints. |
| `GIT_COMMIT`, `SOURCE_VERSION`, `VERCEL_GIT_COMMIT_SHA`, `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` | no | yes | yes | — | SHA | Fallbacks only; not provided by Render. |

Currently set on the Render service: `DATABASE_URL`, `DIRECT_URL`,
`JWT_SECRET`, `PORT`. Still to set manually: `APP_ENV`, `NODE_ENV`,
`SESSION_*` (optional, defaults are fine), `NEXTAUTH_URL` (cosmetic).

---

## 4. Database initialization (already performed)

The Neon database was initialized by the supervised first deployment of this
repository (the `db push` step that existed before this change), and then
re-verified here:

```bash
# Prisma CLI with the direct Neon host — reports "already in sync"
DATABASE_URL="$NEON_POOLED" DIRECT_URL="$NEON_DIRECT" \
  npx prisma db push --schema=prisma/schema-pg.prisma --skip-generate
# → The database is already in sync with the Prisma schema.
```

Verified state (`information_schema` + `pg_indexes` + `pg_constraint`, read through
Prisma Client over the pooled host):

- 19 tables: AuditLog, CardFee, Collector, CollectorCustomerAssignment,
  CollectorRemittance, Commission, Contribution, ContributionAllocation,
  Customer, DailyAccount, DeviceEnrollment, Expense, Location,
  OfflineTransaction, PasswordResetToken, SusuAccount, SusuCycle, User,
  Withdrawal.
- 94 indexes, 202 constraints.
- Row counts: **0** in all 19 tables (fresh database, no seed data).

Re-running schema setup by hand (only if a future branch changes the schema):

```bash
DATABASE_URL="$NEON_POOLED" DIRECT_URL="$NEON_DIRECT" \
  npx prisma db push --schema=prisma/schema-pg.prisma --skip-generate
```

Never `--accept-data-loss`, never `prisma db seed`, never `prisma migrate reset`.

---

## 5. First administrator (owner action, one time)

This commit has no `PlatformSuperAdmin` model — that belongs to the unpushed
`master` work. The application needs one `User` row with `role = "admin"`, and
`prisma/seed.ts` must not be used because it also inserts demo locations, staff
and sample financial records.

Use the dedicated bootstrap script:

```bash
DATABASE_URL="<Neon direct URL>" \
ADMIN_EMAIL="<owner email>" \
ADMIN_NAME="<owner full name>" \
ADMIN_PASSWORD="<at least 12 characters>" \
node scripts/bootstrap-first-admin.mjs
```

Behaviour (verified against a throwaway PostgreSQL 16 database):

| Case | Result |
|---|---|
| No administrator exists | creates exactly 1 admin `User`, bcrypt cost 12, prints id/email/role only |
| Run again | exits 1, prints existing admin emails, writes nothing |
| Password < 12 chars | exits 1 before touching the database |
| Non-PostgreSQL URL | exits 1 |

Notes:
- The password is never printed and never stored in plain text.
- The script does not create locations, customers, workers or any financial record.
- Remove `ADMIN_PASSWORD` from the shell after running.
- `PLATFORM_ADMIN_PASSWORD` is **not** required for this deployment; do not set it
  on Render. It only applies to the platform-admin bootstrap that does not exist on `main`.
- After the first admin exists, further staff are created inside the app (admin →
  staff), not by scripts.

---

## 6. Health checks

```bash
curl -s https://bik-prestige-enterprise-pcxi.onrender.com/api/health
# {"status":"ok","app":"bik-prestige","env":"production","commit":"44d3a99..."}

curl -s -o - -w '\n%{http_code}\n' https://bik-prestige-enterprise-pcxi.onrender.com/api/health/ready
# 200 {"status":"ready","database":"ok","latencyMs":1014,...}
```

`/api/health` is liveness only (never touches the pool) and is the Render health
check target, so a database outage cannot cause a restart loop.
`/api/health/ready` runs `SELECT 1` with a 5 s timeout and returns 503 when Neon
is unreachable. `commit` is the deployed SHA — use it to prove a deploy, never
assume one.

---

## 7. Deployment procedure (steady state)

1. Push to `main` (auto-deploy) or trigger a deploy in the Render dashboard.
2. Watch the build: `npm ci` → `prisma generate` → `next build`. No database step.
3. Confirm `/api/health` returns `commit` = new SHA.
4. Confirm `/api/health/ready` returns 200 `database: "ok"`.
5. Smoke-test `/login`, `/admin/login`.

---

## 8. Rollback

- **Application:** Render dashboard → service → *Rollback* to a previous deploy
  (or redeploy an earlier commit). Database schema is unaffected by app rollback.
- **Database:** the schema is additive and empty; there is no business data to
  restore yet. Once records exist, take `pg_dump --format=custom` archives from
  the direct host before any schema change, verify with `pg_restore --list`, and
  restore into a new Neon branch — never in place.
- Never `prisma migrate reset`, `DROP DATABASE`, `--accept-data-loss`, force-push
  or rewrite history.

---

## 9. Free-tier limits and warnings

- **Render Free**: service sleeps after ~15 min idle; cold start ~30–60 s.
  Move to `Starter` before handing the URL to field staff.
- **Neon Free**: compute suspends when idle, limited compute hours and storage,
  short point-in-time-restore window. Keep your own `pg_dump` archives.
- **Region mismatch**: Render service is in **Oregon**, Neon in **us-east-2
  (Ohio)**. Every query crosses ~2,000 km. Measured readiness latency ~1.0 s on
  a cold connection. For a database-heavy business app, recreate the Render
  service in Ohio (or create the Neon project in us-west-2) before going live.
- **`JWT_SECRET` is inlined at build time** into the Edge middleware bundle.
  Changing it in the dashboard alone does nothing until the service is rebuilt.
- **Pooled connections**: always use `DIRECT_URL` for schema operations; the
  pooler can fail or hang on `db push`.
- **Native module**: `better-sqlite3@13.0.3` ships no prebuilt binaries and is
  unused by this app, but `npm ci` still compiles it. Works on Render's image
  (verified equivalent on `node:22-bookworm`). Fallback if a build ever fails
  there: `npm ci --include=dev --ignore-scripts && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build` (verified on `node:22-bookworm-slim`).
- **Stale advisories** (recorded, not fixed): `npm audit` reports 13 —
  1 critical (`next` 16.3.2), 9 high (`prisma` 6.19.3, `zod` < 4.6.6),
  3 moderate (`vitest`, `@vitest/coverage-v8`). No forced upgrades were applied.

---

## 10. Verification log (2026-10-31)

| Check | Result |
|---|---|
| `origin/main` fast-forward `a30d2aa` → `44d3a99` | PASS, no force |
| Render deploy of `44d3a99` | PASS, status `live` |
| `/api/health` | 200, `commit: 44d3a99a0fa5c4fd521d2eb116984aa27a8f6b62` |
| `/api/health/ready` | 200, `database: "ok"`, `latencyMs: 1014` |
| `/login`, `/admin/login` | 200 |
| Schema drift (`db push` on direct host) | "already in sync" |
| Table / index / constraint counts | 19 / 94 / 202 |
| Row counts in all tables | 0 |
| Local `typecheck` / `build` | PASS |
| Local `lint` | pre-existing 19 errors (unchanged) |
| Local `npm test` | 147 passed / 4 pre-existing failures (unchanged) |
