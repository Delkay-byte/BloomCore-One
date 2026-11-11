# MaaCash Employee and Device Management Design (Proposal)

**Status:** Proposal for owner approval. No schema migration is included in this change set.
**Related issue:** #38
**Constraint:** BIK Prestige employees generally use personal phones. A company phone exists
for transaction operations. MaaCash must not require every employee to receive a company phone,
and no employee name or device assignment may be hard-coded.

## 1. Current implementation (audited)

| Capability | Current state | Location |
|---|---|---|
| Create/activate employees | Exists in staff administration | staff actions/UI |
| Assign role and module permissions | Exists | staff/role actions |
| Enroll a device | Automatic during offline preparation; one enrollment per device + module | `POST /api/offline/enroll`, `src/lib/offline/preparation.ts` |
| List tenant devices | Exists, tenant-scoped, admin only | `GET /api/admin/devices` |
| Revoke / reactivate a device | Exists, tenant-scoped, audited | `PATCH /api/admin/devices`, `OfflineDevicesSettings` |
| View owner, module, status, last sync, enrollment time | Exists in the device list | `OfflineDevicesSettings` |
| View pending offline records per device | Not available server-side; records are local until sync | local IndexedDB |
| Device ownership category (personal/company) | **Missing** | — |
| Company-device assignment / handover workflow | **Missing** | — |
| Offline approval separate from enrollment | **Missing**; enrollment is created by the employee's own preparation | — |
| Replacement-device flow | Partly covered by revoke + enroll, no guided flow | — |
| Offboarding checklist | Policy only | `docs/security/OFFLINE-DEVICE-POLICY.md` |

The current enrollment is created by the employee's browser after a server identity check. It
proves the server approved that device ID for that user and module; it does not prove who is
holding the phone. None of these gaps requires hard-coded employee data.

## 2. Proposed data model (minimal, no destructive migration)

Add fields to `DeviceEnrollment`:

| Field | Type | Purpose |
|---|---|---|
| `ownership` | `String` default `"personal"` | `personal` or `company` |
| `assignedAt` | `DateTime?` | When the current employee was assigned a company device |
| `assignedById` | `String?` | Admin who made the assignment |
| `offlineApproved` | `Boolean` default `false` | Explicit offline approval per device |
| `offlineApprovedAt` / `offlineApprovedById` | timestamps/ids | Audit of approval |
| `retiredAt` | `DateTime?` | Device retired or replaced |

Keep `userId` as the current assigned employee. Company-device reassignment updates `userId`
only after the outgoing workspace is locked and pending records are reconciled. No historical
customer data moves between users: local data remains in the per-tenant/per-user database.

Add an optional `DeviceAssignment` audit table only if management needs a full history. A
single `AuditLog` entry per change is sufficient for the first release.

### Enrollment change

`POST /api/offline/enroll` should:

- Accept the module and device ID as today.
- For `susu`, require `offlineApproved = true` for a personal device once management enables
  the approval gate.
- Refuse company devices for offline financial work while shared-device isolation is not
  proven.
- Never accept an ownership category or employee ID from the client; both come from the server
  session or an admin action.

## 3. Administration workflow (proposed UI)

Extend the existing **Offline Devices** settings page instead of creating a second device
console.

Device row shows:

- Employee name and email (current assignee).
- Ownership badge: Personal / Company.
- Module badge: Susu / MoMo.
- Status: Active / Revoked / Retired.
- Last successful sync.
- Offline approval: Approved / Not approved / Not applicable.
- Device reference (truncated), never a full fingerprint.

Actions:

- Approve or withdraw offline access (audited).
- Revoke (lost/retired) and reactivate.
- Register a company device as company property.
- Assign or reassign a company device to an active employee.
- Mark a device retired after replacement.

Guards:

- Cannot assign a revoked or retired device.
- Cannot approve offline access for a company device while shared-device offline safety is
  unproven.
- Cannot reassign until the outgoing employee is inactive or has confirmed sign-out.
- Every change writes an audit event with actor, tenant, device, previous and new state.

## 4. Lifecycle procedures

### New employee

1. Admin creates and activates the employee.
2. Admin assigns role and modules.
3. Employee signs in.
4. Employee enrolls a personal phone, or an admin registers and assigns a company phone.
5. Admin approves offline access where policy allows.
6. Employee sets their own offline passphrase and stores the recovery code.
7. Supervised offline test before field use.

### Employee departure

1. Disable employee access.
2. Revoke device authorization.
3. Read pending records with the employee present where possible.
4. Synchronize or reconcile before cleanup.
5. Recover company hardware after the workspace is locked.
6. Never transfer the passphrase or recovery code.
7. Do not clear site data.

### Personal phone replacement

1. Synchronize pending records on the old phone.
2. Revoke the old enrollment.
3. Enroll the replacement under the same employee.
4. New passphrase and recovery code.
5. Verify tenant/user separation.

### Company phone operator change

1. Outgoing operator synchronizes pending records.
2. Outgoing operator signs out; workspace locks and session drafts clear.
3. Incoming employee signs in with their own account.
4. Incoming employee must see no previous customers, queue, drafts or passphrase.
5. Shared-device offline financial work stays disabled until a dedicated isolation test is
   accepted.
6. Do not clear site data.

## 5. Shared-device decision

**Decision:** company phones may be used for online MaaCash work by authorized employees.
Offline financial work on a shared company phone is **not approved** in this change set.

Reason: local IndexedDB isolation is per tenant/user and the offline passphrase isolates the
encrypted workspace, but a full handover test (sign-out, lock, second user, pending queue,
crash/reload, revoked device) has not been completed on a physical shared device. Availability
of encrypted records is not proof that shared use is safe.

This decision can be revisited after the Android acceptance checklist covers account switching
and revocation on a company phone, with owner approval.

## 6. Implementation sequence (when approved)

1. Add the nullable/defaulted fields above with a backward-compatible migration.
2. Extend the device API with audited admin actions.
3. Extend `OfflineDevicesSettings` with ownership, approval, assignment and retire actions.
4. Gate Susu offline enrollment on approval if management wants a hard control.
5. Add tests for tenant isolation, authorization, audit and reassignment guards.
6. Update the policy confirmation sheet with the final field names.

No employee names, device IDs or branch-specific values belong in source code. All values come
from administration data.
