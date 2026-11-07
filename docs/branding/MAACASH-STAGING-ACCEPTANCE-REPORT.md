# MaaCash — Staging Acceptance Report

**Date:** 2026-11-07
**PR:** https://github.com/Delkay-byte/BloomCore-One/pull/16
**Branch:** `feat/maacash-rebrand`
**Deployed code commit:** `791e4a78d35584abae708b5bb185ec3795ea5cd5`
**Staging deployment:** `dep-dbn8g8u417fc73dr13cg`
**Deployed staging SHA:** `791e4a78d35584abae708b5bb185ec3795ea5cd5`
**Production SHA (untouched):** `e890cf92965364bd7278b4649236e3812bc8cc4e`

> Final status: **STAGING ACCEPTANCE PARTIALLY PASSED — ISSUES TO RESOLVE**
>
> The Turnstile action mismatch is fixed. Customer, MoMo, Susu, administrator and
> platform logins all passed with real Turnstile challenges and MFA on staging.
> Independent tab sessions, staging metadata, financial workflows, Paystack TEST
> success handling and Zeli passed. The only uncompleted item is physical PWA
> installation, which needs a human-owned browser profile.

---

## A. Fix

### Root cause

`src/app/login/UnifiedLoginClient.tsx` rendered one widget action, `login`, for
every non-admin role. The customer resolver verified the token against
`customer_login`, so a correct customer challenge was rejected as an action
mismatch.

### Files changed

| File | Change |
| --- | --- |
| `src/lib/security/turnstile-actions.ts` | New dependency-free typed action constants and role mapping. |
| `src/app/login/UnifiedLoginClient.tsx` | Customer renders `customer_login`; MoMo and Susu render `login`. |
| `src/app/admin/login/AdminLoginForm.tsx` | Uses the shared `admin_login` constant. |
| `src/app/platform/login/PlatformLoginForm.tsx` | Uses the shared `platform_login` constant. |
| `src/lib/actions/auth.actions.ts` | Customer, staff, legacy staff and admin guards use shared constants. |
| `src/lib/actions/platform.actions.ts` | Platform guard uses the shared constant. |
| `src/lib/actions/password-recovery.actions.ts` | Password reset uses the shared constant. |
| `src/components/security/TurnstileWidget.tsx` | Widget identity includes action and reset generation; stale tokens and status are discarded on any change. |
| `src/lib/site.ts`, `src/lib/metadata.ts`, `src/app/layout.tsx`, `src/app/robots.ts`, `src/app/sitemap.ts` | Staging-aware social metadata, noindex/nofollow, robots disallow and empty sitemap. |
| `src/lib/customer-dashboard.ts`, `src/app/customer/(portal)/dashboard/page.tsx` | Maps the customer portal dashboard to the actual nested account shape; clear empty state when no account exists. |
| `tests/turnstile-action-mapping.test.ts` | 13 regression tests. |
| `tests/staging-metadata.test.ts` | 7 staging/production metadata tests. |
| `tests/customer-dashboard-mapping.test.ts` | 3 dashboard mapping tests. |

### Action mapping before and after

| Surface | Before | After |
| --- | --- | --- |
| Customer | `login` | `customer_login` |
| MoMo Agent | `login` | `login` |
| Susu Collector | `login` | `login` |
| Administrator | `admin_login` | `admin_login` |
| Platform | `platform_login` | `platform_login` |

The server remains authoritative. No browser-supplied role or action is trusted
as identity.

### Stale challenge handling

`TurnstileWidget` now tags both the token and the status with the action and reset
generation that produced them.

- A role change remounts the Cloudflare widget.
- The old widget is removed and its callback can no longer write state.
- A token from another action is never written to the hidden form field.
- Returning to a previous role does not resurrect its old token.
- A `resetSignal` increment also creates a fresh challenge.

Token expiry, replay protection, hostname verification and server action checks
were not weakened.

### Regression tests

`tests/turnstile-action-mapping.test.ts` covers:

1. Customer renders `customer_login`.
2. MoMo renders `login`.
3. Susu renders `login`.
4. Administrator renders `admin_login`.
5. Customer → MoMo clears the previous token.
6. MoMo → Customer requires a fresh `customer_login` token.
7. A `login` token submitted to customer authentication is rejected.
8. A `customer_login` token submitted to staff authentication is rejected.
9. Matching actions pass when the remaining verification conditions are valid.
10. Expired, replayed, wrong-hostname and invalid tokens still fail closed.

These tests exercise the real `resolveCustomerAuth`, `resolveStaffAuth`,
`adminLogin` and `verifyTurnstile` paths with a stubbed Cloudflare Siteverify
response. Action verification is not mocked away.

### Additional defect found and fixed

The customer dashboard read a flat `{ account, currentCycle, collector }` shape
while `getCustomerAccount()` returns a customer with a nested `accounts` array.
With customer login previously blocked, this had stayed hidden. The dashboard now
maps the real response and shows a clear message when no active account exists.
Real staging verification after the fix reached `/customer/dashboard` with the
current cycle, balance cards and cycle history.

---

## B. Deployment

| Item | Value |
| --- | --- |
| Deployment ID | `dep-dbn8g8u417fc73dr13cg` |
| Trigger | Render API, explicit `commitId` |
| Commit | `791e4a78d35584abae708b5bb185ec3795ea5cd5` |
| Status | **live** |
| Staging URL | `https://bloomcore-one-staging.onrender.com` |
| Staging Auto-Deploy | **OFF** (`autoDeploy: no`) |
| Production Auto-Deploy | **ON — After CI Checks Pass** (`autoDeploy: yes`) |
| Service names changed | No |
| Repository renamed | No |
| Production deployment | Untouched at `e890cf9` |

### Health and readiness

| Endpoint | Result |
| --- | --- |
| `/api/health` | **200**, `status=ok`, `env=STAGING`, `commit=791e4a78d35584abae708b5bb185ec3795ea5cd5` |
| `/api/health/ready` | **200**, `status=ready`, `database=ok`, `env=STAGING` |
| Production `/api/health` | **200**, `env=production`, `commit=e890cf92965364bd7278b4649236e3812bc8cc4e` |

GitHub CI for the final SHA passed: `Lint, typecheck, test, build`, run
`42327414583`.

---

## C. Staging metadata

Staging-only environment variable:

`SITE_URL=https://bloomcore-one-staging.onrender.com`

Production `SITE_URL` remains `https://bloomcore-one.onrender.com`.

| Check | Result |
| --- | --- |
| Open Graph URL | **staging host** |
| Open Graph image | **staging host** |
| Twitter image | **staging host** |
| Production host references in social metadata | **0** |
| Canonical links on staging | **0** |
| Robots meta | `noindex, nofollow` |
| `robots.txt` | `User-Agent: *` / `Disallow: /` |
| Sitemap URLs | **0** |
| Production metadata behaviour | Unchanged |

Staging social previews now point at staging, while crawlers are refused and no
canonical URL is claimed. Evidence: `docs/branding/evidence/staging/acceptance-live/metadata.json`.

---

## D. Authenticated role matrix

All logins below used a real Cloudflare Turnstile challenge on the live staging
host. MFA was completed with TOTP; no enforcement was disabled.

| Role | Turnstile action | Turnstile | MFA | Final route | Tenant | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Administrator A | `admin_login` | Issued | Verified | `/admin/dashboard` | STG-A | **PASS** |
| Administrator B | `admin_login` | Issued | Verified | `/admin/dashboard` | STG-B | **PASS** |
| MoMo worker | `login` | Issued | Enrolled | `/worker/dashboard` | STG-A | **PASS** |
| Susu collector | `login` | Issued | Enrolled | `/collector/dashboard` | STG-A | **PASS** |
| Customer | `customer_login` | Issued | Enrolled | `/customer/dashboard` | STG-A | **PASS** |
| Platform | `platform_login` | Issued after one reload | Enrolled | `/platform/dashboard` | Platform | **PASS** |

### Platform authentication method

The platform console uses its own password login. `PLATFORM_OIDC_ENABLED` and all
other OIDC variables are absent from the staging service, so SSO is intentionally
disabled. The existing password flow was tested and passed. OIDC was not enabled.

### Role isolation

| Check | Result |
| --- | --- |
| Customer → worker route | Redirected to `/login` — **PASS** |
| Customer → admin route | Redirected to `/login` — **PASS** |
| Worker → collector route | Redirected to `/login` — **PASS** |
| Collector → worker route | Redirected to `/login` — **PASS** |
| Admin → platform console | Redirected to `/platform/login` — **PASS** |
| Worker → another branch's daily account | `Account not found` — **PASS** |
| Tenant identity from `/api/auth/me` | STG-A / STG-B as signed in — **PASS** |
| Arbitrary tenant/branch selection | No client-selected tenant accepted — **PASS** |

Evidence: `docs/branding/evidence/staging/acceptance-live/login-matrix.json`.

---

## E. Independent tabs

| Scenario | Result | Evidence |
| --- | --- | --- |
| Admin A and Admin B in separate tabs | **PASS** | Session hashes `395aec18…` and `948b8a9f…`; tenants STG-A and STG-B |
| Customer, worker and collector in separate tabs | **PASS** | Distinct role and jti hashes; modules `customer`, `momo`, `susu` |
| Refresh each tab | **PASS** | Same session hash and identity after reload |
| Copied authenticated URL into a fresh tab | **PASS** | Redirected to `/login`; `/api/auth/me` returned **401** |
| Log out tab A only | **PASS** | Tab A 401 and remained 401 after refresh; tab B stayed 200 with STG-B |
| Cross-role tab isolation | **PASS** | Worker/collector tabs retained their own role; cross-role routes were denied |

Only SHA-256 prefixes of session `jti` values are recorded. No raw session proof,
token, password or MFA code is stored. Evidence: `docs/branding/evidence/staging/acceptance-live/tabs.json`.

---

## F. Financial workflows

All actions used the synthetic staging tenant only.

| Workflow | Result |
| --- | --- |
| MoMo daily account — start, totals, ending balances, review, submit | **PASS** — submitted with `Matches` |
| Branch-scoped daily account access | **PASS** — other branch returned `Account not found` |
| Susu contribution recording | **PASS** — GH₵ 11.00 recorded, 1 day covered, counters updated |
| Susu withdrawal | **PASS** — GH₵ 10.00 processed with identity confirmation and commission |
| Collector money handed in / remittance | **PASS** — recorded GH₵ 1,000.00; expected/handed/difference and status recalculated |
| Susu contributions list | **PASS** |
| Susu withdrawals list | **PASS** |
| Remittances reconciliation view | **PASS** |
| Susu reports | **PASS** |
| MoMo reports | **PASS** |
| Money & History | **PASS** |
| CSV export | **PASS** — `maacash-momo-history-2026-11-07.csv`, 2,723 bytes, 19 lines |
| Activity History / audit | **PASS** — withdrawal, remittance, MFA enrol/verify entries present |
| Tenant separation | **PASS** — Admin A and Admin B saw only their own tenant records |

No production data was read or modified.

---

## G. Paystack

| Check | Result |
| --- | --- |
| Staging key type | **TEST** (`sk_test_*`) |
| TEST checkout initialisation | **PASS** — `Authorization URL created`, host `checkout.paystack.com` |
| Sandbox test charge | **PASS** — Paystack test card returned `success` |
| Signed `charge.success` webhook | **PASS** — `decision: processed` |
| Subscription state | **PASS** — active, `paidAt` set, period granted to 2026-12-07 |
| Entitlement | **PASS** — `zeli_analytics` active, source `subscription`, expiry extended |
| Duplicate webhook | **PASS** — same event returned `decision: ignored` |
| Callback amount mismatch | **PASS** — rejected with “The payment did not match the selected package.” |
| Unsigned/invalid webhook (retained) | **401** |
| Production Paystack configuration | Unchanged |
| Live payment triggered | **No** |

A matching success callback through the browser was not repeated because the tab
session expired during that navigation; the same fulfilment path was verified
through the signed webhook, and the callback mismatch guard was verified live.
Evidence: `docs/branding/evidence/staging/acceptance-live/paystack.json`.

---

## H. Zeli and PWA

### Zeli

| Check | Result |
| --- | --- |
| Authenticated Zeli UI | **PASS** — `/zeli` under Admin B |
| Branding | MaaCash, STG-B |
| Provider mode | `deepseek`, model `deepseek-flash`, environment `staging` |
| Response | Labeled `[EXTERNAL AI · SYNTHETIC TEST]` in team acceptance mode |
| Local fallback | Not triggered during this turn |
| Production AI settings | Not changed |
| DeepSeek secrets | Not read, printed or changed |

### PWA

| Check | Result |
| --- | --- |
| Manifest name | `MaaCash - Mobile Money, Susu & Multi-Branch Financial Operations` |
| `short_name` | `MaaCash` |
| `display` | `standalone` |
| `start_url` | `/workspace` |
| Theme colour | `#0e4d34` |
| 192 icon | 200, `image/png` |
| 512 icon | 200, `image/png` |
| Maskable 512 icon | 200, `image/png`, purpose `maskable` |
| Apple icon | 200, `image/png` |
| Service worker | Registered, scope `/`, controller active |
| Chromium installability | No installability errors |
| Physical desktop/mobile installation | **BLOCKED** — requires a human-owned browser profile and OS install confirmation; not claimed as passed |

---

## I. Quality gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | **Pass** |
| `npm test` | **61 files, 622 tests, 0 failed** |
| `npm run test:security` | **6 files, 51 tests, 0 failed** |
| `npm run lint` | **0 errors, 82 warnings** (2 fewer than the 84 baseline; no new warnings) |
| `npm run build` | **Pass** |
| GitHub CI | **Pass** — run `42327414583` |
| PostgreSQL 16 | **6 files, 32 tests, 0 failed** (`postgres:16-alpine`, localhost:55433) |
| PostgreSQL 18 | **6 files, 32 tests, 0 failed** (`postgres:18-alpine`, localhost:55435) |
| Playwright staging smoke | **1 passed** — nonce CSP on `/admin/login` |
| Playwright local Chromium | **30 passed** (including tab-session, security-header, Zeli and platform suites) |
| Playwright mobile Chromium | **1 passed** (`Pixel 7` viewport) |
| Playwright combined | **31 passed, 0 failed** in 2.7 minutes |

No tests or assertions were removed, skipped or weakened.

---

## J. Outstanding issues

| # | Issue | Severity | Impact | Required action |
| --- | --- | --- | --- | --- |
| 1 | Physical PWA installation not performed | Low | Install prompt/launch not confirmed on a real desktop or phone | Owner installs MaaCash from staging in a supported browser and confirms standalone launch |
| 2 | Full authenticated Playwright staging suite not automated | Low | Real staging role acceptance was completed interactively; automated staging suite is limited to public/security checks | Keep the real-browser acceptance evidence; extend automation only if Turnstile test strategy is agreed |
| 3 | Callback success path not repeated through the browser after tab expiry | Low | Webhook success and callback mismatch rejection are both verified; callback success uses the same fulfil path | Optional re-run with a fresh tab session |

No high or medium severity issue remains.

### Staging test data note

Acceptance-only synthetic account passwords were rotated for this run and stored
only in a local temporary file outside the repository. MFA is enabled on all six
acceptance accounts; the existing admin TOTP secrets were preserved. No password,
TOTP secret, session token or recovery code is recorded in this report or the
repository.

Synthetic staging records created or updated:

- A Susu account and cycle for `MAACASH-ACC-STG-A`.
- Two collector assignments and one contribution for the acceptance collector.
- One MoMo daily account for the acceptance worker.
- One Susu withdrawal in STG-B.
- One collector remittance in STG-B.
- Synthetic Zeli subscription/payment ledger rows used for Paystack success testing.

No existing tenant, customer, financial record or audit entry was deleted or
rewritten outside those synthetic acceptance fixtures.

---

## K. Final recommendation

### STAGING ACCEPTANCE PARTIALLY PASSED — ISSUES TO RESOLVE

- **PR:** https://github.com/Delkay-byte/BloomCore-One/pull/16
- **Branch:** `feat/maacash-rebrand`
- **Deployed code commit:** `791e4a78d35584abae708b5bb185ec3795ea5cd5`
- **Staging deployment ID:** `dep-dbn8g8u417fc73dr13cg`
- **Deployed staging SHA:** `791e4a78d35584abae708b5bb185ec3795ea5cd5`
- **Production:** untouched at `e890cf92965364bd7278b4649236e3812bc8cc4e`
- **Staging Auto-Deploy:** OFF
- **Production Auto-Deploy:** ON — After CI Checks Pass
- **PR #16:** open and unmerged

The customer-login release blocker is fixed and verified on staging. Admin, MoMo,
Susu, customer and platform authentication, tab isolation, metadata, financial
workflows, Paystack TEST success handling and Zeli all pass. The only open item is
physical PWA installation, which requires owner action. Do not merge or promote
without that owner confirmation.
