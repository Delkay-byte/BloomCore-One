# MaaCash Offline Unlock Design

Status: implementation design for Issue #38.
Branch: `security/maacash-offline-unlock-hardening`.
Date: 10 November 2026.

## 1. Problem

Offline restoration is currently bound to the browser profile, not to a user-held secret. A prepared context can be reopened without authentication after a crash or session expiry. Server sync authorization protects the ledger, but not local confidentiality. Dedicated-device policy is operational only.

The new design must prove that the person unlocking local data knows a user-specific factor, and must keep customer data, drafts and queued transactions unreadable while locked.

## 2. Options evaluated

### Option A — WebAuthn / platform authenticator with PRF

- WebAuthn is broadly available.
- The PRF extension can derive a symmetric key from a credential and is usable offline after enrollment.
- Support is uneven: Chrome/Edge/Opera and recent Firefox support PRF; Safari's `get()` PRF support is not reliable per current compatibility data. Creating a credential with PRF output is also less universally supported than asserting one.
- A non-extractable key in the same browser profile is not user proof by itself; another profile user can invoke the credential prompt if the authenticator policy allows it. Platform user verification is the real control.
- We could not complete physical Android acceptance for this release.

**Decision:** keep WebAuthn PRF as a future upgrade path. Do not make it the only unlock mechanism in this release.

### Option B — Strong offline passphrase

- Works in every supported browser without hardware or platform-specific APIs.
- Requires a strong user-chosen passphrase, not a four-digit PIN.
- A locally stored verifier allows offline guessing. Mitigate with a strong passphrase, PBKDF2-SHA-256 with a high work factor, per-user/per-device salt, and local attempt throttling.
- The passphrase is never stored; only salt, KDF parameters, verifier ciphertext and encrypted data are stored.

**Decision:** use this as the baseline unlock mechanism.

### Option C — Hybrid

WebAuthn where available plus passphrase fallback would improve UX but doubles the credential lifecycle and recovery paths. It also needs platform acceptance we could not complete. Defer it until the passphrase baseline is proven on real devices.

## 3. Selected design

### Authentication factor and recovery

- User-specific offline passphrase, minimum 12 characters, established while online and authenticated.
- Normalized with Unicode NFKC and trimmed; not stored.
- Per tenant + user + device random 16-byte salt.
- PBKDF2-SHA-256, 600,000 iterations, 256-bit output.
- The PBKDF2 key wraps a random 256-bit data-encryption key. The data key, not the passphrase key, encrypts records.
- A one-time recovery code (80 bits, displayed once at setup) wraps the same data key with a separate salt. It can reopen the queue if the passphrase is forgotten.
- Both wrappers and the verifier are stored; neither the passphrase nor the recovery code is stored.
- Derived keys are non-extractable and held only in module memory.
- Verification: unwrap the data key, then decrypt a fixed marker ciphertext. Wrong factor fails AES-GCM authentication.
- Local progressive cooldown after wrong attempts. No record deletion. Cooldown state is non-secret and restart-resistant.

A low-entropy PIN is rejected. The recovery code must be stored separately from the device. If both the passphrase and recovery code are lost, the encrypted records cannot be recovered cryptographically; they remain preserved but cannot be opened or synchronized. There is no silent reset.

### Encryption

- AES-256-GCM with a fresh 12-byte random IV per encryption.
- Envelope: `{ v: 1, alg: "A256GCM", iv: base64url, ct: base64url }`.
- Sensitive fields encrypted before IndexedDB write:
  - transaction `payload`;
  - cached customer record body (all customer PII/amounts);
  - draft `data`.
- Non-sensitive operational metadata stays readable for locking/queue counts: ids, tenant/user, type, status, timestamps, retry counts, idempotency key, device id.
- Locked code paths must not decrypt. Reads that require sensitive fields fail with a locked error; counts may use metadata only.
- No plaintext key, passphrase or verifier is written to localStorage, sessionStorage or IndexedDB.

### User/device binding

The unlock record is stored in `bloomcore-offline-device:v1` under the prepared tenant/user context:

```
unlock: {
  version: 1,
  kdf: "PBKDF2-SHA256",
  iterations: 600000,
  salt: base64url,
  verifier: AES-GCM envelope,
  configuredAt: ISO
}
```

The record is bound to `tenantId`, `userId` and the prepared device. Unlocking one scope cannot unlock another scope because the salt/verifier and database name differ.

### Lifecycle

- **Locked by default** after page load, browser restart, crash, tab reload and explicit sign-out.
- **Unlock** requires the passphrase; on success the derived key stays only in memory.
- **Auto-lock** after 15 minutes without user activity and after 5 minutes in the background. `visibilitychange`, `focus` and periodic checks are used; timers are a best-effort control because browsers suspend them.
- **Expiry** is unchanged: offline authorization expires after 24 hours. A successful local unlock never extends it.
- **Sign-out** locks, clears the in-memory key, clears the current offline pointer and sensitive page caches, and preserves encrypted queues.
- **User change** never unlocks the previous user's context automatically.
- **Wrong passphrase** rejects, increases cooldown, preserves all records.
- **Corrupt ciphertext** is reported as a data-integrity error, not an empty queue.

### Page cache

Sensitive HTML must not be served while locked. The service-worker cache continues to store only the application shell required for offline boot. Susu customer data is loaded from encrypted IndexedDB after unlock. The unlock gate prevents the dashboard client from mounting before unlock. Any page whose server HTML contains financial data must not be cached offline; the existing MoMo dashboard is not part of the supported offline financial flow.

## 4. Migration of existing local records

Existing databases remain `bik-prestige-offline:v2:{tenantId}:{userId}`. The schema version increases to 3 by adding backup object stores only. The database is never deleted, renamed or recreated.

For a prepared device with legacy records:

1. Require online authenticated preparation and passphrase setup.
2. Open the existing database with version 3.
3. Copy each legacy record to a backup store (`transactions_legacy_v2`, `customers_legacy_v2`, `drafts_legacy_v2`).
4. Encrypt sensitive fields in the live stores.
5. Verify counts, ids, idempotency keys and decryptability before continuing.
6. Mark the scope migration complete in metadata.
7. Delete the plaintext backup stores only after verification succeeds.
8. If interrupted, the live records remain either plaintext or encrypted; the backup allows retry. No record is treated as an empty queue.

A failed migration leaves the database recoverable and reports an explicit error. A second run is idempotent. No production migration runs until staged device acceptance passes.

## 5. Server and financial boundaries

Local unlock is not authorization. Synchronization continues to require:

- valid authenticated server session;
- correct tenant and Susu module;
- active user/collector;
- active device enrollment for the same tenant/user/device;
- valid 24-hour offline authorization;
- valid customer assignment;
- valid payload and stable idempotency key;
- no duplicate ledger posting.

Local records remain `pending_sync` until the server confirms them. Rejected records remain stored and are not deleted.

## 6. Device ownership

The temporary dedicated-device policy remains until technical ownership controls land. The new unlock credential is per user/device and is not transferred. A future administrative transfer workflow must revoke the old enrollment, preserve unresolved records, and establish a new unlock credential for the new owner. The application does not claim browser-level verification of the Android screen lock.

## 7. Rollout

- Ship behind `OFFLINE_UNLOCK_ENABLED` (default off).
- Enable on a dedicated test tenant/device first.
- Verify migration, unlock, crash/reload, wrong passphrase, lock, expiry, revocation and dual-role switching.
- Only then enable progressively for production offline devices.
- Keep encrypted queues and recovery instructions. Never clear site data.

## 8. Known limitations

- PBKDF2 is not memory-hard. 600,000 SHA-256 iterations plus a 12-character passphrase is the baseline; a compromised device can still mount an offline guessing attack.
- The in-memory key can be invoked by same-origin code while the app is unlocked. Encryption protects data at rest and after lock/crash, not a compromised running page.
- WebAuthn PRF is deferred.
- Real Android acceptance is not yet performed.
- Device screen lock remains an operational control, not application proof.

## 9. Compatibility

- Existing `bik-prestige-offline:v2` databases are upgraded in place with new backup stores.
- No queued transaction, draft or customer record is deleted by the upgrade.
- Existing device enrollments and tenant/user scopes are unchanged.
- Dual-role MoMo/Susu switching keeps the same tenant/user database; the unlock credential is user-level, not module-level.
