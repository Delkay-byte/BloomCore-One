# Pricing and business onboarding

Commercial model approved by the owner. This document records the approved catalogue, the
controlled provisioning journey, and what the shipped release enforces.

## Approved commercial terms

| Package | Monthly | Annual | Locations | Staff |
| --- | ---: | ---: | ---: | ---: |
| Starter | GH₵99 | GH₵1,070 | 1 | 3 |
| Business | GH₵169 | GH₵1,825 | 3 | 10 |
| Multi-Branch | GH₵339 | GH₵3,660 | 5 | 20 |

Internal founding programme: GH₵79 / GH₵149 / GH₵225 for the first three paid monthly periods,
limited to five eligible businesses, monthly billing only, no stacking with annual pricing, and
never reset or extended by a package change. Allocation is a Platform Super Admin decision.
Public pages deliberately show standard prices only and never expose founding prices, slots or
promotional wording; an existing founding customer still sees their agreed price in billing.

Prices live in the platform plan catalogue (`ZeliPlan`). The public page renders whatever the
catalogue publishes, so no price is duplicated in code. The approved figures above are the
source of truth for the operator who enters them.

## Implemented in this change

- Public `/pricing` page, no authentication, rendered from the catalogue: monthly and annual
  sections, per-package location/staff/support limits, features, annual saving percentage, and
  empty state when the catalogue has no published plans. It selects only standard fields and
  never reads or renders the internal founding price.
- `Pricing` added to the public navigation and to the marketing route allow-list.
- Landing hero links to pricing and to the business-owner sign-in (`/admin/login`).
- Public account-enquiry form with validation, per-IP rate limit, optional Turnstile
  verification, and a durable `AccountEnquiry` lead row. It creates no tenant, user,
  subscription or payment, and the confirmation says so.
- Platform enquiry review at `/platform/enquiries` with status transitions
  (new, contacted, qualified, converted, rejected), notes and a platform audit entry.
- Additive migration `20261118_pricing_catalogue_and_account_enquiries`: `ZeliPlan`
  location/staff/support columns plus the `AccountEnquiry` table.

## Controlled provisioning journey

MaaCash never creates an account from a public form. The path from interest to a paid workspace is:

| Step | Who acts | What happens | What is refused |
| --- | --- | --- | --- |
| 1. Enquiry | Prospective business | `/contact` demonstration request or `/pricing` account enquiry (business name, contact, phone, locations, package interest, operations to manage). Rate-limited; Turnstile is verified server-side and fails closed. A reference number is returned and the platform is notified (in-app notification plus transactional email to the platform contact). | No tenant, user, subscription or payment row is created. |
| 2. Review | Platform Super Admin | `/platform/enquiries` shows the enquiry; status moves new → contacted → qualified (or rejected), with notes and a platform audit entry. | Enquiries cannot self-convert. |
| 3. Provision | Platform Super Admin | `/platform/provision` creates the tenant and the first administrator invitation from an approved enquiry, recording the assigned plan and billing term on the enquiry. | No public sign-up route; no automatic free trial; no paid Zeli for a tenant without a verified payment. |
| 4. Invitation | Invited administrator | Receives the provisioning email, sets a password through the standard first-login flow (email verification and MFA policy apply as configured). | The platform never sets or displays a password. |
| 5. Package selection | Business owner | `/admin/billing` shows the three monthly and three annual packages from the catalogue, the founding price when the business holds a founding slot, current usage, and a usage-conflict warning if a smaller package does not fit the records already created. | Prices are read from `ZeliPlan`; nothing is hardcoded in the page. |
| 6. Payment | Business owner | Card or Ghana MoMo through the hosted Paystack checkout. A pending `ZeliSubscription` (`pending_payment`) is created first; only the server-verified Paystack event activates it. | Frontend success screens, redirects or screenshots never activate a subscription. No recurring MoMo debit is created. |
| 7. Activation | Server | `charge.success` (or verified reconciliation) marks the subscription active, records the paid period, assigns/extents the founding allocation and unlocks paid operations and Zeli within the package allowance. | Unverified or replayed events are ignored. |
| 8. Lifecycle | Server (`runBillingLifecycle`) | Reminder stages, grace period, then suspension; a verified payment reactivates. Package changes are scheduled for the next renewal with no proration. | Suspension never deletes records and never blocks a verified payment. |

While a tenant is in `pending_payment`, paid operations are blocked and redirected to
`/admin/billing?payment=required`; existing records stay intact. A tenant with no subscription
record at all is grandfathered (no enforced catalogue limits) so that introducing the catalogue
never locks an existing business out. `suspended` blocks new paid operations until payment is
verified.

## Implemented in the commercial release

- Public catalogue `/pricing` from `ZeliPlan`; six plans seeded by migration; standard prices
  only in public output. The five-slot founding allocation remains internal.
- Founding allocation model (`FoundingAllocation`, unique slot and tenant), assignment audit,
  discounted periods counted per renewal, automatic return to standard price on the fourth
  renewal, monthly billing only.
- Demonstration requests and account enquiries in one `AccountEnquiry` pipeline
  (`enquiryType`: `DEMO_REQUEST` / `ACCOUNT_REQUEST`), with reference number, platform
  notification, transactional email, review statuses, notes, and conversion into provisioning.
- Platform provisioning that records plan code and billing term; `/platform/billing` for
  subscriptions, payments, plan catalogue and outstanding reconciliation.
- Business-owner `/admin/billing`: summary, current package, usage against limits, package cards
  with monthly/annual toggle and annual saving, account-specific founding price when one is
  assigned, payment history and receipts.
- Package changes scheduled for the next renewal only (no proration, no deletion) with a
  server-detected usage conflict when the target package is smaller than current usage.
- Server-side package limits (`checkPackageLimit`) on location and worker creation, with
  grandfathering, pending-payment and suspended handling.
- Subscription lifecycle (`pending_payment` → `active` → `grace_period` → `suspended` → `active`)
  with reminder stages, scheduled reconciliation and verified activation only.
- Zeli eligibility: an active or grace-period tenant with an active entitlement and an enabled
  toggle may use Zeli within the tenant's monthly allowance (250/600/1,500). Pending-payment and
  suspended tenants receive a clear message and no paid Zeli. A tenant-level switch and a global
  switch are enforced server-side and audited, and neither deletes conversation history.
- Zeli branding only on customer-facing surfaces; no provider, model or "team testing" wording.

## Owner checks before a real payment

1. Confirm the six catalogue rows in the platform catalogue match the approved prices.
2. Confirm the Paystack endpoint is the MaaCash production endpoint and its signing secret is set.
3. Use the hosted checkout once for a small real payment to confirm activation and the receipt.
4. Confirm the platform notification address receives enquiry emails.

## Payments

Every new payment uses Paystack's **hosted checkout**
(`POST /transaction/initialize`) and offers Mobile Money, Card and Bank Transfer
on Paystack's own page. The server derives the amount, currency and email from
the approved `ZeliSubscription`; the browser cannot choose a price, package,
reference or payer address. Amounts are sent as GHS pesewas from the catalogue;
activation is server-verified and idempotent, and no automatic debit is created.

The hosted page owns the payment method, the mobile-money number, and any OTP or
PIN. MaaCash never asks for those inside its own UI. The MaaCash webhook endpoint
remains
`https://maacash.bloomcoretech.com/api/payments/paystack/webhook`; the SchemeKnit
webhook is untouched and must not be replaced.

## Local live-payment test (developer machine only)

A live `sk_live_` key on a developer machine would move real money, so it is
refused unless the owner opts in deliberately. `src/lib/payments/local-live-test.ts`
is the single decision point, and it is evaluated again immediately before a
provider charge is created.

| Condition | Variable / evidence |
|---|---|
| Explicit opt-in | `PAYSTACK_LOCAL_LIVE_TEST=true` |
| Development process | `NODE_ENV=development` (`next dev`, not `next start`) |
| Hosted deployment refused | `RENDER`, `VERCEL`, `FLY_APP_NAME`, `RAILWAY_ENVIRONMENT`, `DYNO` |
| Loopback origin | request origin or `SITE_URL` is `localhost` / `127.0.0.1` / `[::1]` |
| Isolated database | `DATABASE_URL` is a `file:` SQLite path or PostgreSQL on loopback |
| Live key | key prefix `sk_live_` (the only mode authority) |
| Payments enabled, GHS | `PAYSTACK_ENABLED=true`, `PAYSTACK_CURRENCY=GHS` |
| Exact tenant allowlist | `PAYSTACK_LOCAL_LIVE_ALLOWED_TENANT_IDS` contains the tenant id (or code). The legacy `PAYSTACK_LOCAL_TEST_TENANT` is merged into the same list, so `LOCAL-LIVE-01` keeps working. |

A refusal happens before any provider call and before a payable row is stored.
The flag never bypasses authentication, MFA, billing-role checks, subscription
rules or payment verification, and it must never be set in Render. The tenant
allowlist is server-side only; the browser cannot add a tenant to it.

`scripts/live-test-tenant.mjs` creates the original synthetic tenant
(`LOCAL-LIVE-01`, owner `livetest@demo.local`) in the local SQLite database. A
real local workspace can be approved instead by adding its tenant id to
`PAYSTACK_LOCAL_LIVE_ALLOWED_TENANT_IDS` (Jane D Wholes is `cmwm8sr6i000bs4uaut0z7d4s`
in the local verification database). A
live charge from localhost still delivers its webhook to the registered
production endpoint; the production handler acknowledges an unknown reference
with HTTP 200, records a sanitized ledger row and changes nothing.

## Payment intents and charge attempts

A reference is part of the payment intent, so it is protected:

* Selecting the package that is already pending returns the existing row,
  reference and amount. Refreshing, reopening checkout or pressing
  "Continue to payment" cannot replace it.
* Selecting a different package asks for confirmation first, and the backend
  refuses to replace an intent whose provider charge is pending, unresolved,
  failed or successful.
* `ZeliChargeAttempt` holds one row per reference. Its unique `reference` is
  the concurrency guard: a second request, even ten at once, cannot reach the
  provider twice. Only a definite rejection or a reconciled "no charge" may be
  retried on the same reference.
* Provider rejections keep a bounded, sanitized explanation (`safeMessage`);
  timeouts and 5xx answers become `unresolved` and block further charges until
  verification settles them. The browser only ever sees owner-safe text.

## Hosted checkout, legacy authorisations and internal notifications

**One primary action.** Billing and the Zeli upgrade page show
**"Pay securely with Paystack"** with the supporting text "Pay using Mobile
Money, Card or Bank Transfer. Payment is securely processed by Paystack." There
is no separate card button and no in-app mobile-money network/number form for a
new payment.

**New tab, original tab preserved.** The blank tab is opened synchronously inside
the click (before any `await`), so a popup blocker can never leave a created
transaction without a window. The handle is detached (`opener = null`) to prevent
reverse tabnabbing. The server response is validated with `isTrustedCheckoutUrl`
(HTTPS only, `checkout.paystack.com` / `paystack.com`, no embedded credentials)
before the tab is navigated. If the tab was blocked or closed, the original page
shows a toast and an explicit **Open Paystack checkout** recovery link that
reuses the same transaction; it never initialises a second one.

**Return handling.** The new tab returns to the public `/checkout/return` page.
It verifies the reference with Paystack and fulfils through the same
exactly-once path as the signed webhook. It deliberately does not require the
workspace tab session, because a new tab may not carry it; it renders no tenant
data and only the provider-verified outcome. A same-origin `localStorage` signal
lets the original billing tab re-check status when the customer returns, on
`focus` or `visibilitychange`. The original tab also keeps **Check payment
status**; neither the redirect nor the signal is treated as proof of payment.

**One ledger row per reference.** Hosted checkout claims the same
`ZeliChargeAttempt` row before `initialize`. The trusted `authorizationUrl` is
stored on the row, so a refresh, a second click or ten concurrent clicks reuse it
instead of initialising again. A definitively closed attempt may rotate to a
fresh reference; an open or unknown attempt never does. A timeout or 5xx leaves
the row `unresolved` with "do not pay again" guidance.

**Paystack reports an unpaid checkout as `abandoned`.** That label is not proof
of failure. A pending hosted attempt stays reusable for 60 minutes; a legacy OTP
or phone-prompt attempt stays open for 15 minutes. After the window, a status
check may close it so the owner can start again. `success` is always verified
server-side before access is granted.

**Legacy direct-charge codes.** An older payment that Paystack put into
`send_otp` still has a completion path. Its attempt stays `pending` with
`requiredAction="otp"` and Billing offers **Finish earlier direct-charge payment**,
which opens a fixed verification dialog (numeric keypad,
`autocomplete="one-time-code"`, focus moved to the code field, visible at any
scroll position). No new charge is initialised through this path.

* The code is posted to `POST /api/billing/payments/submit-otp`, a route handler
  rather than a Server Action because development mode logs Server Action
  arguments. The code is validated, forwarded once to `/charge/submit_otp` and
  never stored, hashed, logged, toasted or written to the ledger. Only the
  *kind* of required input is stored.
* The route refuses any reference that is not this tenant's, is not payable, or
  is not actually waiting for a code. An invalid code leaves the attempt open so
  the owner can retype it; an ambiguous provider answer marks it `unresolved`
  and tells the owner not to pay again.
* A provider `success` is still verified server-side and fulfilled through the
  same exactly-once activation path as the webhook.

Every verified payment writes, in the same transaction that grants access:

* one in-app `TenantNotification` with audience `platform` (shown in the
  Platform Super Admin console); and
* one `PlatformEmailOutbox` row keyed by the payment reference, delivered
  through the existing Resend integration to
  `PLATFORM_PAYMENT_NOTIFICATION_EMAIL`
  (default `bloomcoretechnologies@gmail.com`).

Both records are unique per reference, so a replayed webhook, a status return and
a repeated legacy OTP submission cannot create a second alert or email. Delivery
is a bounded, retryable step that never blocks the webhook or rolls back an
activation; undelivered rows are retried on later payment reconciliation.

## Safety rules honoured here

No public self-registration route, no automatic tenant creation, no live charge in tests, no
change to existing tenants, no price hardcoding in the page, no alteration of financial data.
