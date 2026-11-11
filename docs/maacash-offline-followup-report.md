# MaaCash Offline Follow-up — Investigation and Implementation Report

**Branch:** `security/maacash-offline-status-and-device-followup`
**Base:** `main` @ `57822d66ab8b2cb0e1d6945c8851c67523acfc73`
**Issue:** #38 (remains open)
**Status:** Code fixes implemented and unit-verified. Physical Android acceptance, authenticated
MaDave Enterprise acceptance, independent human review, PR merge and deployment are **not**
complete.

---

## A. Android test findings

### Owner-reported preliminary evidence

Recorded from the owner's physical test, not re-run by the agent:

- Offline passphrase setup succeeded.
- Browser tab closed and reopened.
- MaaCash requested the passphrase while Airplane Mode was enabled.
- Passphrase unlock succeeded.
- A Susu collection was accepted locally while the phone stayed offline.

Device model, Android version and browser/PWA mode are **not yet recorded**. They are the first
field in `docs/maacash-android-acceptance-checklist.md`.

### Agent reproduction

No physical Android device is available to the agent. Desktop reproduction was done through the
state model and automated tests. This is not equivalent to the owner's device results.

### Remaining manual tests

Every step in `docs/maacash-android-acceptance-checklist.md` that is not in the owner-reported
list above.

---

## B. Offline state and dashboard fixes

### Root cause: `Online` and `Offline Active` shown together

`getOfflineReadiness()` returned `status: "active"` whenever the persisted
`OfflinePreparedContext.active` flag was true. The flag was set on local activation and never
cleared when connectivity returned. The connectivity indicator came from `navigator.onLine`,
which correctly said Online, while readiness said Offline Active. Two independent dimensions
were rendered as if they described the same thing.

### Root cause: stale "You are working offline" after reconnect

Same persisted flag, plus no reconciliation on the `online` event. The dashboard refreshed a
connection indicator but did not deactivate the local offline session or recompute readiness.
The message came from the readiness object, so it stayed.

### Root cause: false "1 collection needs attention"

Two different counts were conflated:

1. `OfflineSyncStatus` counted `pending + failed` as "attention" for the retry button, while its
   red badge only showed `failed`.
2. `CollectorDashboardClient.handleSyncResults()` counted every `!result.success` as attention,
   including network failures, auth expiry, rate limiting and a locked workspace. It wrote a
   persistent page-level error. A transient network failure therefore produced
   "1 collection needs attention" while the queue simultaneously had no failed record and the
   Offline records panel correctly said "Synced. No unsynchronized offline records".

The queue itself was not stale. The message was derived from a one-shot sync result array, not
from records.

### Root cause: stale passphrase setup instruction

`prepareOfflineAccess()` returned a `requiresUnlockSetup` message. `OfflineSyncStatus` stored it
in local `notice` state and never cleared it when setup later succeeded. Readiness was also
recomputed without a change event from the unlock gate. The instruction was therefore a stale
local copy, not a missing unlock record.

### Root cause: conflicting queue/sync states

Pending records were described as "needs attention"; a retryable network failure that reached
the retry ceiling was stored as `failed` with no distinction from a server rejection; and
`navigator.onLine` was the only connectivity proof for retry.

### Final state model

`src/lib/offline/state.ts` now derives one display model from four independent inputs:

- Connection: online / offline / checking / server unreachable.
- Device: preparing / available / working offline / setup required / locked / expired / revoked.
- Workspace unlock: locked or unlocked.
- Queue: readable, waiting, synchronizing, confirmed, rejected.

Rules:

- Working offline requires a real network loss, a prepared workspace and an unlocked key.
- A pending record is waiting, never "needs attention".
- A retryable failure stays waiting and is requeued; reaching the retry ceiling does not turn it
  into a permanent rejection.
- Only a non-retryable server rejection raises the attention count.
- An unreadable queue is never rendered as zero or synced.
- Queue details are hidden while locked.

### Events that refresh state

`online`, `offline`, window focus, visibility change, page load, `maacash-offline-status`,
`maacash-offline-unlock-changed`, `maacash-offline-unlock-required`, successful sign-in page
load, synchronization success/failure, and device expiry/revocation checks.

### Automated tests

- `tests/offline-status-state.test.ts`: queue/attention and display-state rules.
- `tests/offline-attention.test.ts`: real IndexedDB summary, retryable requeue, user scoping.
- `tests/offline-connectivity-transition.test.ts`: active→ready on reconnect, activation only
  offline.
- `e2e/maacash-offline-status.spec.ts`: online/offline transitions, no false attention, modal
  backdrop and labels.

---

## C. Financial confirmation semantics

- Offline save now says: **Saved on this device — pending synchronization. Not yet in the
  central ledger.** It uses a warning-toned banner, not the green success tick.
- A server-confirmed contribution says: **Collection synchronized successfully.** Only that
  state uses the green success indicator.
- Sync success is only recorded after the server response. A network return never marks a
  record synced.
- Retryable failures are requeued and counted as waiting. Server rejections keep the exact
  reason, remain on the device and raise the attention count.
- Idempotency keys, atomic claim, stale-claim recovery, session-expiry stop, rate-limit stop and
  server authorization are unchanged.

---

## D. UI changes

- Hero: one primary action (Register New Customer), one compact status row (connection, device,
  queue) and a single last-sync/authorization line. Removed the stacked badges and both
  "Enable Offline" buttons.
- Offline records panel is the single place for preparation, unlock and queue actions.
- Contextual actions: Prepare offline access / Unlock offline workspace / Sync now. No
  redundant preparation button while prepared.
- Wording changed from `Connected · saved for this account on this device` to
  `Saved on this device · scoped to your account`.
- Identity wording distinguishes a fresh server verification, a server-rendered page that was not
  re-checked, and offline use with a real last-online-verification timestamp.
- Customer-registration and collection modals: replaced `bg-black bg-opacity-50` (which renders
  as a fully opaque backdrop under Tailwind v4, where `bg-opacity-*` no longer applies) with
  `bg-slate-950/60 backdrop-blur-sm`; added mobile safe-area padding, dynamic viewport height,
  scroll containment and autofocus on the first field.
- Mobile: primary action is full-width; status chips wrap; panel actions stack.

Desktop/mobile screenshots were not captured by the agent. The owner's device and a browser
session are still needed for visual sign-off.

---

## E. Data protection

### Customer account identifiers

Before: the `customers` object store used `keyPath: "accountId"`. Account numbers were visible
as IndexedDB keys/index values even while the workspace was locked.

After:

- New `customers_v4` store, `keyPath: "id"`, where `id` is a random opaque value.
- Customer name, ID code, account number, contribution and balances exist only inside the
  AES-GCM payload.
- `cacheCustomers()` fails closed without an unlocked key; it never writes plaintext customers.
- Migration reads the old `customers` store, encrypts every row into the opaque store, verifies
  read-back and decryption, then clears the old store. An interruption leaves the plaintext
  source intact and is safe to repeat.
- Existing relationships are preserved because `accountId` stays inside the decrypted record.
- Raw IndexedDB is asserted in tests: no account number, customer name or ID code in the raw
  record or key.

### Drafts

Before: when no offline unlock context existed, `saveDraft()` wrote sanitized **plaintext** data
into IndexedDB.

After:

- With an offline unlock credential: draft is encrypted (AES-GCM) in the scoped database and
  fails closed while locked.
- Without a credential (ordinary online session): draft is stored in `sessionStorage`, scoped to
  tenant/user and tab. It is never written to IndexedDB, survives same-tab reload, and is
  cleared on tab close and sign-out.
- A legacy plaintext IndexedDB draft is migrated: moved to session storage when unlocked-only
  storage is unavailable, or encrypted in place when an unlock key exists.
- Passwords, OTPs, tokens, MFA secrets, PINs and recovery codes are stripped before either write.
- Restoration still refills only; it never submits a financial transaction.

### Remaining limitation (explicit)

An online session has no local secret. `sessionStorage` is still browser storage and is readable
by same-origin script while the tab is open. It is not IndexedDB, not persistent across browser
restart, and contains sanitized form state only. True encryption-at-rest for online drafts would
require either a user passphrase on every online draft or a locally stored key, which is
obfuscation rather than protection. This limitation is documented rather than hidden.

---

## F. Device management

Audited: employee creation/activation, role assignment, automatic device enrollment, tenant-
scoped device list, revoke/reactivate and audit logging already exist.

Missing and proposed in `docs/maacash-device-management-design.md`:

- Ownership category (personal vs company).
- Explicit offline approval per employee/module/device.
- Company-device assignment and reassignment workflow.
- Guided replacement and offboarding flows.
- Pending-record visibility per device (records are local until synchronization).

No schema migration was added. The proposal avoids hard-coded employee names and keeps
onboarding in administration.

**Shared-device decision:** company phones may stay online-only for now. Offline financial work
on a shared company phone is **not approved** until a physical handover/isolation test is
completed and accepted.

---

## G. Test-company acceptance

**Not performed.** The agent has no authorized interactive credential entry in this session and
must not ask for a password in chat, an issue, a commit or a report. No tenant ID, role
assignment or account status was verified, and no test records were created.

This means the following remain open:

- Verify the actual tenant ID behind MaDave Enterprise (not just the display name).
- Verify the account is active and has Susu collector permissions.
- Verify device registration, preparation, unlock, recovery, offline collection, queue,
  synchronization and idempotency.
- Verify no BIK Prestige operational data appears.

**BIK Prestige live records:** none were accessed, modified or deleted.

Use `amegayiesaviour@gmail.com` with owner-assisted local credential entry. Do not create a new
tenant or account.

---

## H. Release

| Check | Result |
|---|---|
| Unit/integration suite | 818 passed, 79 files (`npm test`) |
| Typecheck | clean (`npm run typecheck`) |
| Lint | 0 errors, 70 warnings (`npm run lint`) |
| Production build | `✓ Compiled successfully` |
| Playwright (mobile project) | 10/10 passed locally: 7 status tests, 3 mobile shell tests |
| PostgreSQL integration | CI passed: migration rehearsal, status, drift check, integration tests |
| Security review | agent self-review, not independent human approval |
| PR | https://github.com/Delkay-byte/BloomCore-One/pull/43 |
| Deployment | not performed |
| Feature commit SHA | `9878c958e5b7af462165a637b6dd7a71462e55f3` |
| CI (PR) | https://github.com/Delkay-byte/BloomCore-One/actions/runs/43030941583 — all jobs success |
| CI (push) | https://github.com/Delkay-byte/BloomCore-One/actions/runs/43030951638 — all jobs success |

Build record: `npm run build` compiled successfully (`✓ Compiled successfully in 21.7s`). Route
generation completed without errors.

### Security self-review

Reviewed: tenant/user isolation, opaque customer keys, draft storage modes, offline key
lifecycle, recovery path, IV generation, passphrase derivation, cooldown, locked-sync behaviour,
migration verification, queue idempotency, server authorization, logging and account switching.

Resolved in this change:

- Plaintext customer account identifiers in IndexedDB keys.
- Plaintext online drafts in IndexedDB.
- Persisted offline activation outliving connectivity.
- Retryable failures misclassified as permanent attention items.
- Stale setup instruction retained in component state.
- Sync-result failure reused as a persistent financial warning.

Not changed because they were already correct: PBKDF2-SHA-256/600k, per-user salt, random data
key, AES-GCM fresh IVs, recovery wrapping, atomic sync claim, locked-sync retry protection,
tenant-scoped APIs, idempotent server acceptance.

No critical/high finding was introduced by this diff based on the agent review. An independent
review is still required.

---

## I. Owner's remaining actions

1. Review this diff and approve or reject the scope.
2. Record phone model, Android version and browser/PWA mode.
3. Complete the physical checklist in `docs/maacash-android-acceptance-checklist.md`.
4. Provide owner-assisted local credential entry for the MaDave Enterprise acceptance.
5. Confirm the tenant ID and Susu permissions for `amegayiesaviour@gmail.com`.
6. Complete the BIK Prestige management confirmation sheet in the policy.
7. Decide whether company-phone offline work stays disabled.
8. Approve the device-management proposal before any schema change.
9. Approve PR creation, merge and deployment.
10. Keep issue #38 open until every gate is evidenced.

---

## J. Review follow-up (PR #43, second pass)

### Mobile CI failure

**Root cause:** `e2e/mobile.spec.ts:39` still clicked `Enable Offline`. PR #43 removed that
control and moved preparation into the Offline records panel as `Prepare offline access`. The
test failed on a stale selector, not on a broken workflow.

**Fix:** the test now follows the real workflow:

1. Wait for the Offline records panel.
2. Click `Prepare offline access`.
3. Set and confirm the passphrase.
4. Acknowledge the recovery code and continue.
5. Assert the panel reports `Offline available` and no setup instruction remains.
6. Go offline, reload, assert the workspace is locked, unlock, assert `Working offline`.
7. Restore from `/login`, assert `Offline access available`, open the collector dashboard,
   unlock again, assert `Working offline`.

No redundant `Enable Offline` button was reintroduced. The prepared-state assertion uses a
specific panel label with a normal 60 s preparation allowance, not an inflated timeout.

### New status spec in CI

`playwright.config.ts` now assigns `maacash-offline-status.spec.ts` to the mobile project and
excludes it from the desktop project, so the CI command
`npm run test:e2e -- --project=mobile-chromium` executes it exactly once. Local run:
7/7 status tests passed; mobile shell suite 3/3 passed. The CI log for run `43030941583`
explicitly lists `✓ 1 [mobile-chromium] › e2e/maacash-offline-status.spec.ts:63:7 ...`, so the
spec is executed in GitHub Actions rather than merely present in the repository.

### Focus and visibility reconciliation

`handleOnline` is no longer reused for focus. The dashboard now has separate handlers:

- `online` event: mark online, then require a bounded `/api/health` answer before reconciling
  activation or attempting synchronization.
- `offline` event: mark offline and recompute readiness.
- focus / visibility: read `navigator.onLine`; if false, stay offline and only refresh readiness.
  If true, require backend reachability before claiming an online session.
- Backend unreachable state is displayed as `Server unreachable`, not `Online`.
- No record is marked synced by reconnection; only the existing server acknowledgement path does.

### Legacy draft migration

- Session-mode save writes the new copy first, then verifies removal of the old plaintext row.
- If verification fails, the save reports a retryable `write_failed` warning. It does not claim
  the migration completed.
- Load reconciles session and IndexedDB copies by `updatedAt`; the newer draft wins.
- A newer legacy copy is copied to session storage before the old row is removed.
- Protected drafts are never treated as legacy plaintext and are never deleted by cleanup.
- Cleanup is key-scoped and repeatable after interruption.
- Sign-out clears session drafts only; protected IndexedDB drafts are untouched.

### Queue unavailable

`refreshPendingTxs()` now sets the attention count to `null` when the queue cannot be read.
The dashboard renders `Queue unreadable` and an explicit unavailable banner. It never keeps a
stale count and never shows zero as if the queue were known.

`deriveOfflineDisplayStatus()` also gates `attentionCount` on `queueReadable`, and exposes
`queueUnavailable`. Locked workspaces still hide queue details.

### Historical failed records

Records written before this change have no `lastFailureRetryable` field. The classifier uses:

1. The explicit flag when present (authoritative).
2. Otherwise a recognisable transient reason (network, timeout, rate limit, retry) → waiting.
3. Otherwise a recognisable validation/authorization reason → rejection with reason.
4. Otherwise `unknown` → counted as attention for **explicit review**, never auto-requeued.

This avoids both blanket requeueing and blanket "permanent failure" labelling. Unknown records
show a review message instead of a fabricated reason.

### Draft-storage limitation (confirmed)

Online session drafts are sanitised form state in `sessionStorage`. This is not encryption.
Same-origin JavaScript can read it while the tab is open. It is scoped to the tab and the
tenant/user, and is not retained like IndexedDB. Protected offline drafts remain AES-GCM
encrypted and fail closed while locked. No key is stored beside the draft.

