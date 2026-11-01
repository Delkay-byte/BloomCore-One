# PLATFORM FOUNDATION REPORT — Phase 1 (§25 Master Prompt 1)

**Builder:** BloomCore Technologies
**Date:** 2026-10-30
**Repository:** https://github.com/Delkay-byte/BloomCore-One (app lives in `Momo module/`)

---

## Source and architecture

| Item | Value |
|---|---|
| Current branch | `master` |
| Commit SHA (this phase) | `4a03231` (local only — **not pushed**, by operator decision) |
| Parent HEAD | `a30d2aa` ("chore: add pre-pilot database cleanup scripts") |
| Existing tenant model | none (single-business app; every model global) |
| New tenant model | `BusinessTenant` (code, module entitlements, lifecycle, onboarding) + nullable `tenantId` on all 19 tenant-owned models |
| Authentication boundary | Platform Super Admin is a **separate identity table** (`PlatformSuperAdmin`) with its own cookie (`bik-platform-session`), JWT `kind:"platform"` claim, 4 h session policy and middleware rules. Tenant cookies (`bik-admin/worker/collector/customer-session`) are never consulted on `/platform/*` and vice versa. |
| Tenant context mechanism | `src/lib/tenant.ts` — the only way any code obtains a tenantId: module session → DB User re-read (`status` + `tokenVersion`) → `user.tenantId` → `BusinessTenant` re-read (must be `ACTIVE`) → module entitlement intersection. Fails closed to `null`; no global fallback, no browser-supplied tenant input. Cross-tenant references are blocked by `assertTenantEntity` / `assertAllTenantEntities`. |

## Platform Super Admin

| Item | Status |
|---|---|
| Bootstrap mechanism | `node scripts/bootstrap-platform-admin.mjs --email … --name …` — operator-run, idempotent, bcrypt-12, refuses when active admins exist (unless `--force`), accepts `PLATFORM_ADMIN_PASSWORD` or prints a one-time 24-char password once, forces change at first login, writes a `platform.bootstrap` audit event. Never runs in build/start/seed. No public registration. |
| Login | `/platform/login` → `platformLogin` server action (rate-limited 5/15 min, generic failure message, `platform.login` / `platform.login_failed` audit) |
| Separate session | `bik-platform-session`; `kind:"platform"` claim enforced in `verifyPlatformToken` and middleware; disjoint from all tenant cookie names (tested) |
| Dashboard | `/platform/dashboard` — totals by status, module distribution, onboarding counts, recent enrollments, recent platform activity, health (DB connectivity, APP_ENV, deploy commit). No invented metrics, no secrets. |
| Tenant directory | `/platform/tenants` — server-side search (name/code), filters (module type, status, onboarding), pagination |
| Enrollment | `/platform/tenants/new` — 5-step wizard; atomic transaction creates tenant + primary admin + audit events; failure leaves no partial records |
| Tenant detail | `/platform/tenants/[id]` — profile, primary admin (no hashes), aggregate operational counts per enabled module, lifecycle and recovery actions |
| Platform audit | `/platform/audit` — paginated, filterable platform history; isolated `PlatformAuditLog` table |
| Activation/suspension | `setTenantStatus` — suspend requires a reason; timestamps + reason persisted; audited; reactivation supported |

## Business enrollment

| Item | Status |
|---|---|
| MoMo only | PASS — `momoEnabled=true, susuEnabled=false` persisted; enforced server-side (test: `enrollment.test.ts`) |
| Susu only | PASS — `momoEnabled=false, susuEnabled=true` persisted; enforced server-side |
| Both modules | PASS — both flags true |
| Tenant administrator provisioning | PASS — distinct `User` (role `admin`) created in the same transaction, tenant-owned, one-time bcrypt-hashed credential shown once, `forcePasswordReset` set, `tokenVersion` invalidation on recovery |
| Module enforcement | PASS — entitlement read from the **tenant record**, intersected with user flags; a user flag can never grant an unpurchased module (tested) |

## Tenant isolation (all PASS with test evidence)

Verified through the real server actions and the canonical guard with Tenant A vs Tenant B fixtures, including direct ID substitution (`tests/tenant-isolation.test.ts`, `tests/enrollment.test.ts`):

| Surface | Result | Evidence |
|---|---|---|
| Customers | PASS | B's directory/statement/search never contain A's customers; `getCustomerById(A.id)` → null |
| Workers / staff | PASS | staff lists filtered by `tenantId` from context |
| Collectors | PASS | collector records + assignments tenant-scoped; substitution via session only |
| Locations | PASS | per-tenant code uniqueness (same code valid in two tenants); each tenant sees only its own |
| Contributions | PASS | recording against A's account from B → "Susu account not found", nothing written |
| Withdrawals | PASS | tenant-scoped queries + `assertTenantEntity` deny |
| Daily accounts | PASS | B's list empty of A's accounts |
| Expenses | PASS | `assertTenantEntity("expense", …)` denies cross-tenant |
| Reports / dashboard aggregates | PASS | all aggregations carry `tenantId: ctx.tenantId` |
| Exports | PASS | exports are client-side CSVs of already tenant-scoped action data |
| Offline / device records | PASS | device enrollment + sync verify deviceId+userId+**tenantId**+active |
| Audit | PASS | new `AuditLog` rows stamped with owning tenant (central resolution in `createAuditLog`) |
| Cross-tenant ID substitution | PASS | 13-model `assertTenantEntity` matrix: every A-owned id denied for B, allowed for A |

## Existing BIK tenant

| Item | Status |
|---|---|
| Tenant created/preserved | PASS — `BIK-HQ-001` "BIK Prestige Enterprise", MoMo+Susu, ACTIVE, onboarding COMPLETED (backfill script, idempotent) |
| Existing admin preserved | PASS — first active admin assigned as `primaryAdminUserId`; password hash untouched |
| Existing data backfilled | PASS — all 19 tenant-owned tables updated from NULL → BIK tenant |
| Existing financial history preserved | PASS — pre/post row counts verified equal; identifiers unchanged (backfill verification output + `backfill.test.ts`) |
| Login verified | PASS — `admin@bikprestige.com` signed in via `/admin/login` on the tenanted local database; tenant-scoped pages load (browser smoke test) |

## Database

| Item | Status |
|---|---|
| SQLite schema | `prisma/schema.prisma` — tenancy applied, `prisma db push` verified on dev + test DBs |
| PostgreSQL schema | `prisma/schema-pg.prisma` — kept in sync (differs from SQLite schema on the provider line only) |
| Migration | `prisma/migrations/20261029_multitenant_platform_foundation/` — additive only (`IF NOT EXISTS`, nullable `tenantId`, index swap) |
| Backup | operator step (see runbook) — manual dumps pattern in `backups/` |
| Pre/post-migration counts | verified equal on local dev DB by `scripts/backfill-bik-tenant.mjs` output |

## Regression tests

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | PASS |
| Unit + integration tests (`vitest run`) | PASS — **196/196** (12 files), incl. new platform-auth (16), tenant-isolation (11), enrollment/lifecycle (16), backfill (2) suites |
| Tenant isolation tests | PASS — see matrix above |
| Lint (`eslint`) | PASS — 0 errors (85 pre-existing style warnings) |
| Build (`next build`) | PASS — all 7 `/platform/*` routes compiled |
| SQLite dev | PASS — dev + test DBs migrated, seeded, backfilled |
| PostgreSQL | Schema + migration consistent; live-PG regression requires the hosted DB (runbook step 6) |

## Git and deployment

| Item | Value |
|---|---|
| Commit SHA | `4a03231` (local) |
| Pushed to master | **No** — per operator decision; pushing triggers the Render auto-deploy |
| Production deployment SHA | pending deploy |
| Live platform login verified | Not yet — requires production deploy + bootstrap (runbook) |

---

## Production runbook (operator steps before enrolling a second real business)

1. **Confirm environment** — verify Render service `bik-prestige`, branch `master`.
2. **Backup** — take a recoverable PostgreSQL snapshot (Render dashboard / `pg_dump`) and store it in `backups/`.
3. **Record pre-migration counts** — users, locations, customers, susu accounts, contributions, withdrawals, daily accounts, expenses.
4. **Push** `4a03231` to `master`. Render build runs `prisma db push` (additive-only; creates the platform tables and nullable `tenantId` columns) + `ensure-columns.js`.
5. **Bootstrap the Platform Super Admin** (once, from the Render shell or locally against the production `DATABASE_URL`):
   `node scripts/bootstrap-platform-admin.mjs --email <operator email> --name "<name>"`
   Store the printed one-time password securely; it is shown once.
6. **Run the backfill** against production:
   `node scripts/backfill-bik-tenant.mjs` (use `--dry-run` first). Verify the "✅ Row counts preserved" output and re-check the counts from step 3.
7. **Verify**: existing BIK administrator signs in and MoMo/Susu workflows operate; `/platform/login` opens; enroll a THROWAWAY test tenant, confirm isolation, then leave it (or suspend it — do not delete).
8. **Do not** reseed, reset, or drop anything in production.

## Limitations / notes

- Production verification (steps 4–7) could not be executed from this environment (no production DB access) — the platform foundation is therefore certified by local integration tests and the live smoke test on the development database.
- `tenantId` columns remain **nullable** by design this phase (additive migration + app-layer fail-closed enforcement). A NOT NULL tightening migration is possible after the production backfill.
- PasswordResetToken and AuditLog were added to `TENANT_SCOPED_MODELS`; `resolveAuthenticatedCollector` in `src/lib/auth.ts` retains no callers after the retrofit (kept for compatibility).
- Exports remain client-side CSVs of tenant-scoped action data (no server-side export paths to scope).

## Final status

**PLATFORM FOUNDATION PASS — READY FOR CONTROLLED TENANT ENROLLMENT**

(after the operator completes the production runbook above)
