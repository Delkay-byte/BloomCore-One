# Pricing and business onboarding

Commercial model approved by the owner. This document records the approved catalogue, the
controlled provisioning journey, and what the shipped release enforces.

## Approved commercial terms

| Package | Monthly | Annual | Locations | Staff |
| --- | ---: | ---: | ---: | ---: |
| Starter | GH₵99 | GH₵1,070 | 1 | 3 |
| Business | GH₵169 | GH₵1,825 | 3 | 10 |
| Multi-Branch | GH₵339 | GH₵3,660 | 5 | 20 |

Founding promotion: GH₵79 / GH₵149 / GH₵225 for the first three paid monthly periods, limited
to five eligible businesses, monthly billing only, no stacking with annual pricing, and never
reset or extended by a package change.

Prices live in the platform plan catalogue (`ZeliPlan`). The public page renders whatever the
catalogue publishes, so no price is duplicated in code. The approved figures above are the
source of truth for the operator who enters them.

## Implemented in this change

- Public `/pricing` page, no authentication, rendered from the catalogue: monthly and annual
  sections, per-package location/staff/support limits, features, annual saving percentage,
  founding terms, and empty state when the catalogue has no published plans.
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

- Public catalogue `/pricing` from `ZeliPlan`; six plans seeded by migration; founding prices and
  the five-slot allocation.
- Founding allocation model (`FoundingAllocation`, unique slot and tenant), assignment audit,
  discounted periods counted per renewal, automatic return to standard price on the fourth
  renewal, monthly billing only.
- Demonstration requests and account enquiries in one `AccountEnquiry` pipeline
  (`enquiryType`: `DEMO_REQUEST` / `ACCOUNT_REQUEST`), with reference number, platform
  notification, transactional email, review statuses, notes, and conversion into provisioning.
- Platform provisioning that records plan code and billing term; `/platform/billing` for
  subscriptions, payments, plan catalogue and outstanding reconciliation.
- Business-owner `/admin/billing`: summary, current package, usage against limits, package cards
  with monthly/annual toggle and annual saving, founding terms, payment history and receipts.
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

Unchanged from PR #47. Ghana mobile money only (`mtn`, `atl`, `vod`), GHS pesewas from the
catalogue, server-side verification before activation, idempotent activation, no automatic
debits. The MaaCash webhook endpoint is
`https://maacash.bloomcoretech.com/api/payments/paystack/webhook`; the SchemeKnit webhook is
untouched and must not be replaced.

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
| Designated synthetic tenant | `PAYSTACK_LOCAL_TEST_TENANT` matches the tenant id or code |

A refusal happens before any provider call and before a payable row is stored.
The flag never bypasses authentication, MFA, billing-role checks, subscription
rules or payment verification, and it must never be set in Render.

`scripts/live-test-tenant.mjs` creates the one synthetic tenant
(`LOCAL-LIVE-01`, owner `livetest@demo.local`) in the local SQLite database. A
live charge from localhost still delivers its webhook to the registered
production endpoint; the production handler acknowledges an unknown reference
with HTTP 200, records a sanitized ledger row and changes nothing.

## Safety rules honoured here

No public self-registration route, no automatic tenant creation, no live charge in tests, no
change to existing tenants, no price hardcoding in the page, no alteration of financial data.
