# Paystack live billing for MaaCash

Subscription billing for Zeli Business Intelligence on the `maacash` Render service.
Everything here is server-side; the browser never sees a secret and never supplies a price.

## Configuration contract

| Variable | Required | Where it comes from | Notes |
| --- | --- | --- | --- |
| `PAYSTACK_SECRET_KEY` | Yes | Paystack → Settings → API Keys & Webhooks → Secret Key | `sk_live_…` in production, `sk_test_…` elsewhere. Server-only. Blank or test-prefixed keys close live checkout automatically. |
| `PAYSTACK_WEBHOOK_SIGNING_SECRET` | Recommended | Paystack → Developers → API configuration → Webhook signing secret (`whsec_…`) | Enables verification of the timestamped `Paystack-Signature` header. Optional while the account still delivers only the legacy header. |
| `PAYSTACK_WEBHOOK_SIGNING_SECRET_PREVIOUS` | Rotation only | The outgoing signing secret during a dashboard rotation window | Keeps deliveries valid while the dashboard overlaps two secrets. Remove when the overlap ends. |
| `PAYSTACK_PUBLIC_KEY` | **Not needed** | — | There is no Paystack Inline/JS integration; checkout and charges are server-side. |

No separate live/test flag exists. The key prefix decides the mode, so a flag cannot drift
out of sync with the credential. Production checkout is refused unless the key is `sk_live_`.

## Webhook

- URL: `https://maacash.bloomcoretech.com/api/payments/paystack/webhook`
- Method: `POST`, raw body preserved for signature verification
- Events: `charge.success` is required. `charge.failed`, `refund.pending`,
  `refund.processed`, `refund.failed`, `subscription.create` and `subscription.disable`
  are also handled when present.
- Responses: `200` for acknowledged events, including events the handler ignores (unknown
  reference, duplicate delivery, unsubscribed event). `401` for a delivery that fails
  signature verification. `500` only when processing must be retried by Paystack.

### Signature verification

Two schemes are supported, and the newer one wins when present:

1. `Paystack-Signature: t=<unix>,v1=<key id>:<128 hex>[,v1=…]` — HMAC-SHA512 over
   `"<t>.<raw body>"` keyed with the whole `whsec_` secret. Timestamps more than 300
   seconds from server time are rejected. Every `v1` is compared, in constant time, so a
   rotation with two active secrets keeps working.
2. `x-paystack-signature` — HMAC-SHA512 over the raw body keyed with the secret key. Used
   only when `Paystack-Signature` is absent. A present-but-invalid new header is never
   rescued by the legacy header.

### Idempotency

Every event is claimed in `ZeliPaymentEvent` by a canonical id
(`paystack:<event>:<provider id>` or `paystack:charge.success:ref:<reference>`), so a
redelivery — or the return callback racing the webhook — activates at most one paid period.
A payment for a checkout that a newer checkout superseded is refunded, never granted twice.

## Ghana mobile money

Customers pay from the subscription screen with their network and number:

| Network | Paystack provider code |
| --- | --- |
| MTN MoMo | `mtn` |
| ATMoney / Airtel Money | `atl` |
| Telecel Cash | `vod` |

- Amount is the catalogue price in GHS converted to pesewas (`Math.round(price * 100)`).
  The price is read from the database; nothing from the request can change it.
- Phone numbers are normalised to the local `0XXXXXXXXX` form Paystack documents.
- `POST /charge` returns `data.status` (`pay_offline` in the normal case) and
  `data.display_text`. That text is shown to the customer; **no payment is recorded from
  this response**.
- The customer authorises on their phone within 180 seconds. `charge.success` arrives at
  the webhook. Direct mobile money references carry the `ZELIM-` prefix, and the handler
  re-verifies the transaction with Paystack before any period is granted. If verification
  is unavailable the handler answers `500` so Paystack retries; nothing is activated.
- The screen offers "Check payment status", which calls the same server-side verification.
  Pending, failed and abandoned states are reported honestly and never grant access.
- There is no automatic monthly debit. Mobile money charges are customer-initiated each
  time; renewals repeat the same flow.

## Test mode and live mode

- Automated tests stub every provider call; no live charge is made by the suite.
- Test keys (`sk_test_`) can be used outside production. In production a test key leaves
  checkout closed with an honest message, so a test-mode order can never be settled as a
  live subscription.
- A single low-value live charge is the only manual step, and only with the owner's
  explicit approval of amount, account and timing.

## Verification evidence

- Unit and integration suite: 889 tests / 84 files, including 18 dedicated mobile money
  tests (signature schemes and rotation, stale timestamp, tampered body, legacy fallback,
  charge body shape, provider/currency/phone validation, pending handling, single
  activation, cross-tenant refusal, duplicate webhook delivery, unknown reference
  acknowledgement, invalid signature rejection).
- Typecheck clean, lint 0 errors, production build successful.
- Existing billing lifecycle coverage (renewal extension, duplicate settlement, refunds,
  suspension, trial, grace period, annual intervals) continues to pass.

## Outstanding owner action

Set the Paystack Dashboard webhook URL to the canonical endpoint above and enable
`charge.success`. If the dashboard offers a webhook signing secret, create it and add
`PAYSTACK_WEBHOOK_SIGNING_SECRET` to the `maacash` service environment; the code already
verifies it. Until then the legacy signature remains the verified proof.
