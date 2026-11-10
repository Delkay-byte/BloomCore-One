# Offline Financial Reliability — MaaCash

**Status:** Implemented on `feat/bloomcore-ux-offline-reliability`
**Scope:** Susu collector contributions, pending-record protection, synchronization and drafts.

This document describes the implemented behaviour. It replaces the "design
only" status of `OFFLINE-ARCHITECTURE.md` for the areas listed here. It does not
claim that IndexedDB is encrypted against a device attacker.

## 1. Storage model

Each authenticated tenant/user pair gets a separate IndexedDB database:

```
bik-prestige-offline:v2:<tenantId>:<userId>
```

The name is derived from the server session (`/api/auth/me`), never from a
client-supplied identifier. The database contains:

| Store | Purpose |
|---|---|
| `transactions` | Queued financial records (contribution, daily-account draft) |
| `customers` | Read-only offline customer cache |
| `drafts` | Unfinished forms (tenant/user scoped, versioned, TTL) |
| `meta` | Device ID and offline-authorization timestamp |

`OFFLINE_DB_VERSION = 2`. Every opener uses the shared constant. Opening the
same database with a lower version throws `VersionError` and would strand
records, so `device.ts`, `store.ts` and `drafts.ts` must share it.

### Record ownership

Every queued record stores tenant ID, user ID, device ID, record ID,
transaction type, creation time, synchronization status, failure reason,
server result, retry count and a stable idempotency key. The database name adds
physical separation; server authorization remains authoritative.

## 2. Sign-out and account switching

Signing out **does not delete any offline database**.

1. The client optionally synchronizes what it can (`syncBeforeSignOut()`).
2. Acknowledged records older than the retention window are pruned.
3. Connections close and the in-memory scope is cleared (`endOfflineSession()`).
4. The normal server session is revoked.

Pending and failed records stay in the database named for that tenant and user.
The next account through the application opens a different database, so the
application cannot read or synchronize the previous user's records. This is an
application-level boundary, not encryption: same-origin script with device
control can still open the storage directly (see known limitations). The
original user regains access by authenticating again on the same device.

The sign-out dialog distinguishes:

- **Synchronize now** — attempts the queue, reports confirmed records.
- **Sign out and keep records** — always available; nothing is deleted.
- It never offers a "delete everything" action.

Collector **Settings → Offline records on this device** is the only destructive
path. It requires the exact phrase `DELETE OFFLINE DATA`, and it fails closed:

- pending, syncing and failed records are all counted as unresolved;
- a record currently `syncing` blocks deletion even with acknowledgement,
  because the server outcome is unknown;
- pending and failed records require an explicit loss acknowledgement;
- an unreadable IndexedDB queue blocks deletion (it is never treated as empty);
- the signed-in tab broadcasts a close request and waits for every responsive
  tab to acknowledge before issuing deletion; a tab that does not answer
  prevents the request;
- a browser `blocked` event is reported as **pending**, not success and not a
  cancelled operation; the UI polls for the real completion and says so;
- only the signed-in tenant/user database is targeted.

`deleteDatabase()` resolves only after the browser's success event. A blocked
request stays queued; the caller reports it as pending and must never show
“deleted” until the database is actually gone.

### 2.0.1 Deletion coordination

`src/lib/offline/coordination.ts` uses
`BroadcastChannel("bloomcore-offline-coordination-v1")`:

1. probe for responsive tabs;
2. broadcast `close` with the database name and a request id;
3. each tab closes only that database's connections and acknowledges;
4. the requester waits for all known peers (bounded timeout);
5. if a known peer does not acknowledge, deletion is not started;
6. this tab then closes its own connections and requests deletion.

A frozen or suspended tab cannot acknowledge. If it still holds a connection the
browser reports `blocked`; the UI then shows a pending state and polls until the
request actually succeeds. No promise rejection is treated as cancellation of
the browser's request.

## 2.1 Cross-tab account change

There is currently **no session-change broadcast channel** in the application.
Earlier drafts of this document described one; that guard is not implemented.

What actually happens:

1. Explicit sign-out calls `endOfflineSession()` in the signing-out tab: it
   closes that tab's IndexedDB connections, clears the in-memory scope and the
   current device pointer, and clears the application page cache.
2. Other open tabs are not notified. They revalidate on their next server
   request and are redirected when the session is invalid. A tab that is
   offline and already showing cached content can continue to display that
   content until it reloads or the 24-hour offline authorization expires.
3. Same-origin script with device/browser-profile control can open IndexedDB
   directly; scoping and the application guard do not defend against a
   compromised browser profile.

This is part of the device-identity residual tracked in
`https://github.com/Delkay-byte/BloomCore-One/issues/38`. Do not claim that
cross-tab invalidation or a shared-profile lock is implemented.

## 3. Synchronization lifecycle

```
pending_sync ──claim──> syncing ──server ok──> synced
      ^                     │
      │                     ├─ retryable (5xx/network/429) ──> pending_sync (retry++)
      │                     ├─ 401 session expired ──────────> pending_sync (retries untouched)
      │                     └─ rejection/retry limit ────────> failed (payload retained)
```

- FIFO order by creation time.
- `claimTransactionForSync()` flips `pending → syncing` inside one IndexedDB
  transaction. Only one tab can claim a record.
- A Web Lock (`bloomcore-offline-sync`) prevents two tabs running a batch where
  the API exists; a module flag covers older browsers.
- `recoverStaleSyncing()` returns abandoned `syncing` records to the queue after
  five minutes (browser closed or refresh during a request).
- A 401 stops the batch and leaves the rest pending. It does not burn retries.
- A 429 honours `Retry-After` and leaves the record pending.
- Partial success is preserved: acknowledged records become `synced`; failed
  records keep their original payload and failure reason.

## 4. Idempotency

- The key is generated once when the record is created and stored with it.
- Retries reuse the same key; a new key is generated only for a genuinely new
  operation.
- Online contributions and withdrawals also accept a client key; the admin and
  collector forms retain it across retries and clear it only after the server
  answers.
- **The key is bound to the original normalized payload.** The server validates
  and canonicalizes the payload first (fixed key order, explicit nulls, trimmed
  notes), computes a SHA-256 digest, and compares it with the digest of the
  stored original before any success result or ledger action. The check runs for
  pending, syncing, failed and synced rows.
- Same key + materially changed amount, account, channel, notes or collector
  returns HTTP 409. A completed transaction's result is never returned for a
  different payload, and a changed payload is never processed under an existing
  key.
- Property order and omitted optional fields do not create a mismatch. Legacy
  rows that stored raw client JSON normalize to the same digest.
- Ownership (tenant, user, device) is checked before the payload comparison, so
  a foreign key never reveals whether its payload matches.
- The server reserves the key in `OfflineTransaction` before moving money. A
  concurrent identical request that loses the unique-key race re-reads the row;
  it continues only when owner and digest match.
- `Contribution.referenceId` is unique. The offline route uses the same
  `CON-<key>` convention as the online action, and a unique-constraint collision
  is reconciled to the existing contribution instead of posting again.
- No schema change was required: the normalized payload is stored in the
  existing `OfflineTransaction.payload` column and compared by digest.

## 5. Retention

- Acknowledged records are kept for seven days for local audit/receipt display.
- `pruneSyncedTransactions()` removes only `synced` records older than that.
- Pending and failed records are never pruned automatically.
- Drafts expire after seven days, are versioned, and are deleted on successful
  submission.

## 6. Storage failures and limits

- `QuotaExceededError` becomes `OfflineStorageError("storage_full")`.
- The collect flow refuses to claim success when writing fails and tells the
  user storage is full.
- The offline status panel checks `navigator.storage.estimate()` and warns at
  80% usage.
- If IndexedDB is unavailable, the device ID falls back to session/in-memory and
  draft saving reports "Draft not saved" without blocking the form.
- Browser/OS site-data clearing is outside the application's control. The UI
  warns that clearing site data permanently destroys unsynchronized records.

## 7. Visibility and recovery

The collector dashboard and settings show:

- records waiting to synchronize;
- records currently synchronizing;
- failed records with their reason;
- last confirmed synchronization time;
- a retry control and an online/offline indicator.

A rejected record stays available with its payload. Resolution is either a
corrected new entry or an administrator-assisted review; the application never
silently deletes it.

## 8. Known limitations

1. IndexedDB is ordinary browser storage. It is scoped and access-controlled by
   application code, not encrypted against someone who controls the device.
2. Offline support currently covers Susu collector contributions. MoMo daily
   accounts use server-saved drafts plus local form drafts; they are not queued
   as offline financial postings.
3. Recovery of a permanently disabled account's queue requires an
   administrator-controlled device reset; there is no self-service export.
4. Local form drafts minimize sensitive data but may contain customer PII. They
   expire after seven days and are removed on successful submission.
5. Cross-tab invalidation depends on BroadcastChannel for immediate delivery.
   Browsers without it, or a tab that misses a signal, detect the change on the
   next focus/visibility event or 60-second check.
6. A blocked IndexedDB delete is reported as pending, not success. The browser
   may complete it later after all connections close; the UI polls and only
   reports deletion when the database is actually gone.
7. Same-origin developer tools can open IndexedDB directly. The guard prevents
   the application from rendering or synchronizing another user's records; it
   is not a defence against a compromised browser profile or device.
8. Offline restoration is passwordless for the last prepared user. After a
   browser crash, session expiry or a network failure during a different
   sign-in, another person using the same unlocked browser profile can open the
   prepared dashboard and read cached customer/queue data. Server sync still
   requires a valid authorized session and is rejected after revocation or
   expiry. This is a High risk on shared devices and is tracked in issue #38.
   MaaCash must not be described as safe for shared devices until that
   hardening lands.

## 9. Preparation, local activation and offline login

Offline support separates five operations that were previously coupled:

1. **Device preparation** (online): validates `/api/auth/me`, enrolls the
   device for every authorized module, downloads the collector's authorized
   customer snapshot, and warms the application shell.
2. **Offline readiness** (local): reads the prepared context and verifies that
   the cached app screen exists. Only then does the UI say **Offline Ready**.
3. **Activation** (local): `Enable Offline` updates a local flag. It does not
   call an API and does not extend the authorization window.
4. **Local records**: queued contributions are marked **Saved on Device — Not
   Yet Synced** and never appear in server-authoritative totals.
5. **Synchronization**: reuses the existing queue, stable idempotency keys and
   server authorization checks. A successful sync reconciles the local
   authorization window with the server timestamp.

A device that has never been authenticated or prepared is told that initial
online setup is required. It is never given an offline login, invented customer
data, or a weaker credential.

### 9.1 Durable local context

`src/lib/offline/device-store.ts` stores only non-secret identity and readiness
metadata in `bloomcore-offline-device:v1`: user/tenant ids, display name, role,
authorized modules, device ids, preparation and authorization timestamps, and a
local activation flag. It stores no password, JWT, refresh token, session
handle, customer record or financial payload.

The device-level database survives sign-out so prepared, unsynchronized records
are not lost. Sign-out clears the current offline-session pointer and the cached
application pages. The next offline start therefore cannot restore the previous
user's dashboard; a future online sign-in by the same user restores their own
scoped records.

### 9.2 Offline login and dual-role switching

`/login` is warmed while online. If the network is already gone, the prepared
device can open a previously authorized dashboard without contacting the
server. The login screen offers only the modules recorded during preparation.

For a dual-role MoMo Agent/Susu Collector, both authorized dashboards are
prepared where the supporting data and cache checks pass. `WorkspaceSwitcher`
switches locally while offline after confirming that the destination module was
prepared and its cached screen exists. It does not ask for a password or MFA
again, and it does not let the browser invent module permissions.

When connectivity returns, `OfflineSessionGuard` re-checks the tab's server
session for the open module. If the offline switch left the tab on the other
module's server session, the existing `switchWorkspace` action re-verifies the
identity and entitlements server-side and binds the correct credential to the
tab. The offline sync route also accepts a MoMo session only when the server
proves the same user and tenant are authorized for Susu.

### 9.3 Cached application pages

The existing tab-session service worker (`public/tab-session-sw.js`) now also
caches application navigation responses and static assets. Page caches are
namespaced by the local `tenant:user` scope, so one account's cached dashboard is
not served to another. Static assets are shared because they contain no user
data. Navigation is network-first and falls back to the cached page; a device
with no prepared cache receives an explicit "initial online setup required"
screen, never a misleading logged-in shell.

A cached protected page also runs `OfflineSessionGuard`. If the local
preparation is missing, expired, or does not include the page's module, the app
returns to the login/offline prompt instead of showing the page.
