# MaaCash — Commercial Release Report (Pricing, Provisioning, Lifecycle)

- **Repository:** `Delkay-byte/BloomCore-One`
- **Production origin:** <https://maacash.bloomcoretech.com>
- **Release date:** 2026-11-17
- **Merged commits:** `dd13058` (PR #48, SEC-01…SEC-16) → `9c01909` (PR #50, release evidence) → `be25986` (PR #49, commercial build-out) → `8345571` (PR #51, webhook diagnostics) → `42c011b` (PR #52, signature fallback)
- **Production deploy:** `dep-dbud7rqvcj2c738jp0q0` (`42c011b`) — live
- **Database:** Neon PostgreSQL 18, 34 migrations applied, no schema drift

This report is the consolidated account of the twenty items that make up the
release. It records what shipped, how each item was verified, what is still the
owner's action, and one operational incident that occurred during the release
and how it was corrected.

---

## 1. Pricing catalogue is data, not UI copy

Six public packages live in `ZeliPlan` and are read by the marketing page:

| Code | Name | Billing | Price (GHS) | Founding (GHS) | Zeli / month | Locations | Staff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `starter` | Starter | monthly | 99 | 79 | 250 | 1 | 3 |
| `business` | Business | monthly | 169 | 149 | 600 | 3 | 10 |
| `multi-branch` | Multi-Branch | monthly | 339 | 225 | 1500 | 5 | 20 |
| `starter-annual` | Starter Annual | annual | 1070 | — | 250 | 1 | 3 |
| `business-annual` | Business Annual | annual | 1825 | — | 600 | 3 | 10 |
| `multi-branch-annual` | Multi-Branch Annual | annual | 3660 | — | 1500 | 5 | 20 |

**Verification:** `/pricing` returns HTTP 200 and renders `GH₵79`, `GH₵149`,
`GH₵225`, the monthly equivalent of each annual price, the Zeli allowance line,
and the founding table. Production `ZeliPlan` row count is 6; no price is
hard-coded in the page.

## 2. Founding-customer allocation (five businesses)

`src/lib/pricing/founding.ts` implements the programme: `FOUNDING_MAX_BUSINESSES = 5`,
`FOUNDING_PERIODS = 3`, unique `FoundingAllocation.slot`, one allocation per
tenant (`tenantId @unique`), and `consumeFoundingPeriod` as a conditional
increment so a duplicate webhook cannot burn two periods.

Rules proven by tests: sixth business receives `capacity_reached`; the
discounted price applies for exactly three monthly periods and then reverts to
the standard price; annual billing and a different package never inherit the
founding price; revoking and re-issuing an allocation preserves `periodsUsed`.

## 3. Controlled provisioning by Platform Super Admin only

`provisionBusiness` creates, in one transaction: the tenant in
`PENDING_PAYMENT`, the first administrator with `forcePasswordReset`, one
`PROV-` `pending_payment` subscription, and an optional founding slot. It
returns a one-time temporary password and links the originating enquiry
(`status = provisioned`, `tenantId`, `assignedPlanCode`, `billingTerm`).

No charge is created. Public self-registration stays disabled. A duplicate
administrator e-mail is refused and leaves no partial tenant behind (tested).

## 4. Subscription lifecycle is server-driven

`src/lib/billing/lifecycle.ts` runs hourly from `instrumentation-node.ts`:
7/3/1-day renewal reminders, transition to `grace_period`, 3/1-day grace
reminders, suspension, and repair-reactivation when a verified payment already
covers the current period. `reconcilePendingPayments` re-checks at most ten
pending references per run with idempotent `reconcile:<ref>` event ids.

Only a server-verified payment activates a subscription; redirects, screenshots
and claims never do.

## 5. Business-owner billing and receipts

`/admin/billing` shows the package, price, next payment, included Zeli usage,
grace/suspension state, the six available packages with prorated terms, and a
printable receipt at `/admin/billing/receipt/[id]`. `/platform/billing` shows
MRR, contracted annual value, collected cash, counts, upcoming renewals, grace,
suspensions, founding slots and Zeli consumption by tenant.

## 6. Enquiries create a platform notification, never an account

The public enquiry form writes `AccountEnquiry`, notifies the Platform Super
Admin in-app (`TenantNotification`, `audience = platform`, dedupe
`enquiry:<id>`), and e-mails the configured owner address. It creates no tenant,
no user, no subscription and no charge.

**Live check:** a headless submission without a Turnstile token was refused with
"We could not verify this submission…"; zero rows were written. That is the
required fail-closed behaviour. The success path is covered by unit tests
because this network cannot obtain a Turnstile token in headless Chromium.

## 7. Notifications are separated into verified events and AI insight

`NotificationFeed` labels every entry `Verified system event` or `AI insight`, so
a Zeli-generated observation can never be mistaken for a recorded system fact.
Unread counts, mark-read and dismiss are per-audience and tenant-scoped.

## 8. Zeli usage is a tenant-wide monthly allowance

`ZeliUsagePeriod` (`@@unique([tenantId, period])`) replaces the per-user 40/day
limit. `consumeZeliQuota` performs a conditional increment, so concurrent
requests cannot exceed the allowance (12 concurrent requests against a limit of
5 leave `requests = 5`). `pending_payment` and `suspended` subscriptions are
refused with `payment_required` / `subscription_suspended`. The Zeli page shows
used, remaining, reset date and the blocking reason; `zeliUsage` remains for
analytics only.

## 9. Package limits are enforced server-side

`src/lib/pricing/limits.ts` is called by every location and staff create path.
A tenant with an `active` or `grace_period` subscription is measured against
`locationLimit` / `staffLimit`; a suspended business cannot add either.
Tenants without a subscription are grandfathered so existing records are never
locked out by the introduction of a catalogue.

## 10. Paystack endpoint registered and verified

- Account endpoint: `WHK_46a54ce9` — **MaaCash Production**, enabled,
  `https://maacash.bloomcoretech.com/api/payments/paystack/webhook`
- Events (9): `charge.success`, `charge.failed`, `refund.processed`,
  `refund.pending`, `refund.failed`, `subscription.create`,
  `subscription.disable`, `subscription.not_renew`, `invoice.payment_failed`
- Provider ping: `data.ok: true`
- Unsigned delivery: HTTP 401, no event recorded
- Signed `ping`: HTTP 200, `decision: "ping"`, recorded as `signed_ping`, no
  payment or subscription effect; repeated pings are idempotent

This Paystack account contains no other endpoint; the SchemeKnit property is a
separate integration and was not touched.

## 11. Dual signature headers are handled without downgrade

Paystack sends `Paystack-Signature` and `x-paystack-signature` together. The
new header is authoritative **when its `whsec_` signing secret is configured**.
When it is not configured, the delivery is authenticated by the legacy HMAC of
the same raw body keyed by the API secret key. Once a signing secret exists an
invalid new header is rejected with no fallback (tested both ways).

Logged diagnostics on rejection contain only header presence, decision, status
and body length — never a signature, key or secret.

## 12. Turnstile P0 is closed and the widget map is reconciled

Production previously served sitekey `0x4AAAAAAFvt9wHpwkG5A_eF` while the server
held the secret for `0x4AAAAAAGEI6B_FX_oEmRex`. Correcting
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` restored login without touching the secret.

Widget inventory (Cloudflare, read-only API):

| Widget | Sitekey | Hostnames | Status |
| --- | --- | --- | --- |
| Maacash Production | `0x4AAAAAAGEI6B_FX_oEmRex` | `maacash.bloomcoretech.com` | In use by production |
| Maacash Staging | `0x4AAAAAAGEJDy4OBl7t10I3` | `maacash-staging.onrender.com`, `staging-maacash.bloomcoretech.com` | Available; staging app has no sitekey configured |
| SchemeKnit Production | `0x4AAAAAAFuZebGZnOj4TlJA` | `schemeknit.bloomcoretech.com` | Untouched |
| Bloomcore One Webpage | `0x4AAAAAAFvt9wHpwkG5A_eF` | `bloomcoretech.com` | Legacy; not referenced by the app or its served bundles |
| Bloomcore One Staging | `0x4AAAAAAFybMk8GAhMvoYXT` | `bloomcore-one-staging.onrender.com` | Belongs to a different property |

The deployed production chunks serve only `0x4AAAAAAGEI6B_FX_oEmRex`; neither
`/`, `/login` nor any sampled chunk references the legacy key. Retirement of the
legacy widget is an owner decision because the key may still be used by the
marketing domain, which this repository does not own.

## 13. Build no longer depends on the environment it is compiled in

`next build` imports every route while collecting page data. The Prisma client
was constructed at import time, so a build that generated the PostgreSQL client
while `DATABASE_URL` was absent selected the SQLite adapter and failed with a
provider mismatch. `src/lib/db.ts` now constructs the client lazily behind a
proxy that also forwards property descriptors, so security tests can still
override a client method. Verified by building with the PostgreSQL client and no
`DATABASE_URL`.

## 14. Migrations were applied to production additively

Two migrations were applied with the old release still serving traffic:

- `20261118_pricing_catalogue_and_account_enquiries`
- `20261119_commercial_lifecycle_founding_catalogue`

Both contain no `DROP`, `ALTER COLUMN` or `RENAME`. Production went from 59 to 63
public tables and gained six catalogue rows. Business data was unchanged:
`User` 12, `Customer` 4, `AuditLog` 194 before and after.

## 15. Backup was verified before any schema change

Pre-migration dump `maacash-prod-premig-20261117T201149Z.dump`, 370 576 bytes,
sha256 prefix `adb1eacd57bbdb73bb008a3f`, `pg_restore --list` clean. Restored into
a disposable PostgreSQL 18 database: **59/59 tables, per-table row counts
identical, 0 mismatches**.

## 16. Gate results

| Gate | Result |
| --- | --- |
| SQLite suite | 90 files / 983 tests pass |
| PostgreSQL suite | 10 files / 44 tests pass (new migration applied) |
| Mobile browser/offline-shell | pass (CI) |
| `tsc --noEmit` | clean |
| ESLint | 0 errors (77 warnings) |
| Production build | pass, including the Render scenario |
| Migration drift | `migrate diff` → "No difference detected" |
| Secret scan (tree + history) | pass |
| CodeQL | pass |

## 17. Verified production state

| Check | Result |
| --- | --- |
| `/api/health` | 200 |
| `/api/health/ready` | 200 |
| `/login` | 200 |
| `/pricing` | 200, six packages, founding prices and Zeli allowance rendered |
| `/platform/login` | 200 |
| Webhook, unsigned | 401, nothing recorded |
| Webhook, signed `ping` | 200 `decision: ping` |
| Paystack endpoint ping | `ok: true` |
| Public tables / catalogue rows | 63 / 6 |
| Subscriptions / enquiries created by acceptance | 0 / 0 |

## 18. Owner actions still required

1. **Paystack signing secret (recommended).** Copy the endpoint's `whsec_…`
   signing secret from the Paystack dashboard into the Render variable
   `PAYSTACK_WEBHOOK_SIGNING_SECRET`. Deliveries already verify with the legacy
   header, so this is hardening, not a blocker. Do not paste it in chat.
2. **Staging Turnstile (optional).** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is not set on
   the staging service. The "Maacash Staging" widget already lists both staging
   hostnames, so setting the key `0x4AAAAAAGEJDy4OBl7t10I3` enables login
   protection there. Confirm the staging `TURNSTILE_SECRET_KEY` belongs to that
   widget before enabling.
3. **Public contact detail.** No phone or WhatsApp number is published anywhere
   in the product; add one only when it is a real, monitored line.
4. **One live payment.** A single real Paystack payment (smallest package) is the
   only remaining end-to-end proof of `charge.success` → activation → receipt.
   Automated tests never charge money.
5. **Legacy Turnstile widget.** Retire `Bloomcore One Webpage` only after the
   `bloomcoretech.com` property confirms it no longer uses it.

## 19. Operational incident and correction (disclosed)

While enabling a temporary maintenance window, a `PUT /v1/services/{id}/env-vars`
call was used with a single variable. That endpoint **replaces the entire
environment**; production lost all 43 variables, and the next builds failed the
boot preflight ("Transactional email is required in production"). The full set
was restored from the previously captured inventory within minutes, verified as
43/43 with the Turnstile sitekey, live Paystack key, Resend sender and both
database URLs present, and the service returned to `live`.

Controls adopted: never call `PUT /env-vars`; use `POST` for a single variable.
Maintenance mode was abandoned for this release because the migration set is
purely additive, so the new schema is safe for the old release to run against.

The Paystack endpoint was recreated (`WHK_ec82ce0e` → `WHK_46a54ce9`) with the
same name, URL and nine events so that a signing secret could be issued; the
provider ping confirms the replacement.

## 20. Rollback

1. `git revert` the release merge or redeploy the previous image.
2. The two migrations are additive; they may remain in place for a rollback of
   application code alone.
3. Data created by the new release (catalogue rows) is inert to the previous
   code.
4. Paystack events are idempotent by event id and subscription reference, so a
   redeploy cannot double-activate a subscription.
