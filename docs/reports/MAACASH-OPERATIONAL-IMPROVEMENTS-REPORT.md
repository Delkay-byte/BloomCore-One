# MaaCash Operational Improvements — Implementation Report

> **Superseded for release evidence by
> `docs/reports/MAACASH-AIRTIME-ACTIVITY-OFFLINE-RELEASE-REPORT.md`.**
> This file records the local implementation snapshot taken before the release
> gates, PostgreSQL rehearsal and production deployment were completed.

Date: 9 November 2026
Repository: `Delkay-byte/BloomCore-One`
Working branch: `feat/maacash-expenses-dual-role-switch`

## 1. Airtime Sold

- Added **Airtime Sold (GH₵)** to the agent's MoMo daily closing form with the
  helper text: "Enter the total value of airtime sold today."
- Stored in the existing `DailyAccount.totalAirtimeSold` column. No new column
  was required for airtime and historical values are unchanged.
- Server-side validation requires zero or a positive amount with at most two
  decimal places. A malformed value is rejected, not silently converted to zero.
- Draft persistence now includes the airtime value, and older drafts restore
  without zeroing server values they do not contain.
- Displayed in the live summary, submitted read-only closing, admin daily
  review, MoMo history, and admin correction screen.
- The expected-closing formula is unchanged:
  `Opening Total + Commission + Debts Collected − Total Expenses`.
  Airtime Sold never enters that calculation.
- The admin review screen now separates expected handover from actual receipt.
  `confirmDailyHandover` records the actual amount, discrepancy, explanation,
  confirmer and timestamp. A mismatch requires an explanation and is never
  silently approved.
- Additive migration: `prisma/migrations/20261109_momo_airtime_handover`.

## 2. Activity History

- Added a safe presentation layer in `src/lib/audit-presentation.ts`.
- Technical entity names are normalised: `daily_account` and `dailyAccount`
  both display as **Daily Account**; `device`, `contribution` and `user` map to
  **Device**, **Contribution** and **User**.
- Related records show business references such as
  **Daily Closing — 9 November 2026**, customer names, collector names and
  location names instead of truncated database ids.
- The Details column now produces plain descriptions from the stored action and
  data, for example:
  - "Switched dashboard from MoMo to Susu Collector."
  - "Updated a daily closing for 9 November 2026. Expenses: GH₵15.00."
  - "Registered a device for offline use (Susu Collector)."
- Unknown actions show: "Activity recorded — additional details unavailable."
- A **View** action opens readable details. Raw metadata remains available only
  in a secondary technical section; passwords, tokens, hashes, OTPs and secrets
  are filtered out.
- Desktop uses a table; mobile uses stacked cards, so columns are not clipped and
  horizontal guessing is not required.
- The audit row itself is not rewritten. User attribution, timestamps, tenant
  scope and permissions remain unchanged.

## 3. Offline Collectors

- Added device-level preparation state in
  `src/lib/offline/device-store.ts`. It stores non-secret identity, authorized
  modules, device ids and timestamps. It does not store passwords, JWTs, refresh
  tokens or session handles.
- Normal online use now prepares the device automatically:
  - validates the authenticated session;
  - enrolls each authorized module;
  - downloads the collector's authorized customer snapshot;
  - warms the application shell and static assets;
  - only then marks the device **Offline Ready**.
- The existing tab-session service worker now caches navigation responses and
  static assets. Page caches are namespaced by `tenant:user`; static assets are
  shared because they contain no user data.
- **Enable Offline** no longer calls the server. It checks the prepared context,
  the authorization window and the cached app screen, then activates locally.
- `/login` is cached during preparation. A previously prepared device can open
  an authorized dashboard while already offline without entering credentials.
  A never-prepared device is told that initial online setup is required.
- Dual-role users prepare both authorized modules where data and cache checks
  pass. `WorkspaceSwitcher` switches locally while offline after validating the
  destination module. On reconnection, `OfflineSessionGuard` re-verifies the
  server session and uses the existing `switchWorkspace` action when the tab is
  still on the other module's session.
- Offline contributions remain **Saved on Device — Not Yet Synced** until the
  server confirms them. The existing stable idempotency keys, atomic queue
  claim, partial-sync preservation and server authorization checks are retained.
- Server-side sync accepts a MoMo session for a Susu offline record only when the
  same user and tenant are proven authorized for Susu. The browser cannot select
  a role.
- A server-revoked device blocks the affected module while preserving
  unsynchronized records. Expired authorization also stops protected offline
  operations and keeps the queue.
- Sign-out clears the current offline-session pointer and cached pages, but keeps
  unsynchronized records in the user's scoped database.

## 4. Regression Evidence

Executed:

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 71 files, 713 tests passed |
| `npm run build` | Passed |
| `npm run lint` | 0 errors, 71 existing warnings |
| `node --check public/tab-session-sw.js` | Passed |
| `npx prisma validate` (SQLite and PostgreSQL schemas) | Passed |

Two intermediate full-suite runs hit 5-second SQLite timeouts under local I/O
load. The affected tests passed in isolation and the final full run passed. This
was an environment timing issue, not a reproducible assertion failure.

Not executed in this environment:

- PostgreSQL test suite: `PG_DATABASE_URL` is not configured and `psql` is not
  installed.
- Real Android device tests.
- Production deployment or production verification.

## 5. Deployment

No commit, push, pull request, migration deployment or production change was
performed in this environment.

Required before production:

1. Back up PostgreSQL.
2. Apply `20261109_momo_airtime_handover` with `prisma migrate deploy`.
3. Run the PostgreSQL suite against a non-production database.
4. Complete Android offline scenarios A–H and addendum A–G on a real device.
5. Deploy and verify on `https://maacash.bloomcoretech.com`, including the
   fallback Render URL.
