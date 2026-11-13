# MaaCash Android Physical Acceptance Checklist

**Purpose:** Record owner-reported preliminary evidence and guide the remaining physical-device
checks for issue #38.
**Do not** send passphrases, recovery codes, OTPs, session cookies or unredacted customer
records as evidence. Redact names, account numbers and amounts before sharing screenshots.
**Do not** clear browser/site data to "fix" a step: it destroys unsynchronized financial
records.

## 0. Device record

| Field | Value |
|---|---|
| Phone model | |
| Android version | |
| Browser and version | |
| Installed as PWA / browser tab | |
| MaaCash URL | https://maacash.bloomcoretech.com |
| Business shown | MaDave Enterprise (test) |
| Test login (do not include password) | amegayiesaviour@gmail.com |
| Date/time and time zone | |
| Airplane Mode used? | |

## Owner-reported preliminary evidence (recorded, not re-run)

The owner reported the following before this checklist was written:

1. Opened the Susu Collector Dashboard.
2. Prepared offline access and configured the offline passphrase.
3. Closed the browser tab.
4. Opened a different tab and signed in to MaaCash with Airplane Mode still enabled.
5. MaaCash requested the offline passphrase.
6. The passphrase was accepted and the protected workspace opened.
7. A Susu collection was recorded while the phone remained offline.
8. The local collection workflow accepted the record.

These are recorded as **owner-reported preliminary acceptance evidence**. They do not by
themselves prove every item below.

## Steps

For each step record: result (pass/fail/blocked), screenshot reference, time, and notes.

### 1. Online login and preparation
- **Precondition:** Phone online, correct test tenant, no pending records.
- **Action:** Sign in, open Susu Collector Dashboard, open Offline records.
- **Expected:** Connection = Online. Device = Offline available or setup required. No false
  "working offline" banner.
- **Data:** No financial record created.
- **Pass:** Statuses agree with each other and with the real connection.
- **Evidence:** Screenshot of the status area.
- **Recovery:** If status is contradictory, record it and do not prepare again.

### 2. Offline passphrase setup
- **Precondition:** Signed in online, no existing passphrase for this user/device.
- **Action:** Choose a passphrase of at least 12 characters, confirm it.
- **Expected:** Setup succeeds, recovery code shown once. No passphrase visible in the page or
  browser storage.
- **Pass:** Setup completes and the recovery code appears exactly once.
- **Evidence:** Screenshot with the recovery code fully covered.
- **Recovery:** If setup fails, reconnect and retry before collecting offline.

### 3. Recovery-code acknowledgement
- **Action:** Store the code separately from the phone, tick the acknowledgement, continue.
- **Expected:** The workspace is unlocked and preparation completes. The stale "set up a
  passphrase" instruction disappears.
- **Pass:** No repeated setup message after success.
- **Evidence:** Screenshot of Offline records after continuing (code not visible).
- **Recovery:** If the message remains, record it; reload once and check again.

### 4. Close and reopen; passphrase lock
- **Action:** Close the tab/app, reopen the dashboard.
- **Expected:** Workspace locked; customer names, queue details and amounts hidden until the
  passphrase succeeds.
- **Pass:** No sensitive data visible before unlock.
- **Evidence:** Screenshot of the lock screen.
- **Recovery:** Use the passphrase, or the recovery code if it is forgotten.

### 5. Offline customer access
- **Precondition:** Prepared, unlocked, Airplane Mode on.
- **Action:** Open the customer list.
- **Expected:** Only authorized cached customers appear, marked as saved on this device. No
  live server claim.
- **Pass:** Customer list opens without a network request and is labelled cached.
- **Evidence:** Redacted screenshot.
- **Recovery:** Reconnect once and prepare again if the list is missing.

### 6. Offline collection
- **Action:** Record a clearly marked TEST collection.
- **Expected:** Message says **Saved on this device — pending synchronization**, not
  "synchronized" and not a server ledger confirmation.
- **Pass:** Record appears in the pending list with a local reference.
- **Evidence:** Screenshot of the confirmation and pending list.
- **Recovery:** Keep site data. Do not clear storage.

### 7. Pending queue persistence
- **Action:** Close and reopen the app while still offline, unlock.
- **Expected:** The same pending record is still present, still not marked synced.
- **Pass:** Count and amount unchanged.
- **Evidence:** Screenshot before and after.

### 8. Wrong-passphrase cooldown
- **Action:** Enter a wrong passphrase three times.
- **Expected:** Refusal with an increasing cooldown; records are not deleted.
- **Pass:** Cooldown message appears, then a correct passphrase works after the cooldown.
- **Evidence:** Screenshot of the cooldown message.
- **Recovery:** Wait for the cooldown; use the recovery code if needed.

### 9. Recovery-code unlock
- **Precondition:** Locked workspace, known recovery code.
- **Action:** Choose "Use recovery code" and enter it.
- **Expected:** Workspace unlocks. The code is not displayed afterwards.
- **Pass:** Unlock succeeds and no code remains on screen.
- **Evidence:** Screenshot after unlock (code not visible).
- **Recovery:** If the code fails, stop and contact the owner; do not reset data.

### 10. Fifteen-minute inactivity lock
- **Action:** Unlock, leave the app idle for more than 15 minutes, return.
- **Expected:** Lock screen appears before any customer or queue content.
- **Pass:** Lock is enforced.
- **Evidence:** Screenshot and timestamps.

### 11. Five-minute background lock
- **Action:** Unlock, send the app to the background for more than 5 minutes, return.
- **Expected:** Lock screen appears.
- **Pass:** Lock is enforced.
- **Evidence:** Screenshot and timestamps.

### 12. Reconnection with a pending collection
- **Action:** Disable Airplane Mode. Return to the app.
- **Expected:** Connection changes to Online. The offline banner disappears. The pending record
  remains until the server confirms it.
- **Pass:** No "working offline" message after reconnection; no false "synced" claim.
- **Evidence:** Screenshot immediately after reconnection and after synchronization.

### 13. Synchronization
- **Action:** Wait for automatic sync or press Sync now.
- **Expected:** Status shows synchronizing, then the server confirmation. Only then does the
  record leave the pending list.
- **Pass:** Server-confirmed state is distinct from the local save.
- **Evidence:** Screenshot of the confirmation and the empty queue.

### 14. Exactly-once acceptance
- **Action:** Note the TEST amount and customer. Check the server/admin history once.
- **Expected:** Exactly one contribution for that attempt. Repeating sync does not duplicate it.
- **Pass:** One server record only.
- **Evidence:** Redacted server reference and amount.
- **Cleanup:** Do not delete the test record until evidence is recorded.

### 15. Offline Active to Connected transition
- **Action:** Prepare, lose connectivity, observe status, restore connectivity.
- **Expected:** Offline Active only while disconnected. On reconnect it becomes Online plus
  offline available, without a reload.
- **Pass:** No stale Offline Active badge or offline banner.
- **Evidence:** Two screenshots.

### 16. False attention warning
- **Precondition:** No rejected records.
- **Action:** Complete a successful sync, then reload.
- **Expected:** Attention count is zero. No "N collections need attention" message.
- **Pass:** The warning does not appear or reappear.
- **Evidence:** Screenshot of the queue panel after reload.

### 17. Rejected or interrupted record preservation
- **Precondition:** Only with owner approval; use a controlled invalid TEST record if possible.
- **Action:** Cause a server rejection or interrupt the connection during sync.
- **Expected:** The record stays on the device. A rejection shows the exact reason and is
  marked as needing attention. A network interruption is marked as waiting to retry, not
  permanently failed.
- **Pass:** No record loss and no false success.
- **Evidence:** Redacted screenshot.
- **Recovery:** Correct the cause and retry. Do not delete the record to hide the warning.

### 18. Account switching and data isolation
- **Precondition:** Two authorized test identities (owner approval required).
- **Action:** Sign out, sign in as the second identity, open Offline records.
- **Expected:** No previous user's customers, drafts, queue or passphrase. The first user's
  records remain in their own scoped database.
- **Pass:** Complete separation.
- **Evidence:** Screenshots of both empty/foreign states.

### 19. Lost or revoked device behavior
- **Precondition:** Owner approval; use a test device enrollment.
- **Action:** Revoke the device in administration, reconnect on the phone.
- **Expected:** Offline work is refused after verification. Saved records are preserved and
  reported, not silently deleted.
- **Pass:** Revocation is effective and records remain.
- **Evidence:** Redacted suspension message.
- **Recovery:** Re-enroll only with management approval.

## Reporting

Return this checklist with pass/fail per step and redacted screenshots. State exactly which
steps were not performed. Do not mark a step passed without the evidence.
