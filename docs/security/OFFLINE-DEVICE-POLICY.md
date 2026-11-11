# MaaCash Offline Device Policy

**Status:** Draft for BIK Prestige management confirmation. Technically enforced controls are
implemented; operational controls require owner/management sign-off before this policy is
marked confirmed.
**Scope:** Every MaaCash device used for Susu collections, MoMo operations, or any future
offline module.
**Related issue:** https://github.com/Delkay-byte/BloomCore-One/issues/38

## 1. Device categories

BIK Prestige employees generally use their own phones. The business also owns at least one
transaction phone. MaaCash must support both without making a company phone a condition of
employment.

| Category | Ownership | Typical use | Offline financial work |
|---|---|---|---|
| Personal / BYOD phone | Employee | Susu collections, viewing authorized MoMo information | Allowed only when the employee, role, module and device are individually approved |
| Company transaction phone | BIK Prestige | MoMo transaction operations, shared operational tasks | Offline financial work stays **disabled** until shared-device offline isolation is proven. Online operations remain available to authorized employees |
| Online-only terminal | BIK Prestige or employee | Office/admin use | Offline financial work disabled |

A device belongs to exactly one category. Mixed use requires an explicit management decision,
not an assumption.

## 2. Assignment rules

1. Every device approved for offline work is assigned to one named employee account.
2. A personal phone is registered against its owner's account. It is never registered against
   a shared or generic account.
3. A company phone is registered as company property and assigned to one authorized employee
   at a time through the administration workflow.
4. An employee may hold more than one registered device, but each device has its own offline
   unlock credential.
5. Offline access is approved per employee, per module and per device. Approval for one module
   does not imply approval for another.
6. MoMo offline financial postings remain unsupported and must not be enabled.

## 3. Device lock requirement

- Every offline-enabled phone must have an Android screen lock (PIN, password, pattern or
  biometric) with automatic locking after a short idle period.
- MaaCash cannot verify the Android OS lock state. The application must not claim that it has
  verified it. This control is operational and is confirmed by the employee and management.
- The MaaCash offline passphrase is a second, application-level control. It is required after a
  reload, browser restart, crash, sign-out, 15 minutes of inactivity or 5 minutes in the
  background. It does not replace the device lock.

## 4. Offline approval and passphrase

- The employee configures their own offline passphrase on the device. No administrator,
  colleague or support agent may know or set it.
- The recovery code is shown once at setup. The employee stores it separately from the phone.
  It must never be shared with another employee, sent in chat, or stored in the MaaCash app.
- An employee's passphrase and recovery code are never transferred with company hardware.
- A device that has no offline unlock credential cannot open an offline workspace.

## 5. Employee onboarding

1. Management creates and activates the employee account.
2. Management assigns the role and the modules the employee may use.
3. The employee signs in online and enrolls their personal phone, or receives a company phone.
4. Management approves offline access for that employee, module and device where policy allows.
5. The employee sets their own offline passphrase and records the recovery code.
6. The employee completes one supervised offline test before field use.

No employee name or device assignment is hard-coded. Onboarding requires no source-code change
or redeployment.

## 6. Employee departure

1. Disable the employee's access through the approved staff workflow.
2. Revoke their device authorization.
3. Check pending offline records before any cleanup.
4. Synchronize or reconcile pending financial records; do not delete them to clear a warning.
5. Recover company hardware only after the outgoing employee's workspace is locked and
   records are reconciled.
6. Never reuse the previous employee's passphrase or recovery code.
7. Do not clear browser/site data as a shortcut.

## 7. Personal phone replacement

1. Synchronize pending records on the old phone where possible.
2. Revoke the old device enrollment when it will no longer be used.
3. Enroll the replacement phone under the same employee account.
4. Set up a new offline passphrase and recovery code on the replacement.
5. Confirm tenant and user separation before field use.

## 8. Company phone handover

1. The outgoing operator synchronizes pending records and signs out.
2. Sign-out locks the offline workspace and clears the in-tab session draft.
3. The incoming employee signs in with their own account.
4. The incoming employee must not see the previous operator's customers, queue, drafts or
   passphrase.
5. Shared-device offline financial work remains disabled until a dedicated isolation test is
   completed and management accepts the result.
6. Do not clear site data to force a handover.

## 9. Loss, theft and revocation

1. Revoke the device authorization immediately through administration.
2. Revoke or disable the employee's access if the device or credentials are at risk.
3. Do not ask the employee to reveal their passphrase or recovery code.
4. Preserve pending records for reconciliation where recovery is possible.
5. Record the incident, the device category and the revocation time.
6. Treat unknown local records as financial records, not as disposable cache.

## 10. Pending records

- A record saved on the device is not in the central ledger until the server confirms it.
- Pending and retryable records are waiting, not failed. Only a server rejection is a record
  that needs a user decision.
- Do not delete, hide or zero a record to remove a warning.
- Do not clear browser/site data while unsynchronized records exist, unless an authorized
  loss decision has been recorded.

## 11. Technically enforced by MaaCash

- Per-tenant/per-user offline databases; one account cannot open another account's database.
- Per-user offline unlock credential (12+ characters), PBKDF2-SHA-256, 600,000 iterations,
  per-user/per-device salt, random 256-bit data key, AES-256-GCM with fresh IVs.
- Encrypted transaction payloads, cached customers and drafts when the workspace is unlocked.
- Customer account identifiers are no longer IndexedDB object keys or index values.
- Lock on reload, restart, crash, sign-out, inactivity and long backgrounding.
- Progressive wrong-attempt cooldown and recovery-code unlock.
- Locked workspaces cannot read or synchronize queued records and do not burn retries.
- Server-side authorization, tenant isolation and idempotent exactly-once acceptance.
- Device enrollment and revocation records.

## 12. Enforced operationally by management

- Device ownership category and assignment.
- Android screen lock and automatic lock.
- Approval of offline access per employee, module and device.
- Employee identity checks during onboarding and handover.
- Physical control of company hardware.
- Recovery-code storage outside MaaCash.
- Timely revocation after loss or departure.
- Confirmation that company-phone offline financial work stays disabled.

## 13. What this policy does not claim

- MaaCash does not verify the Android OS lock state.
- MaaCash does not make a shared browser profile safe for offline financial work merely
  because a passphrase is requested later.
- IndexedDB is not a hardware-backed keystore. A compromised device or browser profile
  remains a risk.
- A prepared offline device can open its protected workspace without a fresh server login
  inside the 24-hour authorization window, after the offline passphrase succeeds.

## 14. Management confirmation sheet

Management confirms each line before offline field use:

| # | Confirmation | Confirmed by | Date |
|---|---|---|---|
| 1 | The list of employees approved for offline Susu collection | | |
| 2 | Each approved employee has exactly one assigned offline phone, or a documented exception | | |
| 3 | Every personal phone used offline has an Android screen lock | | |
| 4 | Company transaction phone has offline financial work disabled | | |
| 5 | Company phone handover procedure is understood and will be followed | | |
| 6 | Each employee has stored their own recovery code outside the phone | | |
| 7 | Loss/departure revocation steps are understood | | |
| 8 | Management accepts that MaaCash cannot verify the Android OS lock | | |
| 9 | Shared-device offline use is not approved until a dedicated test is accepted | | |
| 10 | Pending records will be reconciled, never deleted, to clear warnings | | |

**Policy status:** Not operationally confirmed until this sheet is completed by the owner or
authorized BIK Prestige management. Until then, this document is a proposed policy, not evidence
of compliance.
