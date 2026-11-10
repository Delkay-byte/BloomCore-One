# MaaCash Collector Offline Context Fix — Diagnostic Report

Date: 10 November 2026

Branch: `fix/maacash-collector-offline-context`
Base: `origin/main` (`12cfaa7`)
Fix commit: `ca426e70571f889b7a6a4b111dc87163b328076d`
Hardening commit: `fbc6961267d0fa8a2582e206b1ce4a0e8919e807`
Pull request: https://github.com/Delkay-byte/BloomCore-One/pull/37
Approval: technical APPROVE; no independent GitHub reviewer
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
| `src/app/api/auth/me/route.ts` | Neutral lookup now resolves and returns the module that actually authenticated the tab. Tenant resolution uses that module, never the primary role. Staff modules are resolved with `requiredModule` so tenant entitlement is authoritative. Unknown explicit modules return 400. A module answer must include the requested module. Response includes `module`. |
| `src/lib/auth.ts` | Added `getAnyModuleSession()`, which returns the session together with its module so callers can use the correct authorization scope. |
| `src/lib/offline/active-module.ts` | New pure helper mapping `/collector` → `susu`, `/worker` → `momo`, `/admin` → `admin`, `/customer` → `customer`. Used as a request routing hint only; the server still verifies the credential. |
| `src/lib/offline/preparation.ts` | `prepareOfflineAccess(module?)` requests `/api/auth/me?module=<workspace>`, requires the exact response module, and requires the requested staff module to be authorized before saving a context. Preparation is serialized per requested workspace so an in-flight MoMo preparation is never returned to a Susu caller. Failure paths still leave the previous context and queue untouched. |
| `src/lib/offline/scope.ts` | Module-aware `getOfflineScope(module?)`; distinct `OfflineScopeError` codes (`unauthenticated`, `no_tenant`, `module_mismatch`, `network`, `timeout`, `offline_expired`, `unavailable`). A requested module must be present and match in the server answer. Cached prepared context is used only for a genuine network/timeout path, only while unexpired, and only for a module the context supports. Scope source is tracked (`server`, `prepared`, `seeded`) and both the cache and in-flight resolution are keyed by module. Explicit 401/403 and HTTP 200 with no tenant always fail closed. |
| `src/lib/offline/session.ts` | `getOfflineStatus(module?)` reads the same workspace scope as the dashboard. Adds `scope` state including source, resolves scope once, and never reports an unreadable/unauthorized scope as an empty queue. |
| `src/components/OfflineSyncStatus.tsx` | Accepts a `module` prop, passes it to status and preparation, shows a truthful per-code error, adds a safe retry that does not delete data, refuses a green success tone when identity or queue checks fail, and labels preparation time separately from successful synchronization. Includes one bounded automatic retry for a cold service-worker attach race. |
| `src/components/OfflineBootstrap.tsx` | Infers the active workspace module, requests `/api/auth/me?module=...`, verifies the returned module and prepares that workspace instead of using a neutral lookup. |
| `src/app/collector/(workspace)/dashboard/CollectorDashboardClient.tsx` | Seeds the offline scope from the server-resolved `userId` and `tenantId` produced by `requireTenantCollector()`. Passes `susu` to preparation and to `OfflineSyncStatus`. |
| `tests/auth-me-module-resolution.test.ts` | New API module-resolution regression tests. |
| `tests/offline-module-scope.test.ts` | New offline scope, scope-failure taxonomy, queue preservation and preparation tests. |
| `e2e/maacash-dual-role-switch.spec.ts` | Extended real-browser dual-role switch test with Susu/MoMo identity, tenant, offline panel and queue assertions in both directions. |
| `docs/OFFLINE-RELIABILITY.md` | Corrected the sign-out/account-switch wording and removed the false cross-tab `session-changed` claim; documented the shared-profile limitation. |
| `docs/security/OFFLINE-DEVICE-POLICY.md` | New temporary dedicated-device operational policy for offline-enabled devices. |
| `docs/reports/MAACASH-COLLECTOR-OFFLINE-CONTEXT-FIX-REPORT.md` | Final evidence, security assessment, test reconciliation and release record. |

No database schema, migration, entitlement, collector record, device enrollment or service-worker cache format was changed.

### Review findings and corrections

- The neutral module lookup originally derived the tenant module from `User.role`. Fixed to use the module that authenticated the tab.
- Offline preparation and scope were module-neutral. Fixed to request and require the active workspace module.
- `scope.ts` collapsed every failure into an unreadable queue. Fixed with distinct failure codes and fail-closed 401/403/no-tenant/module-mismatch handling.
- A server-rendered seeded scope could be described as a freshly verified online session. Fixed by tracking scope source and using accurate panel wording.
- A requested module answer with a missing `module` field could pass. Fixed to require the exact module.
- `/api/auth/me` did not require staff module entitlement. Fixed with `requiredModule`.
- An in-flight preparation could be shared across modules. Fixed by serializing per requested workspace.
- The queue panel could show a green readiness state or a preparation timestamp as a successful sync while identity/queue checks failed. Fixed.
- The collector seed happened after `getOrCreateDeviceId()`, which itself opens the scoped database. Fixed by seeding the verified scope before any IndexedDB access in the dashboard and preparation paths.
- The in-memory scope cache was global rather than module-keyed, so a seeded Susu scope could answer a MoMo request without module validation. Fixed with a module-keyed cache and pending map.
- A failed `navigator.storage.estimate()` call could blank a readable queue status. Fixed by isolating the estimate failure.
- `docs/OFFLINE-RELIABILITY.md` described a cross-tab `session-changed` guard that is not implemented. Corrected to describe actual behaviour and the shared-profile residual.
- No new blocking authentication, tenant-isolation or financial-integrity defect was found in the final diff.

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

## E. Test reconciliation

The authoritative result on the final implementation commit is **75 test files, 767 tests passed, 0 failed, 0 skipped**. It was reproduced twice on 10 November 2026 (18:58 and 19:01 local time) with `npm test` after dependency restore. Dependency restore note: plain `npm ci` is blocked on this Windows host because Visual Studio build tools are unavailable for the `better-sqlite3` native rebuild; `npm ci --ignore-scripts` plus `npm run db:generate` uses the package's shipped Windows prebuild. CI runs plain `npm ci` on Linux and passed.

The earlier counts were accurate for their commits:

| Commit | Tests | Why |
|---|---:|---|
| `ca426e7` | 762 | Initial PR body was written here. |
| `fbc6961` | 764 | Added `rejects an identity answer for a different workspace` and `rejects an identity answer that omits the workspace module`. |
| Final review commit | 767 | Added 403 coverage and two tests for module-keyed scope cache and seeded first-database access. |

No tests were skipped or removed; test discovery is unchanged.

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Passed, no errors |
| `npm run lint` | Passed, 0 errors, 70 warnings (none from the changed files) |
| `npm test` (run 1) | **75 files passed, 767 tests passed** |
| `npm test` (run 2) | **75 files passed, 767 tests passed** |
| `tests/auth-me-module-resolution.test.ts` | 9 tests passed |
| `tests/offline-module-scope.test.ts` | 21 tests passed |
| Targeted offline/session/tenant suites | 8 files passed |
| `npx playwright test e2e/maacash-dual-role-switch.spec.ts --project=chromium` | 3 tests passed |
| `npx playwright test e2e/mobile.spec.ts --project=mobile-chromium` | 3 tests passed |
| `npm run build` | Passed |
| PostgreSQL `pg-offline-idempotency` | Not run locally: no isolated `PG_DATABASE_URL`. The isolated CI PostgreSQL job passed. |
| CI on final code commit | Passed: SQLite/lint/typecheck/test/build, PostgreSQL integration and mobile browser suites |
| Fresh-context review | APPROVE after review corrections; no critical/high implementation defect. |

---

## F. Git and approval evidence

- Branch: `fix/maacash-collector-offline-context`
- PR head: `605af97563e6208390473a84d28be165efcb1bcf`
- Base / `origin/main`: `12cfaa7eebcff1998d909a035c754f45b298a18d`
- Fix commit: `ca426e70571f889b7a6a4b111dc87163b328076d`
- Hardening commit: `fbc6961267d0fa8a2582e206b1ce4a0e8919e807`
- Review-correction commit: `605af97563e6208390473a84d28be165efcb1bcf`
- PR URL: https://github.com/Delkay-byte/BloomCore-One/pull/37
- Latest CI: pending on `605af97` at report update time
- Formal GitHub approval: none. The repository's `main` branch is not protected and has no required reviewer. The PR author is the authenticated account; GitHub does not permit that account to formally approve its own PR, and no independent human reviewer has approved it. The agent's technical review decision is recorded separately in section H.
- Merge commit SHA: not merged at report time
- Deployment commit SHA: not deployed
- Production verification: not performed

The public canonical domain remains `https://maacash.bloomcoretech.com`. No DNS, Turnstile, Render or domain configuration was changed.

---

## G. Remaining limitations

1. The owner's production account, tenant, Collector record, enrollment rows and device could not be inspected because no authorized read-only access to the production database was provided. The reported symptoms are fully explained by the reproduced code path, but the owner's exact row values are not independently recorded here.
2. No production browser session or production credentials were used. Verification used the repository's isolated SQLite E2E database and dual-role test account.
3. The PostgreSQL suite could not be run locally because no disposable PostgreSQL target was configured; it ran and passed in CI's isolated job.
4. Nothing was merged or deployed. Approval and CI must complete before release.
5. IndexedDB and service-worker data are origin-scoped. Records created on `maacash.onrender.com` do not move to `maacash.bloomcoretech.com`; this fix does not and must not create a new database to bridge origins.
6. The fix preserves every prepared context and queued record, but it cannot recover records that a user already deleted or that exist only under a different browser origin/profile.
7. Pre-existing residual: during a genuine network failure, the scope may use the device's last prepared context, as before. That context is not cryptographically rebound to the current tab identity offline. Explicit sign-out clears it, but a session expiry or crash can leave it available to the next person using the same browser profile. This change does not widen that path; it now marks the scope as `prepared` instead of claiming a verified online session. Tracked in issue #38.

---

## H. Security assessment — offline device identity

### What the repository documents

- `OFFLINE-ARCHITECTURE.md` is a design target, explicitly marked partially implemented.
- `OFFLINE-SECURITY-THREAT-MODEL.md` is marked **DESIGN ONLY — Not implemented**. It lists a biometric/PIN gate and encrypted IndexedDB as required controls; neither is present in the current implementation.
- `docs/OFFLINE-RELIABILITY.md` describes the implemented behaviour and explicitly says IndexedDB is ordinary browser storage, not encrypted against someone who controls the device.
- `OfflineSessionPrompt.tsx` deliberately offers "Open ..." without a password or server connection when offline and a prepared context exists.
- No document defines whether devices are dedicated to one employee, whether phones are shared, or how a browser profile maps to a person.

### Device-sharing policy

**Undefined and not enforced.** There is no documented or technical control that prevents two people from using the same unlocked browser profile, or that identifies the authorized device owner beyond the prepared `userId`. The operational assumption is effectively "possession of the unlocked browser profile is the offline identity."

### Scenario assessment

| Scenario | Preconditions | Capability of another person | Exposure | Financial action | Server still blocks? | Policy | Severity |
|---|---|---|---|---|---|---|---|
| A. Dedicated device | One collector, locked device, same profile | None beyond device possession | Device-theft case only | Queueing under owner identity | Yes; sync revalidates | Supported | Low–Medium |
| B. Shared device after normal sign-out | A signs out normally | Cannot use app flow to open A's dashboard | A's queue persists in A's DB; app cache and current pointer cleared | None through app | Yes | Supported by sign-out behaviour | Low |
| C. Crash, then another person opens offline | A's browser crashes without sign-out; context unexpired; second person has the unlocked profile | Can open A's prepared dashboard, read cached customers and local queue, queue local records | Customer PII, contribution amounts, pending records | Can create local records under A's queue; cannot make server accept them without A's valid session and authorization | Yes for sync; local confidentiality lost | Undefined | **High on shared profile; Medium on dedicated device** |
| D. Session expiry while disconnected | Online session expired; offline authorization still valid | Same local access as C until 24h authorization expires | Cached PII and queue | Local queueing only; sync returns 401 | Yes | Partially documented (24h window) | Medium |
| E. Remote revocation while disconnected | Admin revokes device; device offline | Same local access until reconnect or 24h expiry | Cached PII and queue | Local queueing only; sync rejected after reconnect | Yes | Documented: remote revocation cannot reach an offline device | Medium |
| F. Dual-role switching | Same user, both modules prepared | No new person; same tenant/user queue | None beyond the same user's data | Same user's queue | Yes | Supported | Low |

### Finding

The residual is **not introduced by PR #37**. It is a pre-existing consequence of the passwordless offline restoration design. It becomes **High** only where a browser profile/device is shared without an OS lock or user separation. The repository neither requires nor enforces dedicated devices, so the assumption cannot be silently made.

Tracking issue: https://github.com/Delkay-byte/BloomCore-One/issues/38 — `security(maacash): bind offline access to the authorized device user`.

### Classification and owner decision

**HIGH (P1) security risk, kept separate from PR #37.** The repository does not define or enforce a dedicated-device policy, so this cannot be silently accepted.

The product owner has explicitly accepted this as a **temporary operational risk** on 10 November 2026, subject to the dedicated-device policy in `docs/security/OFFLINE-DEVICE-POLICY.md`:

- every offline-enabled device is assigned to one named, authorized employee;
- offline devices are not shared between MoMo agents, Susu collectors or other employees;
- device-level PIN/password/biometric lock with automatic inactivity locking is required;
- the employee signs out before transfer/reassignment and synchronizes pending records;
- devices that cannot comply must not be enabled for offline financial operations.

If dedicated-device use cannot be enforced operationally, offline access must be disabled on those devices until issue #38 is resolved. MaaCash offline access must not be described as safe for shared devices.

### Financial-operation boundary

A person who reaches a prepared offline dashboard can queue local records, but cannot put them in the official ledger without server authorization. `src/app/api/offline/sync-contribution/route.ts`:

- resolves the tenant from a Susu/admin/MoMo module session with `requiredModule: "susu"` (lines 58-72);
- rejects unauthenticated requests with 401;
- verifies an active `DeviceEnrollment` for the resolved `userId`, `tenantId` and `deviceId` (lines 96-117), returning 403 otherwise;
- enforces the 24-hour device authorization window (lines 119-137);
- validates the idempotency key and payload before any ledger action (lines 139-167);
- rejects cross-tenant accounts and assignments.

Local records are not treated as confirmed; a rejected sync marks the record failed and keeps its payload (`docs/OFFLINE-RELIABILITY.md` section 3). The local transaction is not deleted on server rejection.

Tracking issue: https://github.com/Delkay-byte/BloomCore-One/issues/38 — `security(maacash): protect offline sessions against shared-browser and device access`.

### Release relationship

- PR #37 fixes module/tenant resolution and does not widen the device-level fallback.
- No critical or high defect was found in the changed code itself.
- The owner has accepted the residual as a temporary risk under the dedicated-device policy. This is **not** a claim that the residual is resolved.
- Issue #38 remains P1 and must be completed before MaaCash offline access can be offered on shared devices.

---

## I. Release verification checklist

| Check | Status |
|---|---|
| Root cause identified | PASS |
| Test-count discrepancy resolved | PASS - 75 files / 767 tests on the final implementation commit |
| Full diff reviewed in a fresh context | PASS — APPROVE after review corrections |
| Module-aware session resolution reviewed | PASS |
| Offline queue/identity scope reviewed | PASS |
| Tenant and financial isolation reviewed | PASS |
| Device-sharing residual assessed | PASS — HIGH/P1, issue #38 |
| Critical release-blocking code finding | NONE FOUND |
| Latest CI on exact PR head | PASS — see section F |
| PR not draft, mergeable, up to date | PASS |
| Formal independent GitHub approval | NOT AVAILABLE — branch unprotected, author cannot self-approve |
| Agent technical approval decision | APPROVE |
| Owner risk decision on device-sharing assumption | ACCEPTED TEMPORARILY — dedicated-device policy |
| Merge | PENDING |
| Render deployment | PENDING |
| Production health | PENDING |
| Production readiness | PENDING |
| Authenticated collector verification | BLOCKED — no authorized production test identity provided |
