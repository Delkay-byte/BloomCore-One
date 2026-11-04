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
| Duplicate webhook | Ignored; unique canonical event id |
| Duplicate callback verification | Same canonical event id; no second extension |
| Pending | No entitlement |
| Failed initial payment | Subscription failed; pending guard cleared |
| Renewal after expiry | Extends from the verified payment time |
| Renewal before period end | Extends from the current period end; remaining paid time is preserved |
| Second checkout while one is pending | Refused with `checkout_in_progress`; database unique index also blocks the race |
| Checkout abandoned for 30 minutes | Marked expired; a new checkout can start |
| Cancellation | `cancelAtPeriodEnd`; access until period end |
| Expiry | Scheduled sweep closes the subscription and entitlement; access also denied by `expiresAt` |
| Refund for a granted period | Subscription refunded; entitlement suspended and audited |
| Payment for a superseded checkout | Automatic Paystack refund; if that fails, an open exception is queued |
| Manual suspension/revocation | Platform override remains available |
| Webhook missed | Platform “Reconcile” re-verifies by reference |
| Out-of-order events | Refund marks the payment refunded; a later charge cannot grant access |

## Renewal and duplicate-payment policy

- The extension boundary is the later of the verified payment time, the current
  subscription end and the current entitlement expiry. A payment is never lost
  because a period is still running.
- Every charge uses one canonical event identity, so the webhook and the
  callback verification cannot both grant the same period.
- A new subscription supersedes the previous active row (`status=superseded`),
  keeping the payment history.
- A payment for a checkout that a newer checkout replaced is treated as an
  unintended duplicate: Paystack is asked for a refund and no period is granted.
- A refund is never shown as successful before Paystack confirms it. Failed
  refunds create a visible open exception with the reference, amount and reason,
  and can be retried from the platform control centre.
- `periodGranted` records whether a payment actually extended access, so a
  refund for a duplicate settlement does not suspend paid access granted by a
  different payment.

## Webhook protection

- HMAC SHA-512 with the Paystack secret over the unmodified raw body.
- Payload size bounded.
- Amount, currency and reference checked against the stored subscription.
- Unique event ledger claimed before side effects, with processing state and
  stale-claim recovery.
- Unknown, unsupported, malformed and duplicate events are recorded once.
- No raw payload or secret stored.

## Security boundaries

- Checkout requires tenant admin and global Zeli availability.
- Browser cannot supply tenant, amount or currency.
- Callback reference must belong to the tenant.
- Platform reconciliation and refund retry require a platform session and reason.
- Platform reports expose no tenant customer/financial records.
- Revenue is labelled gross recorded value, not settled revenue.

## Limitations

- Recurring auto-charge requires an owner-configured Paystack plan code; without
  it, renewal is a new checkout.
- Automatic refunds depend on Paystack accepting the refund; a failure is queued
  for a human decision rather than retried blindly.
- The expiry sweep runs inside the web service every 15 minutes with a catch-up
  on start. It is idempotent. Access never depends on the sweep: `expiresAt` is
  enforced on every check.
- Trial is an explicit owner-configured grant for first-time businesses only.
- Refund policy/grace periods are not invented; no grace period is enabled by
  default.
- Production checkout requires a live Paystack key. When the production service
  is configured with a test key, checkout is closed with an honest message
  instead of taking an unsettled order.
