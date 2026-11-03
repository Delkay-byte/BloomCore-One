# Offline Financial Reliability — BloomCore One

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
The next account opens a different database, so it cannot read or synchronize
the previous user's records. The original user regains access by
authenticating again on the same device.

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

Cookies are shared by every tab on the origin. Login and logout broadcast a
non-sensitive `{ type: "session-changed" }` signal on `BroadcastChannel`
`bloomcore-one-session-v1`. No user id, tenant, token or personal data is sent.

On a signal the receiving tab:

1. closes its IndexedDB connections and clears the in-memory offline scope;
2. revalidates `/api/auth/me` for the route's module;
3. compares the server `userId` with the identity it verified for this tab;
4. closes the per-tab session and leaves the page when the identity changed;
5. fails closed (content hidden, "Session check required") when revalidation
   cannot complete, including while offline;
6. reopens the same user's scoped database only after the same identity is
   verified again.

`focus`/`visibilitychange` and a 60-second check provide a fallback when
`BroadcastChannel` is unavailable or a signal is missed. The guard does not use
sessionStorage storage events for cross-tab communication.

Browser limits: if a cookie is changed outside this application (for example by
developer tools or another origin writing the cookie), detection waits for the
next focus/interval check. Same-origin script with device control can still open
IndexedDB directly; scoping and the guard protect the application UI and sync
path, not a compromised device.

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
