# Pricing and business onboarding

Commercial model approved by the owner. This document records what is implemented, what the
catalogue must contain, and what remains before the full journey is live.

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

## Outstanding before the journey is live

1. **Catalogue entry.** A Platform Super Admin must publish the six plans (three monthly, three
   annual) with the approved prices and limits, because the page renders the catalogue.
2. **Founding slot accounting.** Capacity (five businesses), atomic assignment, remaining-period
   display and the automatic switch to standard pricing at the fourth renewal are not
   implemented. The page states the terms but does not claim availability.
3. **Tenant owner billing screen.** Current plan, renewal date, limits, payment history and
   receipts are not yet surfaced in the tenant dashboard; PR #47's checkout action exists.
4. **`pending_payment` state.** Newly provisioned tenants are not yet placed in a restricted
   billing-only state before their first successful payment.
5. **Provisioning workflow.** Platform tenant creation does not yet capture package, billing term
   or founding eligibility in one guided flow.
6. **Platform billing dashboard.** MRR, collected cash, renewals, grace and suspension views are
   not implemented.
7. **Reminders.** Seven/three/one-day, expiry, grace and reactivation notices are not implemented.
8. **Reconciliation scheduler.** Owner-facing "Check Payment Status" exists from PR #47; a
   bounded scheduled reconciliation for outstanding pending charges is not implemented.
9. **Existing-tenant mapping.** No tenants have been assigned subscription records
   automatically. A report and a controlled assignment interface remain to be built.

## Payments

Unchanged from PR #47. Ghana mobile money only (`mtn`, `atl`, `vod`), GHS pesewas from the
catalogue, server-side verification before activation, idempotent activation, no automatic
debits. The MaaCash webhook endpoint is
`https://maacash.bloomcoretech.com/api/payments/paystack/webhook`; the SchemeKnit webhook is
untouched and must not be replaced.

## Safety rules honoured here

No public self-registration route, no automatic tenant creation, no live charge in tests, no
change to existing tenants, no price hardcoding in the page, no alteration of financial data.
