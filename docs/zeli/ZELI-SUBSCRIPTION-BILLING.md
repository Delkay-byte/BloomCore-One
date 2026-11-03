# Zeli — Subscription Billing

## Provider

Paystack, using the documented transaction API:
<https://paystack.com/docs/api/transaction/>

No pre-existing payment integration existed in the repository. This is the first
payment adapter; it does not duplicate another payment system.

## Catalogue

`ZeliPlan` is owner-configured at `/platform/zeli`:

- code, name, description;
- billing interval (month/year);
- price and currency;
- features and usage allowance;
- trial days;
- optional Paystack plan code (for provider-managed recurring billing);
- status (draft/active/archived) and public availability.

No price is seeded. The checkout action reads the price from the database and
ignores any browser-supplied amount.

## Flow

1. Admin opens `/admin/zeli-analytics/upgrade`.
2. Server returns published, active plans and provider status.
3. Admin selects a plan.
4. Server re-checks admin role, tenant, plan availability, entitlement state and
   existing active subscription.
5. Server creates a `pending` subscription with a unique reference.
6. Server calls Paystack initialize with the database price and fixed callback.
7. Admin completes payment at Paystack.
8. Paystack calls the webhook; signature is verified over the raw body.
9. Server validates reference, amount and currency, writes a unique payment
   event, activates the subscription and upserts `zeli_analytics` with an expiry.
10. The callback page re-verifies server-side; it cannot activate by redirect.

## Lifecycle

| Event | Behaviour |
|---|---|
| Duplicate webhook | Ignored; unique event id |
| Pending | No entitlement |
| Failed initial payment | Subscription failed; no entitlement |
| Renewal | New verified payment extends/replaces period |
| Cancellation | `cancelAtPeriodEnd`; access until period end |
| Expiry | Entitlement expiry denies access |
| Refund | Subscription refunded; entitlement suspended |
| Manual suspension/revocation | Platform override remains available |
| Webhook missed | Platform “Reconcile” re-verifies by reference |

## Webhook protection

- HMAC SHA-512 with the Paystack secret.
- Raw body used, not re-serialized JSON.
- Payload size bounded.
- Amount and currency checked against the stored subscription.
- Unique event ledger prevents double activation.
- Unknown reference is acknowledged and ignored.
- No raw payload stored.

## Security boundaries

- Checkout requires tenant admin.
- Browser cannot supply tenant, amount or currency.
- Callback reference must belong to the tenant.
- Platform reconciliation requires platform session and reason.
- Platform reports expose no tenant customer/financial records.
- Revenue is labelled gross recorded value, not settled revenue.

## Limitations

- Recurring auto-charge requires an owner-configured Paystack plan code; without
  it, renewal is a new checkout.
- Trial is an explicit owner-configured grant for first-time businesses only.
- Refund policy/grace periods are not invented; no grace period is enabled by
  default.
