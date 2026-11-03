# Zeli — Analytics and Subscriptions

**Last updated:** 3 November 2026.

## Existing architecture inspected

The repository had:

- tenant modules (`momoEnabled`, `susuEnabled`) enforced on the tenant record;
- tenant administrators, staff roles and a customer portal;
- no billing provider, plan table, invoice table or checkout;
- no existing entitlement table for add-on products.

Decision: one `ZeliEntitlement` row per tenant and feature key
`zeli_analytics`, managed by the platform control centre under audit. No second
billing architecture and no invented pricing.

## Access matrix

| Caller state | Zeli Analytics |
|---|---|
| Active entitlement + tenant owner/admin | Allowed |
| No entitlement | Denied |
| Expired | Denied |
| Suspended | Denied |
| Revoked | Denied |
| Worker | Denied |
| Collector | Denied |
| Customer | Denied |
| Platform Super Admin | Separate `/platform/zeli` access |

"Owner/admin" maps to the existing `role = admin` in the tenant `User` table.

## Enforcement points

1. `requireZeliAnalyticsContext()` for pages and server actions.
2. `getApiZeliAnalyticsContext()` for API routes and export.
3. Navigation is filtered from `/api/auth/me`; the value is informational only.
4. No analytics query runs before the guard resolves.

## Lifecycle

- Grant: creates or reactivates an entitlement.
- Suspend: immediately denies access, preserves history.
- Revoke: immediately denies access, records actor and reason.
- Expire now: sets expiry to the current time; effective access becomes expired.
- Optional future expiry date on grant/reactivate.

Every change requires a reason (10–500 characters) and writes:

- `ZeliEntitlementEvent` (tenant-scoped history);
- `PlatformAuditLog` (platform audit).

## Conversational assistant vs Business Intelligence

They are distinct capabilities:

- `/zeli` remains available to existing users without a Zeli Analytics
  entitlement;
- `/admin/zeli-analytics` requires the entitlement;
- chat history and usage limits are unchanged.

## Billing decision

Automatic add-on billing is not implemented because the repository has no
payment/plan architecture. Inventing prices or a fake checkout would be unsafe.
If billing is added later, it must write the same `ZeliEntitlement` lifecycle,
not a parallel table.

## Refresh and freshness

- Aggregates are stored per tenant/scope/day.
- TTL is 60 seconds; a manual Refresh forces a rebuild.
- Failed refresh keeps the last successful rows and labels them stale.
- The UI states "Last successful refresh" and the auto-refresh interval.
- The system is periodically refreshed, not real-time.

## Reconciliation

Analytics totals exclude:

- contributions with `reversedAt` set;
- withdrawals that are not completed or are reversed;
- remittances with `reversedAt` set;
- records outside the selected UTC period;
- records belonging to another tenant.

Tests compare aggregate totals with direct database aggregates and with the
existing financial report definitions.
