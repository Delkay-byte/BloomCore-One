# MaaCash Temporary Offline Device Policy

**Status:** Temporary operational security restriction, effective 10 November 2026.
**Scope:** Every MaaCash device enabled for offline financial operations, including Susu collector contributions and any future offline module.
**Related issue:** https://github.com/Delkay-byte/BloomCore-One/issues/38

## Why this policy exists

MaaCash offline restoration is bound to the browser profile and the last prepared device context, not to a fresh user authentication. The application deliberately allows a prepared user to open an offline dashboard without a password. After a browser crash, session expiry or a network failure during a different sign-in, another person using the same unlocked browser profile could read cached customer data and queued financial records.

Server synchronization still requires a valid, authorized session and is rejected after device revocation or authorization expiry. Local records remain pending until the server acknowledges them. That protects the official ledger, but it does not protect local confidentiality on a shared device.

Do not describe MaaCash offline access as safe for shared devices.

## Mandatory rules

Until stronger offline identity protection is implemented:

1. Every offline-enabled device must be assigned to one named, authorized employee.
2. An offline-enabled device must not be shared between MoMo agents, Susu collectors, administrators or other employees.
3. The device must have an Android/device-level PIN, password or biometric screen lock enabled, with automatic locking after inactivity.
4. The employee must sign out properly before a device is transferred or reassigned.
5. Pending offline financial records must be synchronized before a device is handed over.
6. A device that cannot comply with these rules must not be enabled for offline financial operations.

## What this policy is not

- It is not technically enforced by device enrollment. Enrollment associates a device ID with a user and tenant; it does not prove who is holding the device.
- It is not a substitute for the hardening in issue #38.
- It does not make local IndexedDB encrypted or protect against a compromised browser profile/device.
- It does not permit shared use merely because the application asks for a password at some later point.

## Operational checks

- Administrators must record which employee owns each offline-enabled device.
- Offline devices should be reviewed when an employee leaves, changes role, or receives a replacement phone.
- If a device is lost or reassigned, follow the existing sign-out, device revocation and pending-record preservation procedures. Do not clear site data to resolve an identity error.
- If dedicated-device use cannot be enforced, disable offline access on that device until issue #38 is resolved.

## Relationship to release #37

This policy is the product owner's temporary risk acceptance for the device-identity residual. PR #37 fixes module and tenant resolution and does not widen the residual. The dedicated-device restriction is a release condition for enabling offline operations, not a claim that the residual is resolved.
