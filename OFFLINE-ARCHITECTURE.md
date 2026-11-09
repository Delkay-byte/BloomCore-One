# OFFLINE ARCHITECTURE — BIK Prestige Enterprise

> **Status: PARTIALLY IMPLEMENTED — Susu collector offline readiness, local
> activation, offline page cache and offline session restore are implemented.
> MoMo financial postings still require a connection.**
> Susu collector contributions can be queued offline and synchronized with
> idempotency. Pending records are preserved across sign-out and account
> switching. See `docs/OFFLINE-RELIABILITY.md` for the implemented behaviour,
> guarantees and limitations. Sections below remain the original design target
> and are marked where they are not yet built.
>
> Internet connection is still required for MoMo daily-account financial
> postings and for all administrative financial operations.

---

## 1. Overview

The BIK Prestige platform handles:
- **Susu collector** daily route collections
- **MoMo worker** daily account submissions
- **Customer** savings, withdrawals, commissions

In many Ghanaian field environments, internet connectivity is unreliable. This architecture enables collectors and workers to perform essential operations offline, then synchronize securely when connectivity returns.

---

## 2. Design Principles

| Principle | Description |
|-----------|-------------|
| **Event-sourced** | Every offline action is an immutable event, never a raw balance overwrite |
| **Idempotent** | Every transaction has a unique ID; server rejects duplicates |
| **Encrypted at rest** | Sensitive financial data encrypted in local storage |
| **Server-authoritative** | Server is the final source of truth; local state is a cache |
| **Graceful degradation** | Offline mode is limited but functional; sync is mandatory |
| **No false confidence** | UI clearly distinguishes "saved locally" from "confirmed by server" |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLIENT (PWA)                      │
│                                                     │
│  ┌───────────┐  ┌───────────┐  ┌────────────────┐  │
│  │  Service   │  │ IndexedDB │  │  Sync Manager  │  │
│  │  Worker    │←→│ (encrypted│←→│  (queue + retry│  │
│  │  (cache)   │  │  store)   │  │   + conflict)  │  │
│  └───────────┘  └───────────┘  └───────┬────────┘  │
│                                         │            │
└─────────────────────────────────────────┼────────────┘
                                          │
                                          │ When online:
                                          ▼
┌─────────────────────────────────────────────────────┐
│                    SERVER (API)                      │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Auth / Token │  │ Validation   │  │ Database  │ │
│  │ Verification │→ │ + Business   │→ │ (Postgres)│ │
│  │              │  │   Rules      │  │           │ │
│  └──────────────┘  └──────────────┘  └───────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 4. Offline Transaction Flow

### 4.1 Collector — Record Collection Offline

```
Collector taps "Collect" on customer card
        ↓
Transaction created locally:
  {
    id: "device123-uuid-abc",
    type: "contribution",
    accountId: "...",
    amount: 350,
    channel: "collector",
    collectorId: "derived-from-session",
    timestamp: "2026-08-24T10:30:00Z",
    status: "pending_sync"
  }
        ↓
Saved to encrypted IndexedDB
        ↓
UI shows: "Saved on device ⏳"
        ↓
Connectivity returns
        ↓
Sync Manager sends to server
        ↓
Server validates:
  - Collector authorization
  - Account exists and is active
  - Amount > 0
  - Customer assigned to collector
  - Idempotency check (duplicate ID)
        ↓
Server creates contribution + allocations
        ↓
Server returns: { success: true, contributionId: "..." }
        ↓
Local transaction marked: "synced"
        ↓
UI shows: "✓ Synced"
```

### 4.2 MoMo Worker — Save Draft Offline

```
Worker enters MoMo account figures
        ↓
Draft saved to encrypted IndexedDB
        ↓
UI shows: "Draft saved locally"
        ↓
Connectivity returns
        ↓
Draft synced to server
        ↓
Worker can then "Submit" when ready
```

---

## 5. Local Storage Design

### 5.1 IndexedDB Schema

```
Database: bik-prestige-offline
  ├── transactions         (offline financial events)
  │     ├── id: string (device + UUID)
  │     ├── type: "contribution" | "daily_account" | "withdrawal"
  │     ├── payload: encrypted JSON
  │     ├── status: "pending_sync" | "syncing" | "synced" | "failed"
  │     ├── createdAt: ISO timestamp
  │     ├── syncedAt: ISO timestamp | null
  │     └── retryCount: number
  │
  ├── session              (local auth state)
  │     ├── userId: string
  │     ├── moduleId: string
  │     ├── tokenHash: string (not raw token)
  │     ├── expiresAt: ISO timestamp
  │     └── deviceId: string
  │
  └── customers            (cached customer list for offline viewing)
        ├── customerId: string
        ├── name: string
        ├── accountId: string
        ├── dailyContribution: number
        └── lastSynced: ISO timestamp
```

### 5.2 Encryption

- **Algorithm**: AES-GCM (via Web Crypto API)
- **Key derivation**: PBKDF2 from user's session-derived key
- **Key storage**: Non-exportable CryptoKey in IndexedDB
- **Scope**: All financial payloads are encrypted before storage

---

## 6. Authentication — Offline

### 6.1 Approach

| Component | Strategy |
|-----------|----------|
| Access token | Short-lived JWT (existing — 8 hours pilot) |
| Refresh | Not needed for offline (device must reconnect) |
| Device enrollment | Device gets a unique `deviceId` on first login |
| Local auth state | Session hash + expiry stored in IndexedDB (encrypted) |
| Offline grace period | Maximum 24 hours offline before forced re-authentication |

### 6.2 Device Enrollment

On first login:
1. Server generates `deviceId` (random, stored server-side)
2. Device stores `deviceId` in IndexedDB
3. Server can revoke a device by invalidating its enrollment

### 6.3 Offline Authentication Limitations

- If user logs out → offline data becomes inaccessible
- If admin disables account → offline access continues until device syncs
- If password changes → device must re-authenticate on next sync
- If tokenVersion bumps → offline session becomes invalid on next sync

---

## 7. Sync Manager

### 7.1 Sync Strategy

```
1. Check connectivity (navigator.onLine + server ping)
2. If online:
   a. Read pending transactions from IndexedDB
   b. Sort by createdAt (FIFO)
   c. Send each to server with idempotency key
   d. On success: mark as "synced"
   e. On failure: increment retryCount, exponential backoff
   f. On max retries: mark as "failed", alert user
3. If offline:
   a. Queue continues to accept new transactions
   b. UI shows sync status
```

### 7.2 Conflict Resolution

| Conflict | Resolution |
|----------|------------|
| Customer already collected today (by another channel) | Server rejects; local marked "failed — already collected" |
| Account disabled | Server rejects; local marked "failed — account inactive" |
| Collector assignment changed | Server rejects; local marked "failed — not assigned" |
| Cycle closed | Server rejects; local marked "failed — cycle ended" |
| Network timeout (server may have processed) | Retry with same idempotency key; server returns cached result |

### 7.3 Retry Policy

```
Attempt 1: immediate
Attempt 2: 5 seconds
Attempt 3: 30 seconds
Attempt 4: 2 minutes
Attempt 5: 10 minutes
Max retries: 5
After max: alert user, mark "failed — requires manual resolution"
```

---

## 8. Sync Status UI

The UI must clearly communicate:

| Status | Visual | Meaning |
|--------|--------|---------|
| Saved on device | ⏳ Yellow | Transaction recorded locally, not yet sent |
| Waiting to sync | 🔄 Blue | Queued for sync, waiting for connectivity |
| Syncing | ⏳ Spinner | Currently being sent to server |
| Synced | ✅ Green | Server confirmed — transaction is in the ledger |
| Failed | ❌ Red | Sync failed — user action required |

**Critical rule**: A transaction is NOT considered "recorded" until the server confirms it. The UI must never tell a user their collection is complete until the server acknowledges.

---

## 9. Customer Data Caching

For offline customer viewing:
- On successful login (online), cache assigned customer list
- Include: name, ID, account ID, daily contribution, last known status
- Refresh cache on each successful sync
- Customer list is **read-only** offline — no modifications

---

## 10. Security Considerations

| Threat | Mitigation |
|--------|------------|
| Lost/stolen device | Device revocation via server; encrypted storage; offline timeout (24h) |
| Unencrypted financial data | AES-GCM encryption via Web Crypto API |
| Stale offline data | Short offline grace period; forced re-auth after 24h |
| Replay attacks | Idempotency keys; server rejects duplicate transaction IDs |
| Tampered local state | Server validates all financial rules; local state is advisory |
| Session theft | Short JWT expiry; tokenVersion invalidation on password change |

---

## 11. Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 | Architecture design | ✅ This document |
| Phase 2 | IndexedDB + encryption layer | Not started |
| Phase 3 | Offline contribution recording (collector) | Not started |
| Phase 4 | Sync manager + conflict resolution | Not started |
| Phase 5 | MoMo daily account offline draft | Not started |
| Phase 6 | Device enrollment + revocation | Not started |
| Phase 7 | Security audit + penetration testing | Not started |
| Phase 8 | Pilot testing with real collectors | Not started |

---

## 12. Current Pilot Policy

> **Susu collector contributions may be recorded offline and synchronized when
> connectivity returns. They are not in the central ledger until the server
> acknowledges them.**

> **MoMo daily accounts, withdrawals, reversals, remittances and all
> administrative financial operations still require a connection.**

The PWA manifest and service worker cache static assets. Offline financial
capability is limited to the Susu collector contribution queue described in
`docs/OFFLINE-RELIABILITY.md`. Do not claim broader offline support.
