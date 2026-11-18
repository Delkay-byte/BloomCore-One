# MaaCash onboarding, billing and Zeli release — consolidated report

Branch: `fix/maacash-onboarding-billing-zeli` (local only)
Base: `origin/main` at `9c01909`
Status: **implemented and verified locally. Nothing has been pushed, merged, deployed or sent
to CI.** Production remains on the current release.

## 1. Summary

This change fixes the production enquiry failure (P0) and completes the customer-facing
commercial journey: public copy and privacy, no public platform link, a rebuilt Subscription &
Billing screen, a documented controlled provisioning flow, Zeli moved from team testing to paid
production eligibility, platform-level Zeli controls, removal of provider branding, a polished
Zeli experience, preserved enquiry/contact workflow, and automated coverage for all of it.

One new additive migration is included. No existing table or column is dropped, no production
data is touched, and no price is hardcoded in the UI.

## 2. P0 — public enquiry Cloudflare Turnstile

**Root cause.** `PricingEnquiryForm` read `cf-turnstile-response` from the submitted
`FormData`, but the form never rendered a `TurnstileWidget` and no hidden field was ever
populated. Every submission therefore carried an empty token, and the server correctly failed
closed with "We could not verify this submission". The green checkmark the owner saw came from
a widget rendered elsewhere on the marketing page, not from the enquiry form.

**Fix.**
- The enquiry form now renders `TurnstileWidget` with the dedicated `account_enquiry` action and
  reads the token from the widget state.
- The client refuses to submit without a token and shows "Please complete the verification
  check" instead of a silent failure; any server-side failure bumps `resetSignal` so a fresh
  token is obtained before retrying.
- `turnstile-actions.ts` gains `accountEnquiry: "account_enquiry"` and the matching action
  constant; the server verifies that exact action.
- Server behaviour is unchanged and still **fails closed**: missing, expired, replayed,
  wrong-action or failed verification all reject, the token is single-use, and nothing is
  created on rejection. Reviews are rate-limited before and after verification.
- A 10-minute duplicate guard (business name + phone) returns the existing reference instead of
  creating a second enquiry.
- Security events now log a sanitized `outcome: "blocked"` with error codes only — no token,
  email or phone.

Verified locally: the form renders, submits, shows the reference, and writes exactly one
`AccountEnquiry` plus one platform notification. A submission without a token is rejected and
creates nothing (covered by `tests/enquiry-turnstile.test.ts`).

## 3. P1 — public copy and legal notices

- Removed the "Draft — pending owner and legal review" banner, `DraftNotice`, every "not
  reviewed by a lawyer" style phrase and all internal review wording from public pages.
- `/privacy` is now a factual privacy notice covering: what the enquiry form collects and why,
  Turnstile processing, stored operational data, Zeli usage records, cookies/session handling,
  offline device storage, processors, retention and how to ask for correction or deletion.
  Contact details appear only when the owner-configured contact address exists; no phone number
  is invented.
- `/terms` is a short "Service terms" page describing the commercial relationship without
  claiming legal review; it is marked `robots: { index: false }`.
- `LEGAL_ROUTES` now contains only the privacy notice, so the footer no longer advertises a
  document that is under review.

## 4. P2 — platform link removed from public navigation

The `Platform administration` link (and its import) is gone from the marketing footer. No
public page or navigation entry points at `/platform/login`. The route itself is unchanged and
still protected by the platform session, MFA policy and rate limiting.

## 5. P3 — Subscription & Billing redesign (`/admin/billing`)

- Three package cards per billing term, from the catalogue only: Starter GH₵99/1,070, Business
  GH₵169/1,825, Multi-Branch GH₵339/3,660, with 1/3/5 locations, 3/10/20 staff, and
  Zeli allowances of 250/600/1,500.
- Monthly/annual toggle with annual saving computed from the catalogue, selection state, and
  the "Selected" ring. Payment fields (MoMo number + hosted checkout) appear only after a
  package is chosen; the old "There is nothing to pay right now." string is replaced by a
  neutral state.
- Current-subscription summary: package, term, status, renewal date, next payment, Zeli usage,
  locations used/limit, active staff/limit.
- Founding offer is displayed only for a business that actually holds a founding allocation:
  GH₵79/149/225 for the first three paid monthly periods, then the standard price; no annual
  stacking; the used/remaining period count is shown.
- `Change package` scrolls to the selector. A change is **scheduled for the next renewal**
  (no proration, no immediate charge, nothing deleted) and can be cancelled. If the target
  package cannot hold current usage (for example 2 locations on Starter), the card says so and
  names the numbers rather than blocking the business.
- `This is your current package` disables the schedule action for the current plan.
- Fixed a release defect found while testing: the package grid filtered catalogue rows
  (`month`/`year`) with the toggle values (`monthly`/`annual`) and rendered no cards on an active
  subscription. The mapping is now explicit and guarded by a test.
- Payment history with date, package, amount, status, period and receipt link; `Print receipt`
  view retained.

## 6. P4 — controlled provisioning journey

Documented end to end in `docs/pricing/PRICING-AND-ONBOARDING.md` and implemented:

1. Public enquiry (no account, no charge) → reference number, platform notification, email.
2. Platform review with statuses and notes (`/platform/enquiries`).
3. Platform provisioning from an approved enquiry (`/platform/provision`), recording plan code
   and billing term on the enquiry.
4. Invitation and first-login password setup through the standard verified flow.
5. Owner package selection.
6. Paystack hosted checkout (card or Ghana MoMo) creating a `pending_payment` subscription.
7. Server-verified activation only; no redirect, screenshot or claim can activate.
8. Lifecycle: reminders, grace, suspension, verified reactivation, scheduled reconciliation.

Public self-registration stays disabled, no free trial is created automatically, and paid
operations are blocked while a subscription is `pending_payment` (or `suspended`) with a redirect
to billing. A tenant with no subscription record at all remains grandfathered so existing
businesses are never locked out.

## 7. P5 — Zeli in production for paid businesses

- Zeli eligibility is server-evaluated: active or grace-period subscription, active entitlement,
  global switch on, and tenant switch on. Pending-payment and suspended tenants see a clear
  message and receive no paid Zeli.
- Allowances are the package values (250/600/1,500 requests per calendar month) enforced on a
  tenant-wide `ZeliUsagePeriod`, concurrency-safe, with the reset date shown.
- The service refuses a turn for a disabled tenant at the domain layer
  (`assertZeliTenantEnabled`), not only in the UI, and the chat route returns 403 for a disabled
  tenant.
- Conversation history is preserved when Zeli is paused or a quota is reached.

## 8. P6 — Platform Super Admin controls

- Existing global availability switch retained (audited, reason required).
- New per-business switch at `/platform/zeli`: list, enable and pause, each with a mandatory
  reason (≥10 characters), rate limiting, a transactional `ZeliTenantAccess` upsert and a
  `PlatformAuditLog` entry (`zeli.tenant_enabled` / `zeli.tenant_disabled`).
- Missing access row is treated as enabled, so existing tenants are unaffected by the migration.
- Enforced on the server; the browser cannot grant access. Disabling never deletes history or
  usage records.

## 9. P7 — provider branding removed from customer-facing surfaces

- Tenant-facing Zeli surfaces show "Zeli" only: no provider, model, endpoint, "external
  provider" or "Team Testing" wording. `provider-status.ts` (which surfaced provider state to
  tenants) is deleted, bootstrap status is reduced to `{ available: boolean }`, and the chat
  response no longer carries provider/model/policy headers.
- A guard test scans `src/app` and `src/components` (excluding the platform console) for
  `deepseek`, `team testing` and `external provider`.
- The platform console keeps operator-only diagnostics; that console is not customer-facing.

## 10. P8 — Zeli experience

Single-file chat UI with welcome state, data-grounded suggestions (activity, month comparison,
contributions/withdrawals, income/expenses, remittance variance, exceptions, branch comparison,
chart explanation), conversation sidebar, message bubbles, copy and feedback, retry on failure,
loading skeleton, fatal/retry state, readable usage meter with reset date, responsive layout,
and an accessible composer (labelled textarea, Enter to send, Shift+Enter newline, disabled send
when empty). Read-only by default: Zeli cannot post, approve, reverse or delete money.

## 11. P9 — contact and enquiry workflow preserved

Public contact page, footer "Contact" entry, `/pricing` enquiry form and the business-owner
sign-in link remain. Each accepted enquiry gets a reference, a platform notification
(`dedupeKey: enquiry:<id>`) and a transactional email to the platform contact address. No phone
or WhatsApp number was invented; the owner must publish one when it exists.

## 12. P10 — tests and verification

| Gate | Result |
| --- | --- |
| Full SQLite suite | **94 files / 1,015 tests passed** |
| New enquiry tests | 9 (valid, missing token, rejected, replay, expired, duplicate, rate limit, invalid input, no tenant created) |
| New billing tests | 12 (selection, founding price, pending expiry on change, annual, schedule, usage conflict, Business fits 2 locations, cancel scheduled, overview states, term mapping) |
| New Zeli tenant tests | 6 (default enabled, server-side disable, history preserved, global switch, no Team Testing leak, authorised tester still works) |
| New public-site tests | 9 (no platform link, routes intact, no draft phrases, no `DraftNotice`, privacy content, no invented phone numbers) |
| Branding guard | 4 |
| `tsc --noEmit` | clean |
| Lint | 0 errors, 76 pre-existing warnings |
| Production build (`next build`) | passed, including the PG client build |
| PostgreSQL migrations | new migration applied to a disposable PG 18 database; `prisma migrate diff` → "No difference detected" |

No test was weakened or skipped. Two test rows needed fields that the schema requires
(`reason` on `ZeliAiTenantAuthorization` and `ZeliTeamTester`) and one assertion was tightened to
tolerate JSX line breaks.

## 13. Migration

`prisma/migrations/20261120_zeli_tenant_access_and_scheduled_plan/migration.sql` — additive only:

- `ZeliSubscription.scheduledPlanCode`, `scheduledBillingTerm`, `scheduledAt`.
- `ZeliTenantAccess` (tenant PK, `enabled` default true, `reason`, `updatedById`, timestamps,
  cascade FK to `BusinessTenant`).

Both `prisma/schema.prisma` and `prisma/schema-pg.prisma` are updated. Rehearsed on disposable
PostgreSQL: all migrations apply, then `migrate diff --exit-code` reports no difference.

## 14. Local demo, release plan and budget

**Local demo (already seeded):** `http://localhost:3100` (running on this machine).

| Role | Where | Credentials |
| --- | --- | --- |
| Business owner (admin) | `/admin/login` | `owner@demo.local` / `DemoOwner!2026` |
| MoMo staff | `/login` → MoMo Agent | `worker1@demo.local` / `DemoOwner!2026` |
| Platform Super Admin | `/platform/login` | `platform@demo.local` / `DemoPlatform!2026` |

The demo database (`demo.db`, git-ignored) is synthetic: one business, 2 locations, 3 staff, an
active founding Business subscription, and one platform enquiry. Turnstile is disabled for
localhost only (`TURNSTILE_ENABLED=false`); production still fails closed. Reseed any time with
`DATABASE_URL="file:./demo.db" node scripts/demo-seed.mjs` (the script refuses a non-SQLite URL).

**Recommended release plan when the owner authorises it:** push the branch → one CI run on the
PR → review the diff → merge → apply the additive migration to production
(`migrate deploy`, with `NODE_OPTIONS=--dns-result-order=ipv4first`) → deploy → verify `/login`,
`/pricing`, enquiry submission with the live Turnstile widget, `/admin/billing`, `/zeli` and
`/platform/zeli`.

**Budget:** 0 GitHub Actions minutes and 0 Render minutes used so far; no CI run, preview
service or deploy was triggered. The plan above needs one CI run plus one deploy; the migration
is additive and does not require maintenance mode.

**Rollback:** revert the deploy and leave the additive migration in place (old code ignores the
new columns and table); no data rollback is needed.

## Owner actions

1. Publish a real, monitored contact phone/WhatsApp on the contact page when one exists.
2. Confirm the six catalogue prices in the platform console before the first real payment.
3. Run one small live Paystack payment to confirm `charge.success` → activation → receipt.
4. Verify the platform notification address receives enquiry emails in production.
