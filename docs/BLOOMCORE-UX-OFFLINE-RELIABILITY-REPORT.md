# BloomCore One — UX, Offline Reliability and Security Delivery Report

**Branch:** `feat/bloomcore-ux-offline-reliability`
**Starting commit:** `0a5ba96` (`main`, verified equal to `origin/main`)
**Production modified:** No. No production deployment, migration or data change was performed.
**Environment:** Windows development workspace; isolated SQLite test database; isolated PostgreSQL 16 container for integration tests.

## 1. Repository

| Item | Value |
|---|---|
| Starting commit | `0a5ba96` |
| Branch created | `feat/bloomcore-ux-offline-reliability` |
| UX commit | `27d9e49` — skeleton loading, autofill, drafts, optimistic feedback, friendly errors |
| Offline commit | `c000d61` — preserve pending records, harden synchronization |
| Security/documentation commit | this report and the files listed below |
| Final commit | branch head after the report commit |
| Schema changes | None; no migration is required |
| Dependencies added | None |

The working tree was clean at `0a5ba96`. The branch contains only application, test and documentation changes; no production secret or environment file is committed.

## 2. UX improvements

### 2.1 Skeleton loading

- Shared primitives in `src/components/ui/Skeletons.tsx`: page, dashboard, table, form, detail, list, chart, stat-card and card-list skeletons.
- `SkeletonPage` owns one `role="status"`, `aria-busy` and screen-reader announcement; nested shapes are `aria-hidden`.
- Pulse animation is disabled by the existing `prefers-reduced-motion` rule.
- Applied to admin dashboard/staff/workers/locations/reports/audit/history, Susu admin customers/collectors/contributions/withdrawals/history/remittances/reports, collector dashboard, all customer portal screens, worker daily account and settings.
- Route-level `loading.tsx` added for admin, Susu admin, collector, customer portal, worker, platform console and settings.
- Single actions keep local button spinners. Content loaders no longer replace the page with a central spinner. Background refreshes keep existing content.

### 2.2 Autofill and prefill

- Identity, contact and credential fields use `name`, `email`, `tel`, `street-address`, `organization`, `username`, `current-password`, `new-password` and `one-time-code`.
- Financial amount inputs use `autocomplete="off"`; amounts are never reused from browser history.
- Existing authenticated context is used for safe defaults (for example “Recorded By” is the signed-in staff member and remains changeable).
- Prefilled values stay editable; the server revalidates every tenant, role and financial rule.

### 2.3 Immediate feedback and optimistic UI

- Toast notifications are used for safe mutations (staff/location/worker status, password changes).
- `useOptimisticAction` applies a reversible change immediately, keeps it on server success, rolls it back on rejection or error, and ignores a second click while one request is in flight.
- Financial actions remain server-confirmed. Offline collections say “Saved on this device. Waiting to synchronize; not yet in the ledger.” A server rejection online is shown as an error and is never queued as if it were pending.
- Contribution and withdrawal forms keep one stable idempotency key across retries and reuse it offline.

### 2.4 Draft saving and restoration

- `src/lib/offline/drafts.ts`: tenant/user-scoped IndexedDB drafts, schema version 2, seven-day expiry and cleanup.
- `useFormDraft` (uncontrolled forms) and `useObjectDraft` (controlled/multi-step forms) save after ~700 ms, restore with a visible notice, support discard, and clear on confirmed submission.
- Secret-looking fields are stripped; password inputs are excluded entirely.
- Wired forms: Susu customer creation, staff/worker/collector creation, location creation, office contributions, withdrawals and the five-step worker daily account (current step and values).
- A restored draft is never auto-submitted. A draft older than the loaded server record is not applied and shows a conflict notice.

### 2.5 Friendly errors and retry

- `src/lib/errors/friendly.ts` maps network, timeout, session, permission, validation, duplicate, conflict, not-found, rate-limit, storage and server failures to short actionable text.
- Internal SQL, Prisma, stack, path and framework text is discarded.
- Branded error boundaries added to the root and to admin, Susu admin, collector, customer, worker and platform segments. `ErrorView` uses Next.js 16 `retry()` and keeps a clear route back.
- Existing 404 semantics remain; missing records are not disguised as successful pages.
- Retry controls preserve form state; financial retries reuse the stored key.

## 3. Offline financial-data protection

- Sign-out no longer deletes any offline database. `syncBeforeSignOut()` attempts the queue, prunes only acknowledged records older than seven days, closes connections and clears the in-memory scope.
- Pending and failed records stay in `bik-prestige-offline:v2:<tenantId>:<userId>`. A different account opens a different database; the same user reopens theirs after authenticating again.
- Explicit deletion lives only in Settings → Offline records. It requires the phrase `DELETE OFFLINE DATA` and a separate acknowledgement when pending records exist. It targets only the signed-in user's current tenant/user database.
- A fresh login clears any in-memory scope, so a new session cannot inherit the previous account's queue.
- No database is merged across users or tenants; sync always uses the current session's server-resolved scope and the server re-checks device, user, tenant, account, assignment and cycle.
- Synchronization: atomic IndexedDB claim per record, Web Lock across tabs, module-flag fallback, stale-claim recovery after five minutes, FIFO order, partial-batch preservation, 401 stops the batch without burning retries, 429 honours `Retry-After` and sets a client cooldown.
- Idempotency: one key per operation, stored with the record and reused on every retry. The server reserves the key before posting and reconciles a unique `Contribution.referenceId` collision to the existing posting instead of creating a second entry.
- Queue visibility: pending, syncing, synced and failed counts, failure reasons, last confirmed sync time, retry control, near-quota warning.
- Quota and storage failures become `OfflineStorageError` and the collect flow refuses to claim success.
- IndexedDB is not described as encrypted. The UI warns that clearing browser site data permanently removes unsynchronized records.

**Known limitation:** offline posting is implemented for Susu collector contributions. MoMo daily accounts use server/local drafts, not an offline financial queue.

## 4. Security work

| Item | Result |
|---|---|
| Remittance / daily-account reversal | **Assessed, not implemented.** Both record types lack compensating-entry semantics; a negative row would corrupt derived cash positions and the daily account has a per-location/date uniqueness rule. Proposal with exact blockers in `docs/security/FINDINGS-REGISTER-2026-11.md` §4. Withdrawal and contribution reversals remain intact. |
| CSP nonce | **Assessed, not applied.** Nonces force every page (including static marketing pages) to dynamic rendering and require inline-style/Turnstile work. `'unsafe-inline'` remains documented; `'unsafe-eval'` was removed from production. `docs/security/CSP-ASSESSMENT.md`. |
| HTTP 429 | **API surface fixed.** `POST /api/offline/sync-contribution` is limited to 120 records/minute per user and returns literal 429 + `Retry-After`. Login/recovery/MFA remain server actions with structured refusals; limitation stated in `docs/security/HTTP-429-AND-RATE-LIMITS.md`. |
| Prisma / dependency audit | 3 high findings remain in production dependencies: `prisma → @prisma/config → deepmerge-ts <8`, CLI-only, not reachable from request handling. Fix requires Prisma 7 and was not attempted. Full audit also reports dev-tool findings in Vite/Vitest/launch-editor. Recorded as accepted. |
| Environment hygiene | `.env.pilot` removed from Git; `.env.pilot.example` added; `.env.pilot` ignored. History review found placeholders only; no live credential or rotation required. |
| Internal assessment | New findings register `docs/security/FINDINGS-REGISTER-2026-11.md`, including fixed, accepted and open items and prior-finding status. |
| DAST | Unauthenticated OWASP ZAP baseline against a local production build: **0 FAIL, 7 WARN, 61 PASS**. Warnings are CSP `unsafe-inline`, scanner-injected URL fields, validated role enum, redirect Content-Type, `no-store`, client routing and optional COEP. Report: `docs/security/dast/`. |
| External penetration test | **Not performed.** Scope, staging target and accounts prepared in `docs/security/PENTEST-READINESS.md`. No certification is claimed. |

## 5. Test and check results (executed)

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass — 0 errors, 71 warnings (mostly pre-existing) |
| `npm test` (`vitest run`) | **27 files, 328 tests passed** |
| PostgreSQL integration (`vitest --config vitest.pg.config.ts`, isolated PostgreSQL 16) | **3 files, 25 tests passed** |
| `npm run build` | Pass — 65/65 pages generated |
| `npm audit --audit-level=critical` | No critical finding |
| `npm audit --omit=dev` | 3 high (Prisma CLI `deepmerge-ts` path), accepted |
| OWASP ZAP baseline | 0 FAIL / 7 WARN / 61 PASS |

New tests cover skeleton structure and reduced motion, autocomplete and financial-amount protection, optimistic success/rejection/network rollback, friendly error mapping and sanitisation, draft scoping/expiry/secret stripping/conflict handling, sign-out preservation, explicit discard, queue claim/concurrency, retries, 401/429, partial batches, storage quota mapping, cross-user key reuse, HTTP 429 contract and PostgreSQL idempotency.

## 6. Deployment readiness

- **Safe to review and merge.** No schema migration and no new dependency.
- Deploying the branch does not change production until a separately authorised release is performed.
- Offline behaviour change takes effect on first load after deployment: sign-out preserves local records. Support staff should know that clearing site data remains destructive.
- Existing sessions, MFA enforcement, Turnstile, tenant isolation and financial validation are unchanged.
- Rollback: revert the branch; no database rollback is required. Locally queued records created by the new build remain readable by the older build because the database version was raised to 2 (the older build would need the same version bump to open it).

## 7. Explicit statements

- No independent penetration test was performed.
- No OWASP certification or formal compliance is claimed.
- No destructive test or high-volume scan was run against production.
- No production data, secret or service was modified.

## 8. Corrective review — offline integrity and cross-tab isolation

This section records the follow-up pass after the first UX/offline review. No
schema change or dependency change was required.

### 8.1 Payload-bound idempotency

- `src/lib/offline/payload.ts` validates and canonicalizes a contribution
  (fixed key order, explicit null optionals, trimmed notes) and computes a
  SHA-256 digest.
- The sync route normalizes the request before consulting the stored key, then
  compares the digest for every state: `pending_sync`, `syncing`, `failed` and
  `synced`.
- A changed amount, account, channel, notes or collector returns HTTP 409. A
  completed result is returned only for the exact original instruction.
- Ownership checks (tenant, user, device) still run before the payload compare.
- A concurrent identical request that loses the unique-key race re-reads the
  reserved row and continues only when owner and digest match. The unique
  `Contribution.referenceId` still guarantees one posting.
- Existing rows that stored raw client JSON normalize to the same digest, so no
  data migration or nullable column was needed.

### 8.2 Deletion fails closed

- Unresolved means `pending_sync` + `syncing` + `failed`.
- A `syncing` record blocks deletion even with loss acknowledgement.
- A queue read error blocks deletion; it is never treated as zero.
- `deleteDatabase()` rejects on `onblocked`; the UI reports that deletion did
  not complete and asks the user to close other tabs.
- Only the authenticated tenant/user database is targeted.
- Sign-out still preserves every unresolved record.

### 8.3 Cross-tab account isolation

- Login/logout broadcast `{ type: "session-changed" }` on
  `BroadcastChannel("bloomcore-one-session-v1")`. No identity data is sent.
- Receiving tabs close IndexedDB connections and the in-memory scope, then
  revalidate `/api/auth/me` for their module and compare the server `userId`
  with the identity verified for that tab.
- A changed identity clears the per-tab session and leaves the page before any
  cached customer, draft or pending transaction can render.
- Revalidation failure (including offline) fails closed with a "Session check
  required" panel; content is hidden until the server confirms.
- Focus/visibility and a 60-second interval cover browsers without
  BroadcastChannel or a missed signal. sessionStorage storage events are not
  used for cross-tab signalling.

### 8.4 Two-tab browser verification

Performed against a local build with two collector accounts (A and B) in one
browser, sharing the collector cookie:

1. Tab 1 signed in as A and loaded the collector dashboard; a pending offline
   record was created in A's scoped IndexedDB database.
2. Tab 2 signed in as B on the same origin, replacing the shared cookie and
   broadcasting the signal.
3. Tab 1 cleared its identity/flag, left the dashboard and did not render A's
   data. A's database still existed with the pending record; B's separate
   database was empty.
4. Tab 1 signed in as A again and verified the A identity; A's queue remained
   intact. Tab 2 was invalidated symmetrically when A replaced the cookie.
5. Offline transition: with `/api/auth/me` made unreachable, a session signal
   caused Tab 1 to show "Session check required", close offline access and hide
   dashboard content. Restoring connectivity and choosing "Check again"
   returned the verified same-user dashboard.

Browser limits are documented in `docs/OFFLINE-RELIABILITY.md` §8: cookie changes
made outside the application are detected on the next focus/interval check, and
same-origin developer tools can still open IndexedDB directly. The guard
protects the application UI and sync path, not a compromised device.

### 8.5 Added tests

- `tests/offline-payload.test.ts` — canonical ordering, optional-field
  normalization, digest differences, legacy JSON, invalid payloads, key format.
- `tests/cross-tab-session.test.ts` — identity transitions, BroadcastChannel
  use, no storage-event dependency, non-sensitive signal, sign-out safety.
- `tests/offline-isolation.test.ts` — failed/syncing/deletion blocks, unreadable
  queue, blocked delete, scoped deletion, sign-out preservation of all
  unresolved states.
- `tests/pg-offline-idempotency.test.ts` — PostgreSQL: same payload + synced,
  changed amount/account/channel, changed payload before posting, timeout
  reconcile, cross-tenant key, reordered JSON, concurrent identical posts, 429.
