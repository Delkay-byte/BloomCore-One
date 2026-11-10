# MaaCash Offline Identity Security Hardening — Report

Date: 10 November 2026
Issue: https://github.com/Delkay-byte/BloomCore-One/issues/38
Branch: `security/maacash-offline-unlock-hardening`
Design: `docs/security/MAACASH-OFFLINE-UNLOCK-DESIGN.md`

## 1. Root cause and threat model

The previous offline workspace reopened from a device-level prepared context without a user-held secret. After a crash, unexpected browser closure or session expiry, another person using the same unlocked browser profile could open the prepared Susu dashboard and read locally cached customer data and queued transaction payloads. Server sync authorization protected the ledger but not local confidentiality.

The hardening adds a user-specific offline passphrase, encrypted local records and a lock lifecycle. Server authorization and idempotency remain unchanged.

## 2. Cryptographic design

- Factor: user-specific offline passphrase, minimum 12 characters, NFKC-normalized, never stored.
- KDF: PBKDF2-SHA-256, 600,000 iterations.
- Salt: random 16 bytes per tenant/user/device.
- Cipher: AES-256-GCM, fresh random 12-byte IV per encryption.
- Key: non-extractable WebCrypto key held only in module memory.
- Verifier: fixed marker encrypted with AES-GCM. Wrong passphrase fails authentication; no password hash is stored.
- Envelope: `{ v: 1, alg: "A256GCM", iv, ct }`.
- Protected fields:
  - transaction payloads;
  - cached customer records;
  - draft data.
- Non-sensitive metadata remains readable for locking and queue counts: ids, tenant/user, type, status, timestamps, retry counts, idempotency key, device id.
- Local cooldown after wrong attempts: 30 seconds after 3, 5 minutes after 5, 30 minutes after 7. Wrong attempts never delete records.
- Lock lifecycle: locked on page load, browser restart, crash, tab reload and sign-out; 15-minute idle lock; 5-minute background lock using visibility/focus plus a timer fallback.
- Device-level context stores salt, KDF parameters, verifier ciphertext and timestamps only.

### WebAuthn decision

WebAuthn/PRF was evaluated. PRF support is uneven: recent Chrome/Edge/Firefox support it, Safari `get()` PRF support is not reliable per current compatibility data, and platform authenticator user verification could not be tested on real Android for this release. It remains a future upgrade, not the only unlock path.

### Limitations

- PBKDF2 is not memory-hard. Security depends on a strong passphrase and the 600,000-iteration work factor.
- The in-memory key is accessible to same-origin code while unlocked. This protects data at rest and after lock/crash, not a compromised running page.
- OS screen-lock state is an operational control, not application proof.

## 3. Data migration

Existing databases remain `bik-prestige-offline:v2:{tenantId}:{userId}`. The schema version increases to 3 by adding backup stores only. The database is not renamed, recreated or cleared.

Migration:

1. Requires online authenticated preparation and an established unlock passphrase.
2. Reads legacy plaintext transactions, customers and drafts.
3. Copies legacy records to plaintext backup stores.
4. Encrypts the live sensitive fields.
5. Reads back and decrypts every protected record.
6. Verifies ids, idempotency keys, payload content and record counts.
7. Removes plaintext backups only after verification succeeds.
8. Writes a migration marker; repeat runs are idempotent.

If interrupted before verification, plaintext backups remain and the migration can be retried. A locked queue is never treated as empty. No legacy record is deleted before verification.

## 4. Tests

Authoritative local result: **76 test files, 776 tests passed, 0 failed, 0 skipped**.

New suite `tests/offline-unlock-hardening.test.ts`: 9 tests covering:

- weak passphrase rejection;
- correct/wrong passphrase;
- unique IV and authenticated encryption;
- encrypted queue/customer storage;
- locked reads;
- wrong unlock preserving records;
- idle/background locking;
- scope isolation;
- migration counts, ids, idempotency keys and failed/syncing statuses;
- idempotent re-migration;
- plaintext backups removed after verification.

Existing suites passed, including offline preparation, isolation, queue, deletion coordination, module scope, tab-session isolation, tenant isolation and draft persistence.

Browser tests:

- dual-role desktop switch: 3 passed;
- mobile Chromium offline prepare → reload → lock → unlock → restore: 3 passed;
- the mobile test now asserts the unlock gate after reload and after opening from the offline login prompt.

`npm run typecheck`: PASS
`npm run lint`: PASS, 0 errors
`npm run build`: PASS

Real Android device/emulator acceptance: **BLOCKED** — no Android device or emulator was available. Documented manual procedure is required.

## 5. Device policy

Technically enforced:

- offline passphrase required before protected data opens;
- AES-GCM encryption of queues, customers and drafts;
- locked after reload/restart/crash/sign-out/inactivity;
- wrong attempts throttled, records preserved;
- no unlock record means no offline workspace;
- MoMo dashboard HTML is not cached offline because it contains financial figures.

Operational only:

- one named employee per offline device;
- no sharing between employees;
- device PIN/biometric lock with automatic locking;
- sign out before transfer and synchronize pending records;
- non-compliant devices must not be offline-enabled.

The application does not claim browser-level verification of the Android screen lock. Administrator device transfer remains an operational workflow; no new server schema was added.

## 6. Financial synchronization

Unchanged server boundary:

- valid authenticated session;
- correct tenant and Susu module;
- active user/collector;
- active device enrollment for the same tenant/user/device;
- valid 24-hour authorization;
- customer assignment validation;
- payload validation;
- stable idempotency key and duplicate protection.

Local unlock is not authorization. Server rejection preserves the local record. Records remain `Saved on Device — Not Yet Synced` until confirmed.

## 7. Release

- Branch: `security/maacash-offline-unlock-hardening`
- Commit SHA: pending
- PR: pending
- Approval: pending technical review; no independent GitHub approval claimed
- CI: pending
- Render deployment: pending
- Production verification: pending

## 8. Remaining limitations

1. Real Android WebAuthn/device acceptance not performed.
2. WebAuthn PRF not selected for baseline.
3. PBKDF2 is not memory-hard.
4. Compromised browser profile/running page is outside this control.
5. Administrator device-transfer workflow remains operational; no new enrollment schema.
6. Existing devices without an unlock credential are blocked from offline access until they reconnect and establish one. Records are preserved.
7. No independent human security review was performed; agent technical review only.
