# MaaCash — Airtime, Activity History and Offline Release Report

Date: 9 November 2026
Release branch: `release/maacash-airtime-activity-offline`
Target: `main` → Render `maacash` (`srv-dbnaciff3r2c7382tjgg`)
Release commit: `eba3bbb3d4bc2bfbd2914989560fed9224b4e73f`
Merge commit: `5c3888b988c754b8ae414586815f88ea8845800e`
Status: application and database deployed; authenticated production acceptance
blocked by absent production test credentials; physical Android acceptance
blocked by absent hardware.

## A. Implementation

### Airtime Sold and physical handover

| File | Change |
|---|---|
| `src/app/worker/daily/[id]/page.tsx` | Airtime Sold field, draft persistence, live summary, submitted read-only display |
| `src/lib/actions/daily-account.actions.ts` | Server-side airtime validation, persistence, correction preservation and separate `confirmDailyHandover` action |
| `src/lib/validations.ts` | Two-decimal airtime validation after normal money validation |
| `src/app/admin/(workspace)/reports/[id]/page.tsx` | Admin airtime display, expected handover, actual receipt, discrepancy and confirmation |
| `src/app/admin/(workspace)/history/[id]/correct/CorrectionForm.tsx` | Airtime preserved and editable during corrections |
| `prisma/schema.prisma`, `prisma/schema-pg.prisma` | Nullable handover fields; no duplicate airtime field |
| `prisma/migrations/20261109_momo_airtime_handover/migration.sql` | Additive handover columns only |
| `tests/maacash-operational-improvements.test.ts` | Zero/positive airtime, formula isolation, precision rejection, handover transition and audit |
| `tests/pg-maacash-operational.test.ts` | PostgreSQL persistence and formula isolation |

Financial invariant preserved:
`Opening Total + Commission + Debts Collected − Total Expenses`.
Airtime Sold is operational only. It is never added to cash, E-cash, profit,
reconciliation difference or expected handover.

### Activity History

| File | Change |
|---|---|
| `src/lib/audit-presentation.ts` | Entity normalisation, action labels, plain descriptions, sensitive-key filtering and unknown-event fallback |
| `src/app/api/audit/route.ts` | Tenant-scoped batch resolution of business references; stored audit rows returned unchanged |
| `src/app/admin/(workspace)/audit/page.tsx` | Desktop table, mobile cards, readable details modal and secondary technical metadata |
| `tests/audit-presentation.test.ts` | Label normalisation, JSON translation, fallback, secret filtering and reference display |

### Offline readiness, offline login and dual-role switching

| File | Change |
|---|---|
| `src/lib/offline/device-store.ts` | Durable non-secret device preparation context, expiry, activation and revocation state |
| `src/lib/offline/preparation.ts` | Online preparation, authorized module enrollment, customer snapshot, shell warming, local activation and readiness |
| `src/lib/offline/scope.ts` | Local persisted scope fallback after a network failure; real 401/403 still fails closed |
| `src/lib/offline/session.ts` | Readiness-aware status, sign-out clearing and record preservation |
| `src/lib/offline/sync.ts` | Server authorization reconciliation and last-sync state |
| `src/app/api/offline/enroll/route.ts` | Revocation is authoritative; enrollment cannot bypass it |
| `src/app/api/offline/sync-contribution/route.ts` | Server-verified dual-role session fallback; renewed authorization timestamp |
| `public/tab-session-sw.js` | Scoped page cache, static cache, offline navigation fallback, warmed-route caching and logout cache clearing |
| `src/components/OfflineBootstrap.tsx` | Automatic background preparation during online use |
| `src/components/OfflineSessionPrompt.tsx` | Offline restoration before the login form, only for previously prepared modules |
| `src/components/OfflineSessionGuard.tsx` | Cached-page guard, expiry/revocation denial and server session reconciliation |
| `src/components/WorkspaceSwitcher.tsx` | Local dual-role switch only for prepared modules |
| `src/components/OfflineSyncStatus.tsx` | Readiness, active, saved-on-device, syncing, synced, failed, expired and revoked states |
| `src/components/ConfirmSignOutButton.tsx` | Clears cached pages and local session pointer without deleting unsynced records |
| `tests/offline-preparation.test.ts` | Persistence, local activation without fetch, expiry, revocation, dual-role contexts and sign-out retention |
| `e2e/mobile.spec.ts` | Android-sized prepare → reload offline → restore cached session flow |

Security boundaries retained: server session validation, tab-scoped credentials,
tenant isolation, collector/device authorization, idempotency keys, atomic queue
claims and audit attribution.

### Release engineering

| File | Change |
|---|---|
| `scripts/prepare-deploy.mjs` | Removed `db push` fallback; PostgreSQL-only; migrate deploy/status failure stops release |
| `.github/workflows/ci.yml` | Separate SQLite, PostgreSQL rehearsal/integration and mobile browser jobs |
| `tests/pg-safety.ts` | Fail-closed disposable PostgreSQL target guard |
| `tests/release-safety.test.ts` | Prevents db-push fallback regression and missing CI gates |
| `prisma/migrations/20261109_zeli_team_tester_reconciliation/migration.sql` | Forward migration for real schema drift found during fresh rehearsal |
| `PRODUCTION-RELEASE-RUNBOOK.md`, `docs/NEON-RENDER-DEPLOYMENT.md` | Current production service, domain, migration and rollback procedure |

## B. Test Results

| Test | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm run typecheck`, exit 0 |
| Lint | PASS | `npm run lint`, 0 errors, 69 warnings |
| SQLite tests | PASS | 72 files, 721 tests |
| PostgreSQL integration tests | PASS | 7 files, 35 tests against disposable PostgreSQL 16 |
| PostgreSQL migration rehearsal | PASS | Fresh database: 29 migrations, status up to date, `prisma migrate diff` empty |
| Build | PASS | `npm run build` |
| Browser/mobile tests | PASS | 3 Playwright Pixel 7 tests, including offline prepare/reload/restore |
| Real Android acceptance | BLOCKED | `adb` unavailable; no physical device or emulator attached |
| Service worker syntax | PASS | `node --check public/tab-session-sw.js` |
| Prisma schema validation | PASS | SQLite and PostgreSQL schemas |
| GitHub CI | PASS | SQLite, PostgreSQL and mobile-browser jobs |
| Production health/readiness | PASS | `maacash`, `maacash.onrender.com`, `bloomcore-one.onrender.com` |
| Production authenticated workflows | BLOCKED | no authorized production test identity/credential provided |

The fresh PostgreSQL rehearsal initially exposed a real drift: `ZeliTeamTester`
was absent from migration history. The forward reconciliation migration fixed
it, and the full fresh chain then reported no difference.

## C. Git and PR

- Release branch: `release/maacash-airtime-activity-offline`
- Commit SHA: `eba3bbb3d4bc2bfbd2914989560fed9224b4e73f`
- PR: [#30](https://github.com/Delkay-byte/BloomCore-One/pull/30) (release),
  [#31](https://github.com/Delkay-byte/BloomCore-One/pull/31) (evidence)
- Review status: no independent reviewer identity was available; `main` has no
  branch protection or required review rule. The work was not represented as
  independently reviewed.
- CI status: PASS — SQLite, PostgreSQL rehearsal/integration and mobile browser
  on both pull requests
- Merge commits: `5c3888b988c754b8ae414586815f88ea8845800e` (application),
  `7a978824b2433a36e5c1e921950c955356b7c448` (evidence documentation)

## D. Database

- Migration names: `20261109_momo_airtime_handover`,
  `20261109_zeli_team_tester_reconciliation`
- Rehearsal: PASS on disposable PostgreSQL 16, 29 migrations, no drift
- Production migration: APPLIED both migrations; 29/29 recorded as finished
- Schema drift after production migration: none (`prisma migrate diff` empty)
- Backup: `pg_dump --format=custom`, 313,115 bytes, 444 TOC entries, verified
  with `pg_restore --list`; SHA-256
  `3F55FE5249D6DA024B32F99A623E5C8A0CE3C3DBE6C84F825ADD676E80450690`
- Recovery limitation: no Neon API key was available, so the verified custom
  dump is the recovery artifact rather than a Neon branch.

Production pre-migration read-only check: 27/29 migrations applied; only
`20261109_momo_airtime_handover` and
`20261109_zeli_team_tester_reconciliation` were pending. `totalAirtimeSold`
already existed in production.

Pre/post financial row counts were identical: DailyAccount 10, Expense 5,
Contribution 2, ContributionAllocation 4, Withdrawal 0, Commission 0, CardFee 3,
CollectorRemittance 1, Customer 3, SusuAccount 3, SusuCycle 3,
OfflineTransaction 0, DeviceEnrollment 2, AuditLog 151, BusinessTenant 2,
User 12. Migration rows moved from 27 to 29.

## E. Deployment

- Render service: `maacash` — `srv-dbnaciff3r2c7382tjgg`
- Primary URL: `https://maacash.bloomcoretech.com`
- Fallback service: `bloomcore-one` — `srv-dbjalrk9v7es739ifkp0`
- Deployment identifiers: `dep-dbp0cpbl550s73eokgh0` (maacash),
  `dep-dbp0eop5efls73cjrur0` (bloomcore-one, live after the auto-deploy refresh)
- Deployed commit SHA: `5c3888b988c754b8ae414586815f88ea8845800e` on both
- Deployment outcome: LIVE on both services
- Health endpoint: `status=ok`, commit `5c3888b…` on all three hosts
- Readiness endpoint: HTTP 200, `database=ok` on all three hosts
- Public route smoke: `/login` and `/admin/login` HTTP 200; protected
  `/worker/dashboard`, `/collector/dashboard` and `/admin/audit` redirect 307 to
  `/login`
- Unauthenticated API smoke: `/api/audit` 403; `/api/admin/devices`,
  `/api/offline/enroll` and `/api/auth/me` 401

## F. Acceptance

- Airtime form persistence/validation: automated PASS.
- Airtime formula isolation: unit and PostgreSQL PASS.
- Handover separation and audit: unit PASS.
- Activity History readable labels, fallback and secret filtering: unit PASS.
- Offline preparation, local activation, cached offline reload and offline
  login restoration: Playwright PASS.
- Dual-role switching limits: unit and browser PASS.
- Production deployment, migration, health and readiness: PASS.
- Production authenticated login, MoMo form, Activity History screen and device
  administration: BLOCKED. The production database contains no staging test
  identities; no authorized production password was supplied, and no real user
  password was reset or altered.
- Real Android lifecycle, physical device revocation and field synchronization:
  BLOCKED until hardware is available.

## Known limitations

1. A disconnected device cannot learn about a remote revocation until it next
   reaches the server. Local expiry still applies, synchronization is rejected,
   and unsynchronized records are preserved.
2. IndexedDB is ordinary browser storage. It is tenant/user-scoped and minimized,
   but not encrypted against a person who controls the unlocked device.
3. Real Android acceptance remains outstanding; Playwright is not a substitute.
4. Authenticated production acceptance remains blocked until an authorized
   production test identity is supplied or the owner performs the documented
   manual checks.
5. Remote device revocation cannot take effect while a device is disconnected;
   it is enforced on the next server contact, with local expiry still applied.
