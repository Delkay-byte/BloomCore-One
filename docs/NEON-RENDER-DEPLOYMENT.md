# Neon + Render Parallel Rehost — BIK Prestige Enterprise

**Status as of 2026-10-30:** repository work is complete and pushed. Neon and
Render provisioning are **not** done — they require owner account access.
Nothing in the existing production environment has been changed.

| Item | Value |
|---|---|
| GitHub repo | `https://github.com/Delkay-byte/BIK-Prestige-Enterprise` |
| Deployment branch | `rehost/neon-render` |
| Base commit (production code) | `a30d2aa1acadecb94c9c711bb3b29bec042c8064` (`origin/main`) |
| Existing (untouched) service | `https://bik-prestige-enterprise.onrender.com` |
| New service name (planned) | `bik-prestige-enterprise-neon` |
| Neon project | **BIK Prestige** (created by owner; identity not yet verified from here) |
| Prisma | 6.19.3 (unchanged); `@prisma/client` 6.19.3 |
| Node | 22.23.2 pinned via `.node-version` (Next 16 requires >= 20.9.0) |

---

## 1. Architecture

```
                    GitHub: Delkay-byte/BIK-Prestige-Enterprise
                     branch  main                    branch  rehost/neon-render
                        |                                |
                        |                                +--> Render Web Service (NEW)
                        |                                       bik-prestige-enterprise-neon
                        |                                       Next.js 16 full server runtime
                        |                                         - server actions
                        |                                         - API routes
                        |                                         - middleware (JWT sessions)
                        |                                                |
                        |                                                | DATABASE_URL (pooled)
                        |                                                v
                        |                                        Neon PostgreSQL 16
                        |                                        project "BIK Prestige"
                        |                                        branch: default (production)
                        |                                                ^
                        |                                                | DIRECT_URL (unpooled)
                        |                                                +-- schema admin only
                        |
                        +--> Render Web Service (EXISTING — DO NOT TOUCH)
                             bik-prestige-enterprise.onrender.com
                             old Render PostgreSQL (source of truth until cutover)
```

The application is a **single full-stack Next.js Web Service**. There is no
separate API service: server actions, route handlers, middleware and page
rendering all run in the same Node process. Do not split it.

---

## 2. What differs from the pre-existing deployment setup

| Area | Before | After (this branch) |
|---|---|---|
| Build command | `npm install --include=dev && prisma generate && prisma db push && node scripts/ensure-columns.js && npm run build` | `npm ci && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build` |
| Schema mutation during build | Yes (`db push`, `ensure-columns.js`) | **No** — build never touches the database schema |
| Prisma datasource | `url = env("DATABASE_URL")` | `url = env("DATABASE_URL")` + `directUrl = env("DIRECT_URL")` |
| Node version | Render default (24.14.1 observed) | `.node-version` = `22.23.2` |
| Health endpoint | `/api/health` (liveness only) | `/api/health` (liveness) + `/api/health/ready` (DB probe) |

The failed production build failed at `prisma db push` because `DATABASE_URL`
was not present in the service environment. That failure is what the separated
build removes: Prisma Client generation needs no database, and the build no
longer asks for one.

---

## 3. Prisma 6 connection configuration

`prisma/schema-pg.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

- `DATABASE_URL` — Neon **pooled** connection (hostname contains `-pooler`).
  Used by application queries at runtime.
- `DIRECT_URL` — Neon **unpooled** connection. Used only by `prisma migrate`,
  `prisma db push`, `prisma db pull` and other schema administration.
- `prisma/schema.prisma` (SQLite, local development) is unchanged. Local
  development keeps working and must never receive a production URL.
- Prisma major version is unchanged (6.19.3). No Prisma 7 driver adapter is
  installed: `better-sqlite3` / `@prisma/adapter-better-sqlite3` are present in
  `dependencies` but are **not imported by any application code** (verified by
  search over `src/`, `scripts/`, `tests/`, `prisma/`). They are retained
  untouched.

Connection reuse: `src/lib/db.ts` exports one `PrismaClient` instance cached on
`globalThis` outside production, so Next.js hot reload does not create new pools.

---

## 4. Environment variables (names only — never commit values)

Required by the NEW Render service:

| Variable | Purpose | Source |
|---|---|---|
| `DATABASE_URL` | Pooled Neon PostgreSQL connection | Neon dashboard → Connect → **Pooled** |
| `DIRECT_URL` | Unpooled Neon connection (schema admin only) | Neon dashboard → Connect → **Direct** |
| `JWT_SECRET` | Signs all session JWTs; middleware throws at boot if missing | Owner's existing production secret (do not rotate) |
| `NEXTAUTH_URL` | Absolute application URL | `https://<new-service>.onrender.com` |
| `NODE_ENV` | `production` | set in `render.yaml` |
| `APP_ENV` | `PILOT` (renders environment badge; existing production value) | set in `render.yaml` |
| `SESSION_IDLE_TIMEOUT_SECONDS` | Session policy | `render.yaml` (`300`) |
| `SESSION_BACKGROUND_TIMEOUT_SECONDS` | Session policy | `render.yaml` (`60`) |
| `SESSION_ABSOLUTE_TIMEOUT_SECONDS` | Session policy | `render.yaml` (`900`) |
| `OFFLINE_COLLECTIONS_ENABLED` | Offline pilot flag | `render.yaml` (`false`) |
| `OFFLINE_MOMO_ENABLED` | Offline pilot flag | `render.yaml` (`false`) |

Optional / operator-only: `PLATFORM_ADMIN_PASSWORD` (bootstrap script only),
`PG_DATABASE_URL` and `SOURCE_DATABASE_URL` (used by rehearsal scripts, not by
the running application).

`RENDER_GIT_COMMIT` is injected automatically by Render and is echoed by both
health endpoints as `commit`.

> Keep `JWT_SECRET` identical to the current production value only if existing
> sessions should survive; otherwise every user is signed out. It must never
> change silently.

---

## 5. Database bootstrap procedure (operator, one time)

The build never creates schema. Choose **one** of the two paths.

### Path A — preserve existing BIK data (required unless owner explicitly declines)

The source is the existing Render PostgreSQL used by
`bik-prestige-enterprise.onrender.com`.

```bash
# 1. Read the External Database URL from the Render dashboard (the service
#    list is not reachable from the current machine's API key).
#    Store it outside the repo, e.g. C:\...\BIK Prestige Ent\.secrets\source-db-url.txt
# 2. Backup (direct, unpooled connection; custom format)
pg_dump "$SOURCE_DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file="$BACKUP_DIR/bik-prestige-pre-neon.dump"

# 3. Verify the archive is readable and list its contents
pg_restore --list "$BACKUP_DIR/bik-prestige-pre-neon.dump" | head -40
sha256sum "$BACKUP_DIR/bik-prestige-pre-neon.dump"

# 4. Restore into the empty Neon database (direct URL), no create/drop
pg_restore --dbname="$NEON_DIRECT_URL" --no-owner --no-privileges \
  --single-transaction --verbose "$BACKUP_DIR/bik-prestige-pre-neon.dump"

# 5. Compare counts source vs target (same query both sides)
SELECT 'User' t, count(*) FROM "User"
UNION ALL SELECT 'Customer', count(*) FROM "Customer"
UNION ALL SELECT 'Contribution', count(*) FROM "Contribution"
UNION ALL SELECT 'ContributionAllocation', count(*) FROM "ContributionAllocation"
UNION ALL SELECT 'Withdrawal', count(*) FROM "Withdrawal"
UNION ALL SELECT 'Commission', count(*) FROM "Commission"
UNION ALL SELECT 'CardFee', count(*) FROM "CardFee"
UNION ALL SELECT 'CollectorRemittance', count(*) FROM "CollectorRemittance"
UNION ALL SELECT 'DailyAccount', count(*) FROM "DailyAccount"
UNION ALL SELECT 'Expense', count(*) FROM "Expense"
UNION ALL SELECT 'AuditLog', count(*) FROM "AuditLog"
ORDER BY t;
```

Notes:
- `pg_dump`/`pg_restore` are **not installed on this machine**. Use Docker:
  `docker run --rm -v <dir>:/b -e PGPASSWORD postgres:16 pg_dump ...`
  (PostgreSQL 16 client matches the source and Neon).
- The dump is a point-in-time snapshot. If the old application keeps taking
  writes, the new environment drifts. Final cutover needs a maintenance window
  or a second delta restore.
- Never restore into a populated target. Verify emptiness first:
  `SELECT count(*) FROM information_schema.tables WHERE table_schema='public';`

### Path B — genuinely fresh database (owner must authorize explicitly)

Local rehearsal evidence (throwaway PostgreSQL 16 container, database
`bik_neon_readycheck`): `prisma db push` created exactly 19 tables —
AuditLog, CardFee, Collector, CollectorCustomerAssignment, CollectorRemittance,
Commission, Contribution, ContributionAllocation, Customer, DailyAccount,
DeviceEnrollment, Expense, Location, OfflineTransaction, PasswordResetToken,
SusuAccount, SusuCycle, User, Withdrawal. With this branch (code = `a30d2aa`)
there are no tenant tables; `BusinessTenant` / `PlatformSuperAdmin` /
`PlatformAuditLog` belong to the unpushed `master` work and are **not** part of
this deployment.

```bash
DATABASE_URL="$NEON_POOLED_URL" DIRECT_URL="$NEON_DIRECT_URL" \
  npx prisma db push --schema=prisma/schema-pg.prisma --skip-generate
```

Do **not** run `--accept-data-loss`, do not run `prisma db seed`, and do not
run `scripts/ensure-columns.js` unless a specific missing column is proven.

### About `scripts/ensure-columns.js`

It is an additive drift patcher: it creates `BusinessTenant`,
`PlatformSuperAdmin`, `PlatformAuditLog` with `CREATE TABLE IF NOT EXISTS`,
adds `tenantId` to 19 tables with `ADD COLUMN IF NOT EXISTS`, adds 4 indexes,
and adds 5 legacy columns (`Contribution.recordedByName`, `receivedByName`,
`receivedById`, `User.momoEnabled`, `susuEnabled`). It contains no DROP,
TRUNCATE or DELETE. It is **removed from the build** and must only ever be run
as a deliberate, reviewed operator step.

---

## 6. New Render service settings

Create: **New → Web Service** (not Static Site, not Private Service).

| Setting | Value |
|---|---|
| Name | `bik-prestige-enterprise-neon` |
| Repository | `Delkay-byte/BIK-Prestige-Enterprise` |
| Branch | `rehost/neon-render` |
| Runtime | Node |
| Region | same as the Neon project region (owner-created project; confirm in dashboard) |
| Build command | `npm ci && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Auto-deploy | on (branch is dedicated to this environment) |
| Plan | Free (or Starter to avoid cold starts) |

`render.yaml` on this branch encodes the same settings, so **New → Blueprint**
against `rehost/neon-render` produces an identical service. The blueprint
deliberately does **not** describe the existing `bik-prestige-enterprise`
service, so a blueprint sync cannot touch it.

Environment variables: set the names in §4 in the new service only. Secrets use
`sync: false` in the blueprint and are entered in the dashboard.

Start command / port: `next start` reads `PORT` from the environment. Verified
locally: `PORT=3100 npm start` served `/api/health` on `http://127.0.0.1:3100`.
Next binds `0.0.0.0` by default, so Render's router can reach it.

---

## 7. Health checks

```bash
# Liveness — process is up; never touches the database
curl -s https://<new-service>.onrender.com/api/health
# {"status":"ok","timestamp":"...","app":"bik-prestige","env":"PILOT","commit":"<sha>"}

# Readiness — proves Prisma can reach Neon (5 s timeout)
curl -s -o - -w '\n%{http_code}\n' https://<new-service>.onrender.com/api/health/ready
# 200 {"status":"ready","database":"ok","latencyMs":98,...}
# 503 {"status":"not_ready","database":"error",...}
```

`commit` must equal the SHA of the deployed branch head: this is how the
deployment is proven, not assumed.

Render's own health check points at the liveness endpoint on purpose: a
database outage must not put the service into a restart loop.

---

## 8. Deployment procedure

1. Ensure Neon is provisioned and the schema exists (Path A or Path B above).
2. Create the new Render service with the settings in §6.
3. Set all environment variables (§4) in the new service.
4. Trigger the first deploy of `rehost/neon-render`.
5. Confirm build log ends with a successful `next build`, and the log contains
   **no** `prisma db push`, no `ensure-columns`, no seed step.
6. Confirm `GET /api/health` returns `commit` = branch head SHA.
7. Confirm `GET /api/health/ready` returns **200** with `database: "ok"`.
8. Smoke-test read-only (see §9). Do not create financial records.
9. Leave the old service running. Do not change DNS. Do not announce the new
   URL to staff until the owner approves cutover.

---

## 9. Post-deploy verification (read-only)

| Check | Expectation |
|---|---|
| `/api/health` | 200, `commit` = deployed SHA |
| `/api/health/ready` | 200, `database: "ok"` |
| `/login`, `/admin/login`, `/platform/login` | 200, no 500 |
| BIK admin sign-in (Path A only) | succeeds with existing credentials |
| MoMo worker / Susu collector / customer sign-in | issued cookies, dashboard loads |
| MoMo dashboard, Susu dashboard | load with existing figures |
| Money & History (both modules) | lists records, filters work |
| Contributions / withdrawals / remittances history | present and matching source counts |
| Tenant isolation | not applicable to this commit (no tenant model) |
| Render logs | no Prisma `P1001`/`P1000`, no repeated schema init |

---

## 10. Rollback

The old environment is the rollback.

1. **New service only:** Render dashboard → new service → Suspend. The old
   service and its URL are unaffected.
2. **Old application config:** untouched by this task; nothing to restore.
3. **Neon database:** restore the pre-cutover archive into a *new* Neon branch
   or database, verify, then repoint `DATABASE_URL`. Never restore in place over
   a live database.
4. **Environment variables:** the old service's variables were never read or
   written. If new ones must be withdrawn, delete them from the new service only.
5. Never run `prisma migrate reset`, `DROP DATABASE`, `--accept-data-loss`, or
   reverse migrations.

---

## 11. Free-tier limits and warnings

- **Render Free web service**: sleeps after ~15 minutes idle; first request
  afterwards takes ~30–60 s. Unacceptable for live field collection work.
  Use `Starter` before handing the URL to staff.
- **Render Free**: 750 instance-hours/month per workspace.
- **Neon Free**: compute suspends when idle (cold start ~1 s), storage and
  compute-hour caps, and **point-in-time restore is limited**; keep your own
  `pg_dump` archives for anything you cannot lose.
- **Pooled connections**: Neon's pooler supports Prisma, but `directUrl` must be
  used for every schema operation. Running `db push` through the pooled host can
  fail or hang.
- **Parallel drift**: while both systems run, writes to the old database are not
  in the new one. Cutover needs a maintenance window and a final delta backup.
- **Build-time native module**: `better-sqlite3@13.0.3` publishes no prebuilt
  binaries, so `npm ci` compiles it with `node-gyp`. It is unused by this
  application. Verified: succeeds on `node:22-bookworm` (has Python 3.11 and
  build tools). If Render's image lacks Python, use the fallback:
  `npm ci --include=dev --ignore-scripts && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build`
  (verified end-to-end on `node:22-bookworm-slim`).

---

## 12. Verified results (this machine, 2026-10-30)

| Check | Result |
|---|---|
| `npm ci --include=dev` (Windows, Node 22.23.2) | **FAIL** — `better-sqlite3` native build needs a Visual Studio toolchain; unrelated to runtime (module unused). Repaired locally with `--ignore-scripts` for verification. |
| `npm ci` + generate + build (Linux `node:22-bookworm`) | **PASS** (npm ci, `prisma generate`, `next build` all exit 0) |
| Fallback build (Linux `node:22-bookworm-slim`, `--ignore-scripts`) | **PASS** |
| `npx prisma generate --schema=prisma/schema-pg.prisma` | **PASS**, client v6.19.3 |
| `npm run typecheck` | **PASS** (0 errors) |
| `npm run lint` | **FAIL — pre-existing**: 19 errors / 86 warnings at commit `a30d2aa`, mostly `@typescript-eslint/no-explicit-any` in `tests/`. Not introduced by this branch; lint is not part of the Render build. |
| `npm test` | **147 passed / 4 failed** (151) — pre-existing at `a30d2aa`: `customer-portal` (2), `momo` duplicate-location-code (1), `operational-integrity` received-by name (1). Unchanged by this branch. |
| `npm run build` (local, placeholder Postgres URL) | **PASS** — proves the build performs no database queries |
| `PORT=3100 npm start` + `/api/health` | **200**, `{"status":"ok",...,"commit":null}` locally |
| `/api/health/ready` against unreachable DB | **503**, `{"status":"not_ready","database":"error"}` |
| `/api/health/ready` against real PostgreSQL 16 + `prisma db push` schema | **200**, `{"status":"ready","database":"ok","latencyMs":98}` |
| `npm audit` | 13 advisories: 1 critical (`next` 16.3.2), 9 high (`prisma` 6.19.3, `zod` < 4.6.6), 3 moderate (`vitest`, `@vitest/coverage-v8`). Recorded only — no forced upgrades performed. |

---

## 13. Remaining manual steps (owner)

1. **Neon access** — provide the pooled and direct connection strings for the
   `BIK Prestige` project, or confirm the project region/PostgreSQL version.
   Store them outside Git (e.g. `.secrets/`), never in chat.
2. **Source database access** — provide the External Database URL of the old
   Render PostgreSQL, or explicitly authorize Path B (fresh, empty database,
   no existing BIK records).
3. **Render access** — create the new service in the workspace/account that owns
   the repository, or provide an API key for that workspace.
4. **Secrets** — supply the existing `JWT_SECRET` so current sessions and
   password hashes keep working (password hashes live in the database; the
   secret only signs tokens).
