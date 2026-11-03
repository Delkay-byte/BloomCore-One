# Zeli — Global Availability Master Switch

**Scope:** entire tenant-facing Zeli product.
**Separate from:** external-AI policy, DeepSeek emergency stop, tenant
subscription entitlement.

## Database

Table `ZeliAvailability`, singleton row `id = "global"`:

- `enabled` boolean;
- `reason`;
- `updatedById` (platform operator);
- `createdAt` / `updatedAt`.

Migration `20261103_zeli_global_availability` creates the table and inserts an
**enabled** row, preserving availability for existing installations. Fresh
databases after `migrate deploy` therefore start ON.

Runtime behaviour:

- row present: use `enabled`;
- row missing: **OFF** (fail closed);
- database error: **OFF** (fail closed).

No in-memory cache. Every request reads the row, so disabling applies across all
Render instances immediately.

## What it controls

- `/zeli` page and all conversation actions;
- `/api/zeli/chat`;
- conversation create/list/read/rename/delete/feedback;
- `/admin/zeli-analytics` pages, refresh, explanations and server actions;
- `/api/zeli/analytics/export`;
- Zeli checkout and trial start;
- navigation entries for tenant roles.

## What it does not control

- Paystack webhook and subscription lifecycle processing;
- subscription cancellation, refunds, expiry and reconciliation;
- platform `/platform/zeli` controls;
- platform entitlement management;
- audit history and existing data;
- unrelated BloomCore One functionality.

Disabling does not delete, expire or suspend any subscription or entitlement.

## Super Admin UI

`/platform/zeli` → **Global Zeli Availability**:

- ON/OFF badge, current status, last change and reason;
- Enable/Disable with mandatory reason;
- explicit confirmation;
- success/failure feedback;
- platform-session authorization only.

Audit: `zeli.availability_enabled` / `zeli.availability_disabled`, with previous
value, new value, reason, actor, timestamp.

## Distinctions shown in the UI

1. Entire Zeli availability.
2. External-AI mode (disabled/synthetic/approved).
3. DeepSeek emergency stop.
4. Tenant Zeli Analytics subscription entitlement.

## Verification

Staging: 26/26 internal checks passed, including OFF/ON across all tenant roles,
chat/analytics/export blocking, platform accessibility, subscription preservation
and immediate recovery.

Local:

- All four tenant roles blocked from direct service turns when OFF.
- Chat API and analytics export return 503.
- Analytics action returns no data.
- Paystack webhook still activates entitlement while OFF.
- Provider controls remain usable while OFF.
- Missing row fails closed; existing row preserves ON.
- Browser test disables Zeli, verifies tenant pages/API, then re-enables.
