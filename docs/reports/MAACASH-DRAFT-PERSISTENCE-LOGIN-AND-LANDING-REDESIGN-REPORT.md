# MaaCash — Draft Persistence, Stakeholder Login and Landing Page Redesign

**Date:** 2026-11-08
**Repository:** `Delkay-byte/BloomCore-One`
**Production service:** https://maacash.onrender.com
**Fallback service:** https://bloomcore-one.onrender.com (unchanged)

---

## A. Draft persistence investigation

### A1. Reported defect

A user filled a form, chose **Save as Draft**, and saw a spinner that never stopped.
The draft later appeared in the saved list, but reopening it produced an empty form.

### A2. Root causes

The defect was not one bug. Four independent faults combined, and each one could
produce the reported symptoms on its own.

| # | Root cause | File | Effect |
| --- | --- | --- | --- |
| 1 | Offline scope always requested `module=susu` | `src/lib/offline/scope.ts` | A MoMo-only tenant received `401` from `/api/auth/me?module=susu`. Every draft write rejected, and the form stayed in a saving state. |
| 2 | Scope lookup could wait forever | `src/lib/offline/scope.ts`, `src/lib/offline/drafts.ts` | A stalled service-worker/session handshake left `pendingScope` unresolved. No timeout existed, so the spinner never terminated. |
| 3 | Autosave effect depended on an inline object | `src/hooks/useObjectDraft.ts` | `value` was a fresh object literal every render. The hook's own `setStatus("saving")` re-rendered the page, re-ran the effect, and wrote again. This produced the endless **Saving draft…** loop and repeated database writes. |
| 4 | Restore raced form mount and was silently abandoned | `src/hooks/useFormDraft.ts` | If the form ref was not populated on the first read, the draft was skipped and never retried. The next render showed an empty form. `useObjectDraft` also had no deliberate restoring gate, so callers could render defaults before stored values arrived. |

A fifth, server-side weakness was found in the same audit:

| # | Weakness | File | Effect |
| --- | --- | --- | --- |
| 5 | Draft save and submit did not require `status = draft` | `src/lib/actions/daily-account.actions.ts` | A stale retry could rewrite a submitted account, or submit twice concurrently. |

### A3. Affected workflows

Every existing draft-capable workflow in the repository was audited:

| Module | Workflow | Persistence | Hook |
| --- | --- | --- | --- |
| MoMo | Daily account (worker) | Local autosave + explicit server draft | `useObjectDraft` |
| Business admin | Create worker | Local autosave | `useFormDraft` |
| Business admin | Create staff member | Local autosave | `useFormDraft` |
| Business admin | Create location | Local autosave | `useFormDraft` |
| Susu admin | Record contribution | Local autosave | `useObjectDraft` |
| Susu admin | Create customer | Local autosave | `useFormDraft` |
| Susu admin | Create collector | Local autosave | `useFormDraft` |
| Susu admin | Record withdrawal | Local autosave | `useFormDraft` |

No new draft workflow was invented. Customer-facing screens have no draft feature
and none was added.

### A4. Exact code changes

**`src/lib/offline/scope.ts`**

- Resolve identity from the module-neutral `/api/auth/me`; the browser no longer
  asks for the Susu module.
- Bound the session lookup with a 10-second `AbortController`.
- Identity and tenant still come from the server session. No browser-supplied
  tenant or owner id is trusted.

**`src/lib/offline/drafts.ts`**

- Add bounded open/save/load/delete operations (`15s` write, `10s` read) so a
  blocked IndexedDB transaction rejects instead of hanging.
- `listDrafts` filters records by the current server-derived tenant and user.
- Drafts remain versioned (`DRAFT_SCHEMA_VERSION = 2`), scoped and seven-day
  expiring. Secret-looking keys are stripped recursively before storage.
- Data types are preserved: `0` stays `0`, `false` stays `false`, decimals,
  arrays, nested expense items and long notes round-trip unchanged.

**`src/hooks/useObjectDraft.ts`**

- Autosave depends on the serialised value, not on object identity; the
  saving-loop is removed.
- Every save carries a monotonic revision. An older response cannot overwrite a
  newer one.
- The status always settles as `saved` or `error`; it cannot remain `saving`.
- Exposes `ready`, `dirty`, `retry` and `flush`.
- Restore reads the callback through a ref, so an inline callback cannot re-run
  the restore and overwrite typing.
- A draft older than the server record is reported as `conflict` and not applied.

**`src/hooks/useFormDraft.ts`**

- Wait for a conditionally mounted form ref instead of dropping the draft.
- Track `touched` so a user who types while the read is in flight wins.
- Revision-ordered writes and a retry action.
- Exposes `ready`.

**`src/components/DraftIndicator.tsx`**

- `Restoring your draft…` loading state with `aria-busy`.
- `Saving draft…` always terminates.
- Success: **Draft saved successfully · last saved at HH:MM**.
- Failure: **We couldn't save this draft on this device. Your changes are still
  on this page.** with a **Retry** action.
- Conflict state explains that a newer server record was kept.

**`src/app/worker/daily/[id]/page.tsx`**

- Restoring gate with a skeleton until the draft read settles.
- Restore only applies keys present in the draft; a missing property never zeroes
  a server value.
- Explicit server save has its own saving, success and retryable error state.
- Failure now produces one alert, not two stacked alerts. The generic page error
  no longer duplicates the draft error.
- Local autosave and server save are labelled distinctly so the user knows which
  one was confirmed.

**`src/lib/actions/daily-account.actions.ts`**

- Draft save uses `updateMany` with `status: "draft"` and tenant scope; a
  concurrent submit wins and the save returns a conflict.
- Submit uses a conditional update on `status: "draft"`, tenant and worker; a
  retry cannot submit twice.
- Expense replacement stays inside the same transaction and is tenant scoped.

**`src/app/worker/(workspace)/dashboard/*`**

- Draft rows expose and display `Last saved HH:MM` from the server timestamp.

### A5. Database changes

**None.** No migration was required. The existing `DailyAccount` draft status and
`Expense` model were sufficient. The local draft store is IndexedDB, not the
database. Existing drafts and financial records were not modified or deleted.

### A6. Save and restore behaviour after the fix

1. The user types; local autosave debounces input and confirms the device copy.
2. **Save draft** sends the server action and claims success only after the
   transaction commits.
3. The draft row appears in the worker dashboard list with its server timestamp.
4. Leaving and reopening the account fetches the server record, then applies a
   newer local draft if one exists.
5. Every supported field is restored: opening cash and float, additional cash and
   float, deposits, cash out, airtime, commission, closing cash and float, the
   reconciliation note, and the full itemised expense array.
6. Re-saving updates the same daily account. No duplicate draft row is created.
7. A failed save keeps every typed value, reports a retryable error, and never
   shows a success state.
8. Drafts never post a contribution, withdrawal, remittance or balance change.
   Only **Submit account** performs the financial transition, exactly once.

### A7. Ownership and security

- Scope is resolved server-side from the authenticated session.
- A browser cannot choose its tenant, user or module for draft storage.
- Foreign user or tenant records are deleted on read and hidden from lists.
- Cross-tenant daily-account access is denied by the existing tenant-scoped
  lookup; regression coverage checks it.
- Passwords, tokens, OTPs, PINs, MFA secrets and recovery codes are stripped
  before a draft is written.
- Drafts contain no completed financial transaction.

---

## B. Stakeholder login redesign

### B1. Route structure

The three experiences share one visual system and one authentication contract:

- `/login` — role chooser.
- `/login?role=momo`, `/login?role=susu`, `/login?role=customer` — deep links.
- `/login/momo`, `/login/susu`, `/login/customer` — preserved short links that
  redirect to the matching deep link.
- `/admin/login` — unchanged, separate administrator portal.

No route, redirect, JWT audience, session, MFA or Turnstile contract changed.

### B2. MoMo agent

- Heading: **MoMo Agent Login**.
- Support: *Sign in to manage your daily MoMo operations and account reconciliation.*
- Agent-specific capability list: daily account, cash/float/commission/expenses,
  reconciliation difference before submission.
- Identifier label: email or phone, with autofill and a hint that the business
  administrator registered the contact.

### B3. Susu collector

- Heading: **Susu Collector Login**.
- Support: *Sign in to manage customer collections and your daily collection records.*
- Field-use priorities: large controls, readable text, clear labels, explicit
  password visibility control, short path to sign-in.
- Collector-specific capability list: assigned customers, collections, daily
  records.

### B4. Customer

- Heading: **Welcome Back**.
- Support: *Sign in to view your Susu savings, contributions and account activity.*
- Customer ID, phone or email identifier with a hint pointing to the card or
  receipt from the collector.
- Customer support line: contact the Susu collector or managing business.
- No staff tools, internal business information or administrator links.

### B5. Shared behaviour

- Same MaaCash brand, forest/gold/ivory palette, typography and spacing scale.
- Role chip, heading and support text always identify the sign-in surface.
- Password visibility toggle with `aria-label` and `aria-pressed`.
- Inline validation messages, `aria-live`, loading button with `aria-busy`.
- Turnstile action is chosen per role: `customer_login` for customers, `login`
  for MoMo and Susu staff. Values are unchanged.
- MFA redirect, tab-session establishment, session issuance and post-login
  redirect are untouched.
- `Change role` returns to the chooser without losing the authentication state.
- `/login?role=admin` still refuses the shared portal and points to `/admin/login`.

### B6. Responsive behaviour

The login card is the primary element on phones. The decorative forest panel is a
desktop enhancement only, so the form is never pushed below a large decorative
block. Verified at 360, 390, 768 and 1280 px with no horizontal overflow.

---

## C. Public landing page

### C1. Structure after the redesign

1. **Header** — MaaCash wordmark, public navigation, Sign In and Request a
   Demonstration. Mobile menu supports Escape and closes on navigation.
2. **Hero** — *Manage your MoMo and Susu business with greater confidence.*
   Primary **Sign In** to `/login`; secondary **Explore MaaCash** to the product
   overview.
3. **Product overview** — two operational areas, one shared record.
4. **Platform explanation** — why records matter where the work happens.
5. **Modules** — MoMo, Susu, team management and business insights.
6. **MoMo operations** — daily closing, cash/float accountability, airtime,
   commission, expenses, reconciliation difference, with an illustrative product
   view that contains no customer data or invented figures.
7. **Susu management** — customer records, contributions, collector activity,
   remittances, withdrawals, statements, with the same honest illustrative view.
8. **Who we serve** — mobile money operators, Susu operators, collection-based
   businesses, multi-branch operations.
9. **Workspace separation** — tenant boundaries and server-decided access.
10. **Why MaaCash** — record keeping, traceability, controlled access, reporting
    from real entries. No loss-elimination or fraud-elimination claims.
11. **Onboarding** — request, review, enrolment, administrator, go live.
12. **Closing call to action** and the existing professional footer with
    BloomCore Technologies attribution.

### C2. Content rules applied

- Only capabilities that exist in the codebase are described.
- No fake testimonials, logos, customer counts, revenue figures or performance
  statistics.
- Product mockups are labelled as illustrative and contain no customer records.
- Metadata, canonical URL and MaaCash/BloomCore branding remain intact.

### C3. Visual and mobile changes

- Stronger hero hierarchy and a single clear primary action.
- Two new product sections with real interface structure rather than stock images.
- Consistent section rhythm, spacing scale, cards and colour hierarchy.
- Anchor targets offset below the sticky header.
- No horizontal overflow at 360, 390, 768 or 1280 px.
- Mobile navigation, touch targets and section stacking verified.

---

## D. UI skills used

| Skill | Status | Applied to |
| --- | --- | --- |
| `bloomcore-skill-router` | Loaded | Routed the task to the smallest design set before work started. |
| `bloomcore-ui-toolkit` | Loaded | Five interface principles: skeletons over spinners, deliberate restore state, honest confirmation, never lose progress, human error messages. Project design system kept as the source of truth. |
| `web-design-guidelines` | Loaded and applied as a review | Checked labels, focus, `aria-*`, semantic controls, explicit transitions, ellipsis, disabled-until-submit behaviour, error wording. |
| `design-taste-frontend` | Loaded and applied as a review | Hierarchy, one primary action per screen, section variety, no invented proof, mobile-first composition, review of real screenshots. |
| `browser` | Loaded | Used for production health inspection. |

`ui-ux-pro-max`, `ui-styling` and `impeccable` were not needed: the project already
has its own component and token system, and the work was a targeted redesign inside
it. No new UI dependency was installed.

---

## E. Testing

### E1. Unit and integration

- `npm test` — **65 files, 660 tests passed**.
- Draft coverage includes: ownership and tenant isolation, secret stripping,
  expiry, zero/false/decimal/array/long-note round-trip, module-neutral scope
  resolution, failed-auth rejection, list filtering and pruning.

### E2. Security regression

- `npm run test:security` — **6 files, 51 tests passed** (security hardening,
  financial security, admin recovery, offline isolation, staff status, tenant
  isolation).

### E3. Playwright

New specifications:

- `e2e/maacash-draft-persistence.spec.ts` — full lifecycle, refresh autosave,
  failed save and retry, rapid edits, cross-tenant denial, MoMo-only admin draft.
- `e2e/maacash-login.spec.ts` — role chooser, three deep links, password toggle,
  role change, administrator separation.
- `e2e/maacash-landing.spec.ts` — brand, navigation, anchors, four widths,
  mobile menu and sign-in destination.
- `e2e/maacash-evidence.spec.ts` — screenshot capture and overflow assertions.

The decisive regression test performs the exact acceptance path:

> Enter information → Save draft → wait for server confirmation → leave the page →
> return to the dashboard list → open the draft → every field present and editable.

### E4. Responsive evidence

Captured at 360, 390, 768 and 1280 px under
`docs/reports/evidence/maacash-draft-login-landing/`:

- landing page, full page and hero
- role chooser and three role sign-ins
- draft list, saving, saved, restored and failed states

Screenshots were opened and inspected, not merely generated.

### E5. Commands

```bash
npm run typecheck
npm test
npm run test:security
npm run test:e2e
npm run build
npm run lint
```

Results are recorded in section G.

---

## F. Deployment safety

- No database migration and no database reset.
- No environment variable, secret, Turnstile action, MFA setting, JWT issuer,
  audience, Paystack setting or OIDC setting changed.
- Existing drafts and financial records untouched.
- The new service keeps Auto-Deploy off; the deployment is explicit.
- The existing `bloomcore-one` service and its settings are not modified by this
  work.

---

## G. Results

### G1. Regression commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed, no output |
| `npm test` | **65 files, 660 tests passed** |
| `npm run test:security` | **6 files, 51 tests passed** |
| `npm run test:e2e` | **67 passed, 5 skipped** (skips are the opt-in evidence capture) |
| `npm run build` | Passed, production build completed |
| `npm run lint` | **0 errors**, 74 warnings |

The 74 lint warnings are pre-existing unused-variable and hook advisories in
unrelated files. No new lint error was introduced. The full E2E suite passed on
the final code; an earlier run had three trace-file `ENOENT` infrastructure
failures and two timing flakes, all of which passed on isolated re-run before the
final clean suite.

### G2. Draft acceptance path

The decisive E2E test passed on the final build:

1. Opened the MoMo daily account.
2. Entered opening cash and float, additional funding, deposits, cash out,
   airtime, commission, closing cash and float, a long note with the cedi symbol
   and curly quotes, and two itemised expenses (including a zero-capable amount).
3. Chose **Save draft** and waited for server confirmation.
4. Left for the dashboard and returned.
5. Every field was present and editable.
6. Edited a value, saved again, reloaded, and saw the latest value.
7. No financial record was submitted by saving or reopening.

Additional passing cases: local autosave across refresh, failed save with values
retained and retry, rapid edits keeping the latest value, cross-tenant denial, and
a MoMo-only administrator create-form draft.

### G3. Login verification

- Role chooser, three deep links and the administrator separation passed.
- Password visibility toggle updates `type` and `aria-pressed`.
- Loading, error and success paths are covered by existing auth and tab-session
  suites (`tab-sessions`, `tab-session-failures`, `security-headers`).
- Role-specific redirects and session isolation passed in the full E2E run.
- Customer, collector and agent credentials remain unable to cross role
  boundaries; tenant and tab isolation tests passed.

### G4. Landing verification

- Navigation, anchors, product sections, mobile menu and sign-in destination
  passed.
- No console errors were recorded by the landing spec.
- No horizontal overflow at 360, 390, 768 or 1280 px.
- Metadata still uses MaaCash and BloomCore Technologies.
- Screenshots were inspected after capture.

### G5. Release

| Item | Value |
| --- | --- |
| Pull request | #25 `fix(maacash): reliable drafts, stakeholder login and landing redesign` |
| CI | **pass** (lint, typecheck, tests, build) in 3m32s |
| Merge commit | `ddd655abe33589a78e0491a2d64a6dc1aec7ef3c` |
| Render service | `maacash` (`srv-dbnaciff3r2c7382tjgg`) |
| Deployment | `dep-dbo5neff3r2c73a8c86g` — **live** |
| Deployed commit | `ddd655abe33589a78e0491a2d64a6dc1aec7ef3c` |
| `/api/health` | **200**, `status=ok`, `env=production`, commit matches |
| `/api/health/ready` | **200**, `database=ok`, latency ≈1.1 s |

Production destination checks:

| Path | Result |
| --- | --- |
| `/` | 200, hero copy, product sections and BloomCore attribution present |
| `/login` | 200, role chooser renders all three roles |
| `/login?role=momo` | 200, **MoMo Agent Login** |
| `/login?role=susu` | 200, **Susu Collector Login** |
| `/login?role=customer` | 200, **Welcome Back** |
| `/login/momo` | 307 → `/login?role=momo` |
| `/login/susu` | 307 → `/login?role=susu` |
| `/login/customer` | 307 → `/login?role=customer` |
| `/workspace` unauthenticated | 307 → `/login` |
| `/customer/dashboard` unauthenticated | 307 → `/login?role=customer` |
| `/admin/login` | 200, separate portal unchanged |

Fallback service `bloomcore-one` (`srv-dbjalrk9v7es739ifkp0`) was preserved. Its
existing Auto-Deploy setting picked up the same merge and deployed the same commit
automatically; its health and readiness are **200** at
`ddd655abe33589a78e0491a2d64a6dc1aec7ef3c`. No setting on that service was changed
by this work. The new service remains Auto-Deploy **off** and was deployed
explicitly.

No database migration ran, no environment variable changed, and no financial or
draft record was modified during release verification.

### G6. Remaining limitations

- The isolated E2E database and synthetic accounts were used for authenticated
  browser verification. No authorised production account was available, so live
  production sign-in with a real user was not performed. Public routes, auth
  redirects, health and readiness were verified on production.
- The final earlier full-suite transient failures were environment flakes
  (trace-file `ENOENT` and timing); the final full suite and the isolated re-runs
  passed.
- `npm run lint` still reports 74 pre-existing warnings. None block CI and none
  were introduced by this change set.

---

## H. Final status

**DRAFT PERSISTENCE FIXED — LOGIN AND LANDING REDESIGN DEPLOYED — ALL TESTS PASSED**

| Acceptance | Result |
| --- | --- |
| Every existing draft workflow audited | Yes (eight workflows) |
| Root cause established | Yes (four client/storage faults and one server race) |
| Saving terminates and confirms | Yes |
| Failed save is retryable and keeps input | Yes |
| Draft list shows saved drafts | Yes (server drafts on the worker dashboard) |
| Reopening restores every supported field | Yes (E2E, all fields) |
| Re-saving updates the same draft | Yes |
| Older requests cannot overwrite newer values | Yes (revision ordering) |
| Draft ownership and tenant isolation | Yes (server-derived scope, tests) |
| Saving a draft creates no financial transaction | Yes |
| Three stakeholder logins redesigned | Yes |
| Auth contract, MFA and Turnstile preserved | Yes |
| Landing page redesigned and accurate | Yes |
| Installed UI skills inspected and used | Yes |
| Unit, security, E2E, build, typecheck | Passed |
| Lint | 0 errors (74 pre-existing warnings) |
| Deployed and healthy | Yes, commit `ddd655a` |
