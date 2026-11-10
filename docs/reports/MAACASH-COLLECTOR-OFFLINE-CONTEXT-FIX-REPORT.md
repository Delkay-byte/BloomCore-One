# MaaCash Collector Offline Context Fix — Diagnostic Report

Date: 10 November 2026

Branch: `fix/maacash-collector-offline-context`
Base: `origin/main` (`12cfaa7`)
Fix commit: `ca426e70571f889b7a6a4b111dc87163b328076d`
Pull request: pending
Approval: pending
Deployment: not performed

---

## A. Root cause

The failure was a **module-ambiguity defect in `/api/auth/me` combined with an offline scope resolver that treated every failure as unreadable storage**. It was not a revoked device, an expired authorization, a service-worker failure or IndexedDB corruption.

### Exact execution path

1. The collector tab authenticates with a **Susu** tab credential. The service worker attaches that credential's proof to `/api/auth/me`.
2. The old route had no module argument from offline preparation or the offline scope resolver. Its fallback tried, in order:
   `getMomoSession()` → `getSusuSession()` → `getAdminSession()` → `getCustomerSession()`.
   In the Susu tab the MoMo read fails (the tab credential belongs to `susu`) and the Susu read succeeds.
3. The route then discarded the information about **which module succeeded** and derived the tenant-resolution module from the user's primary role:

   ```ts
   user.role === "worker" ? "momo" : ...
   ```

4. A dual-role account has one primary `User.role` (for example `worker`) and two module capabilities. In the Susu tab, the primary role selected `momo`, so the route called `getTenantContext("momo")`.
5. `getTenantContext` reads the MoMo session for that module. That session is absent in the Susu tab, so it returns `null` by design (fail closed).
6. The route still returned **HTTP 200** with a valid `userId` but `tenant: null`.

### Why the two errors appeared together

- `src/lib/offline/preparation.ts` requires `me.tenant.id`. With `tenant: null` it returns:
  `The signed-in business could not be confirmed.`
- `src/lib/offline/scope.ts` requires a tenant before opening the scoped queue. It threw `No tenant scope for offline storage`.
- `src/lib/offline/session.ts` caught that storage-scope failure and set `available = false`. The panel therefore showed:
  `Saved-record details could not be read on this device.`
- The device preparation context lives in a **separate** IndexedDB database (`bloomcore-offline-device:v1`) that does not depend on the scoped transaction database. Its content was still valid, so the same panel correctly showed `Offline Ready`, the expiry date and the previous preparation timestamp.
- The panel labelled `readiness.lastSyncedAt` as "Last successful synchronization" even when the real queue could not be read. That made the two states look contradictory.

### Proven by

- `tests/auth-me-module-resolution.test.ts`: a neutral request whose actual session module is `susu` and whose primary role is `worker` must call `getTenantContext("susu")`, return `module: "susu"` and a non-null tenant.
- `tests/offline-module-scope.test.ts`: an HTTP 200 with `tenant: null` produces `no_tenant`, not a different module and not a guessed tenant; an explicit 401/403 never falls back to local context.
- `e2e/maacash-dual-role-switch.spec.ts`: the real dual-role test account switches MoMo → Susu, receives a Susu tenant and a readable empty queue, switches back to MoMo, then back to Susu with the same queue still readable.

**Not the cause:** tab proof-of-possession, service-worker timing, tenant entitlement, collector records, device revocation, IndexedDB availability or deleted records. No evidence supports those causes, and the regression tests show the defect reproduced with a valid session and tenant.

### Secondary presentation defect

`OfflineSyncStatus` could show a green `Offline Ready` heading while the queue and identity checks had failed, and it used the preparation timestamp as a successful synchronization time. This is fixed by keeping device readiness, server identity, queue availability and synchronization time as separate states.

---

## B. Code changes

| File | Change |
|---|---|
| `src/app/api/auth/me/route.ts` | Neutral lookup now resolves and returns the module that actually authenticated the tab. Tenant resolution uses that module, never the primary role. Unknown explicit modules return 400 instead of silently becoming a neutral lookup. Response includes `module`. |
| `src/lib/auth.ts` | Added `getAnyModuleSession()`, which returns the session together with its module so callers can use the correct authorization scope. |
| `src/lib/offline/active-module.ts` | New pure helper mapping `/collector` → `susu`, `/worker` → `momo`, `/admin` → `admin`, `/customer` → `customer`. Used as a request routing hint only; the server still verifies the credential. |
| `src/lib/offline/preparation.ts` | `prepareOfflineAccess(module?)` requests `/api/auth/me?module=<workspace>`, rejects a mismatched response module, and requires the requested staff module to be authorized before saving a context. Failure paths still leave the previous context and queue untouched. |
| `src/lib/offline/scope.ts` | Module-aware `getOfflineScope(module?)`; distinct `OfflineScopeError` codes (`unauthenticated`, `no_tenant`, `module_mismatch`, `network`, `timeout`, `offline_expired`, `unavailable`). Cached prepared context is used only for a genuine network/timeout path, only while unexpired, and only for a module the context supports. Explicit 401/403 and HTTP 200 with no tenant always fail closed. |
| `src/lib/offline/session.ts` | `getOfflineStatus(module?)` reads the same workspace scope as the dashboard. Adds `scope` state, resolves scope once, and never reports an unreadable/unauthorized scope as an empty queue. |
| `src/components/OfflineSyncStatus.tsx` | Accepts a `module` prop, passes it to status and preparation, shows a truthful per-code error, adds a safe retry that does not delete data, refuses a green success tone when identity or queue checks fail, and labels preparation time separately from successful synchronization. Includes one bounded automatic retry for a cold service-worker attach race. |
| `src/components/OfflineBootstrap.tsx` | Infers the active workspace module, requests `/api/auth/me?module=...`, verifies the returned module and prepares that workspace instead of using a neutral lookup. |
| `src/app/collector/(workspace)/dashboard/CollectorDashboardClient.tsx` | Seeds the offline scope from the server-resolved `userId` and `tenantId` produced by `requireTenantCollector()`. Passes `susu` to preparation and to `OfflineSyncStatus`. |
| `tests/auth-me-module-resolution.test.ts` | New API module-resolution regression tests. |
| `tests/offline-module-scope.test.ts` | New offline scope, scope-failure taxonomy, queue preservation and preparation tests. |
| `e2e/maacash-dual-role-switch.spec.ts` | Extended real-browser dual-role switch test with Susu/MoMo identity, tenant, offline panel and queue assertions in both directions. |

No database schema, migration, entitlement, collector record, device enrollment or service-worker cache format was changed.

---

## C. Before / after behaviour

### Before (reported production state)

- Susu collector dashboard loaded.
- Red banner: `The signed-in business could not be confirmed.`
- Offline panel: `Offline Ready`, valid expiry and `Last successful synchronization: 10 Nov, 10:17`.
- Same panel: `Saved-record details could not be read on this device. Your records are not deleted...`
- `GET /api/auth/me` returned HTTP 200 with `tenant: null` for the dual-role Susu tab.
- Offline preparation failed; the scoped queue could not be opened.

### After (local verification with a real dual-role test account)

- `GET /api/auth/me?module=susu` returns HTTP 200, `module: "susu"`, the authenticated user and the Susu tenant.
- Neutral `GET /api/auth/me` returns the actual tab module (`susu` in the Susu tab, `momo` in the MoMo tab) and the same tenant.
- The business-context banner does not appear.
- The queue opens under the server-resolved tenant/user scope and the panel reports the real queue count (`Synced. No unsynchronized offline records on this device.` in the clean test account).
- Switching MoMo → Susu → MoMo → Susu keeps the same queue readable.
- If identity cannot be confirmed, the panel now shows an amber partial state with the specific reason (session, tenant, workspace mismatch, network or storage) and a retry action. It does not claim that records were deleted.

---

## D. Data preservation

- No deletion, empty-database creation or database rename was added.
- `deleteDatabase`, `discardCurrentOfflineData`, sign-out and cross-tab coordination logic were not changed.
- The existing database name remains `bik-prestige-offline:v2:{tenantId}:{userId}`.
- Preparation still writes through `savePreparedContext`; failing preparation returns before writing, so an older valid context is preserved.
- Tests prove preservation:
  - `offline-module-scope.test.ts` → `does not delete or overwrite queued records when preparation fails` (pending record count remains 1).
  - `offline-module-scope.test.ts` → `opens the existing queue under the server-resolved tenant/user scope` (existing record is read back).
  - `offline-isolation.test.ts`, `offline-queue.test.ts`, `offline-deletion-coordination.test.ts` and `offline-preparation.test.ts` all pass unchanged.
- No production database or financial record was read, modified, migrated or deleted during this work.

---

## E. Tests

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Passed, no errors |
| `npm run lint` | Passed, 0 errors, 72 warnings (no new warnings from this change) |
| `npm test` | **75 files passed, 762 tests passed** |
| `tests/auth-me-module-resolution.test.ts` | 9 tests passed |
| `tests/offline-module-scope.test.ts` | 16 tests passed |
| Targeted offline/session/tenant suites | 10 files, 92 tests passed |
| `npx playwright test e2e/maacash-dual-role-switch.spec.ts --project=chromium` | 3 tests passed, including Susu/MoMo identity, tenant, offline queue and both-direction switching |
| `npx playwright test e2e/mobile.spec.ts --project=mobile-chromium` | 3 tests passed, including online prepare → offline reload → cached collector restore |
| `npm run build` | Passed |
| PostgreSQL `pg-offline-idempotency` | Not run: no isolated `PG_DATABASE_URL` was available. The change adds no persistence/schema work. |

---

## F. Release

- Branch: `fix/maacash-collector-offline-context`
- Base: `origin/main` at `12cfaa7`
- Fix commit: `ca426e70571f889b7a6a4b111dc87163b328076d`
- PR URL: pending
- Approval status: pending; not merged
- CI result: pending
- Deployment commit SHA: not deployed
- Production verification: not performed

The public canonical domain remains `https://maacash.bloomcoretech.com`. No DNS, Turnstile, Render or domain configuration was changed.

---

## G. Remaining limitations

1. The owner's production account, tenant, Collector record, enrollment rows and device could not be inspected because no authorized read-only access to the production database was provided. The reported symptoms are fully explained by the reproduced code path, but the owner's exact row values are not independently recorded here.
2. No production browser session or production credentials were used. Verification used the repository's isolated SQLite E2E database and dual-role test account.
3. The PostgreSQL idempotency suite was not run because no disposable PostgreSQL target was configured.
4. Nothing was merged or deployed. Approval and CI must complete before release.
5. IndexedDB and service-worker data are origin-scoped. Records created on `maacash.onrender.com` do not move to `maacash.bloomcoretech.com`; this fix does not and must not create a new database to bridge origins.
6. The fix preserves every prepared context and queued record, but it cannot recover records that a user already deleted or that exist only under a different browser origin/profile.
