# MaaCash Owner Dashboard Remediation — Fix Verification Report

**Branch:** `fix/maacash-dashboard-access-2026-11-27`
**Worktree:** `BloomCore-One-susu-dashboard-fixes`
**Base:** the Phase 1–9 release reconciliation commit `93917e6` (tree-identical to the deployed release merge `18e4262` on `origin/main`)
**Date:** 2026-11-27
**Status:** FIXED AND TESTED LOCALLY — not yet deployed. Deployment requires separate owner approval (Stage 7 boundary).

---

## 1. Executive summary

The business owner reported three classes of defect on the live dashboard:

1. Navigating to some menus bounced the signed-in owner to the landing page or a
   "You don't have permission to access this page" / "Back to Login" screen, and
   re-clicking the business-owner login card "restored" the previous dashboard.
2. The shift board, liquidity board and locations pages showed
   "could not be loaded" / "Failed to load locations" errors.
3. Recently added MoMo surfaces presented layout defects, and the provider
   capability disclosures were excessively technical and repetitive.

Investigation traced **each** class to its own root cause. All identified root
causes are fixed on this branch and covered by new automated tests. Nothing was
"fixed" by suppressing a message; every error path now reaches its honest state.

## 2. Root causes and corrections

### 2.1 Defect class 1 — subscription/permission denials presented as logouts

**ROOT CAUSE IDENTIFIED — FIXED AND TESTED LOCALLY.**

| # | Root cause | Correction |
|---|---|---|
| RC1 | `useRedirectHandler` (the client error handler shared by dashboard pages) replaced **every** `NEXT_REDIRECT` raised by a server action with `router.replace("/login")`. A package restriction, a role denial or a branch denial therefore looked like an expired session and bounced the owner to the sign-in flow. | The handler now extracts the server-chosen destination from the redirect digest (`redirectPathFromError`) and navigates there. Only same-origin absolute paths are honoured; `//`-prefixed and absolute URLs are refused, so the mechanism cannot become an open redirect. |
| RC2 | `getTenantContext` wrapped its whole tenant-resolution chain in a catch-all that returned `null` for **any** unexpected failure. A transient database outage was therefore classified as an invalid session, and the guard redirected the signed-in owner to the login page — an apparent logout. | Unexpected resolver failures now throw a retryable `TenantContextError` with a user-safe message. Pages render the existing error boundary (retryable, session untouched). Only a genuinely missing/expired/revoked session yields `null` and the proper sign-in redirect. |
| RC3 | `requireTenantContext` had exactly one denial shape: "go to login". Role denials, module-feature denials and branch-scope denials were indistinguishable from session loss. | When a signed-in person's business is open but the requested workspace is not available to them, the guard redirects to `/unauthorized?reason=role_denied` or `feature_unavailable`, keeping the session. The rewritten unauthorized page explains each reason in plain language and offers the right next action (including "Open Billing & Plan" for package reasons). |
| RC4 | Login issued a session and always sent the owner to `/admin/dashboard`, even when the package could not start operations; the owner then hit paid-operation gates mid-workflow and was bounced (see RC1). | `login`/`adminLogin`/MFA session issuance resolve `resolveSubscriptionAccess(tenantId)` server-side and route a blocked package straight to `billingHref(reason)` — Billing & Plan opens with an explanation of the exact state (pending payment, expired, failed, suspended, cancelled, refunded, grace). Billing & Plan itself remains reachable for every state (its guard has no paid-operations gate). |
| RC5 | The billing page showed "Complete your first payment" for **every** blocked state, which is wrong for an expired or suspended package. | `BillingClient` now renders state-specific, truthful copy per `SubscriptionAccessReason`. |
| RC6 | Clicking the business-owner card on the public login chooser silently restored the previous administrator dashboard from the browser's existing session — the reported "clicking the Admin login card returns to the dashboard" confusion. | The card links with `?switch=1`: a **deliberate** sign-in always shows the sign-in form. A plain visit to `/admin/login` still recognises a valid existing session (no re-authentication, no loop) and routes it to the dashboard — or to Billing & Plan when the package is blocked. The card never clears, recreates or corrupts a session. |
| RC7 | `enforcePaidOperations` treated "no subscription rows" inconsistently and redirected without a state reason. | It now uses the single `resolveSubscriptionAccess` classifier. Legacy businesses with no subscription rows are grandfathered; a newly provisioned `PENDING_PAYMENT` business without a package is not. The redirect carries `state=<reason>`. |

### 2.2 Defect class 2 — shift board, liquidity board and locations load errors

**ROOT CAUSE IDENTIFIED — FIXED AND TESTED LOCALLY.**

These pages call server actions (`getAdminShiftBoard`, `getLiquidityBoard`,
`getLocations`). Those actions are guarded by `requireTenantAdminMomo` /
`requireTenantContext`, which redirect (Billing & Plan, unauthorized) or throw
on failure. The client pages then:

1. caught the redirect error inside their `try/catch` (Next 16 surfaces the
   framework redirect to the awaiting caller), and
2. turned **any** catch into "The shift board could not be loaded." /
   "The liquidity board could not be loaded. Try again." / "Failed to load
   locations" — with no retry control on shift board or locations, and no
   distinction between a redirect destination and a real failure.

So every blocked-package or transient-failure condition was displayed as a
broken page — and, combined with RC1, some paths also bounced to login.

**Corrections (all three pages + dashboard):**

- Server-chosen redirects are navigated via `useRedirectHandler`, never shown as load errors.
- Genuine failures render a retryable notice with a **Try again** button; retry re-runs the read-only loader (financial actions are not re-triggered by retry of a load).
- Loading skeletons render while data is fetched (`setLoading(true)` on entry; locations previously left its loading state dangling after the first paint).
- The admin dashboard gained the same retry affordance and a bounded skeleton (`max-w-96`).
- Empty datasets continue to render the existing valid empty states; a valid empty result is never presented as an error.

### 2.3 Defect class 3a — provider capability disclosures (Stage 5)

**ROOT CAUSE IDENTIFIED — FIXED AND TESTED LOCALLY.**

The old page had a two-value status model (`sandbox` / `unavailable`) plus a
`comingSoon` boolean that could contradict the status, labelled real
integrations ambiguously, and repeated identical long warnings per provider.

**Corrections:**

- `IntegrationReadinessStatus` is now the seven-state model required by the
  disclosure rules: `available | sandbox | not_configured | unavailable |
  coming_soon | manual_process | requires_owner_setup` — exactly one per
  capability, with a legend ("How to read the statuses") on the page.
- WhatsApp: credentials present but delivery disabled by policy → `unavailable`
  (it cannot currently be used), **not** "not configured" (it is configured).
  Not configured in this deployment → `requires_owner_setup`, because the
  owner genuinely supplies the Cloud API credentials for this deployment.
- SMS: provider selected but no reviewed adapter → `unavailable`; nothing selected → `not_configured`. Neither claims delivery.
- MTN / Telecel / AT Money: `unavailable` with the operator-recorded + CSV
  reconciliation explanation; no "coming soon" pairing that implied availability.
- Banking, identity verification, customer payment status: `unavailable`, each
  with its truthful boundary (MaaCash is not a bank; no external identity check;
  Paystack bills MaaCash subscriptions only and is never a source of truth for
  customer contributions).
- Accounting: `manual_process` (CSV export/import is a real, supported workflow).
- The `comingSoon` boolean was removed entirely; a status is a single value.
- The approvals section renders only when the capability actually lists
  approvals (empty lists can no longer render).
- The page stays read-only: no connect, test-send or credential controls.
- All disclosures remain — nothing was hidden to make the product look complete.

### 2.4 Defect class 3b — MoMo layout quality (Stage 4)

**PARTIALLY FIXED — static audit complete; rendered audit recorded separately.**

Static audit of the recently added MoMo surfaces (liquidity + forecast panel,
reconciliation, anomalies, performance, risk-intelligence, shifts) found the
shared primitives already handle the reported risks:

- `CediAmount` renders the ₵ glyph via SVG text (Android-safe) and never clips.
- Tables sit inside `overflow-x-auto` containers (anomalies uses a deliberate
  `min-w-[38rem]` scrollable table).
- Cards use `flex-wrap` headers, `min-w-0` text containers and responsive
  grids (`sm:grid-cols-*`); the forecast panel's dark metric tile wraps its
  long label.
- `AppShell` provides a mobile drawer (`fixed left-0 w-64` under `md:`) and a
  responsive main column (`md:ml-64`, `max-w-7xl`).

The rendered audit at 390/768/1280/1440 px is performed on the running
application and recorded in the final remediation report. No layout defect
requiring a code change has been found so far.

## 3. Test evidence

New and updated automated tests (all run against the real test database with
real server guards; only the session cookie and the framework redirect are
mocked):

| File | Coverage |
|---|---|
| `tests/dashboard-access-matrix.test.ts` (new, 18 tests) | The full subscription-state matrix: no package, pending, failed, suspended, cancelled, refunded, expired, grace, renewed, active-included, module-not-entitled; session retention across the billing redirect; role denial ≠ subscription redirect; branch denial ≠ logout; expired session → proper sign-in flow; transient backend failure → retryable `TenantContextError`, never a logout; admin-card recognition (valid session → dashboard; blocked package → Billing & Plan; `switch=1` → form); workspace-unavailable keeps the form; open-redirect refusal in action redirects. |
| `tests/integration-readiness.test.ts` (rewritten, 10 tests) | Status-model integrity: exactly one defined status per capability; deployment-accurate states; credentials-with-delivery-off ≠ "not configured"; sandbox never reads as production (allowlist stated); no provider-confirmation claims for operator-recorded capabilities; Paystack boundary stated; mock messaging provider never reports a sent message; no secrets in serialised readiness. |
| `tests/auth-email-password.test.ts` (1 assertion updated) | A newly provisioned owner is routed to Billing & Plan **with the resolved package state** — the deliberate new contract (`&state=pending_payment`). |
| `tests/tenant-status-access.test.ts` (mock alignment) | `isSessionCurrent` mock aligned with the new denial classification; suspended/archived still go to the administrator login with `tenant_unavailable`; PENDING_PAYMENT businesses can still reach billing. |

### Regression results (final release gate, `npm run test:release`)

_Filled after the gate completes; see section 5 for the recorded numbers._

## 4. What was intentionally NOT changed

- No package prices, benefits, limits or renewal rules were invented; all copy
  is driven by the actual `resolveSubscriptionAccess` result.
- The billing page stays accessible without an active package.
- No approval workflow, gate or DPO/DPIA step was reintroduced.
- Provider disclosures were reorganised, not weakened: every limitation listed
  in the disclosure rules remains stated on the page.
- Existing financial logic, form validation and security boundaries are
  untouched; the changes are authorisation semantics, navigation and copy.

## 5. Recorded gate runs

| Run | Scope | Result |
|---|---|---|
| 1 (pre-report) | Full gate | 2,110 / 2,111 unit tests passed; 1 failure = outdated redirect assertion (section 3, row 3); gate stopped before later steps |
| 2 (after assertion update) | Full gate | SQLite provisioning ✓, PG migration rehearsal ✓, unit suite **2,111 / 2,111** ✓, PG integration suite **61 / 61** ✓; TypeScript failed on an `as const` narrowing error in the new matrix test (fixture typing only) — corrected |
| 3 (corrected tree) | Full gate | **8 / 9 steps PASS** — schema ✓, SQLite rehearsal ✓, PG migration rehearsal ✓, unit **2,111 / 2,111** ✓, PG integration **61 / 61** ✓, TypeScript ✓, ESLint ✓, production build ✓. Browser suite 118 / 129 — **run invalid**: a leaked `next start` process from an earlier gate's `verify-e2e.mjs` (Windows `shell:true` + `child.kill()` kills the wrapper, not the node grandchild) was still serving port 3101 with a stale build and mutated database; Windows allows the free-port probe to bind a specific address over the wildcard listener, so the suite ran against that stale server. Failures showed stale-data symptoms (duplicate decision rows from an earlier run's mutations). |
| 4 (e2e retry) | Browser suite | Same stale server — invalid for the identical reason (14 failures with the same signatures). |
| Infra fix | `scripts/verify-e2e.mjs` | On Windows the server is now stopped with `taskkill /pid <pid> /T /F`, killing the whole process tree; the leaked process was terminated and port 3101 verified free after the next run — the fix demonstrably works. |
| 5 (clean environment) | Browser suite | **127 / 129 passed**; the only 2 failures were the outdated `maacash-coming-soon.spec.ts` assertion still expecting the old page heading ("Integration readiness") and the removed coming-soon badges on `/admin/integrations` — the Stage 5 redesign deliberately replaced that model. Spec rewritten to assert the new truthful status model (one status per capability, Unavailable/Not configured/Manual process/Requires owner setup per deployment state, no Coming-soon labels, no live provider actions, legend present). |
| 6 (rewritten spec) | `maacash-coming-soon.spec.ts` on a fresh seed | **8 / 8 passed** across chromium and mobile-chromium. |
| 7 (final full suite) | Browser suite, final tree | _pending_ |

## 6. Deployment boundary (Stage 7)

This branch is **not** deployed. The Phase 1–9 release (commit `18e4262`) is
live; the fixes here are a **separate release** requiring:

1. This branch pushed and a pull request opened targeting `main`.
2. CI green on the pull request.
3. Owner approval of this report.
4. Merge → Render auto-deploy → smoke verification.

No database migration is required for these fixes (no schema change).
