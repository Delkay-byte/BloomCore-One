# MaaCash — MoMo Reconciliation, Susu Withdrawal Fix and UI Improvement Report

Date: 2026-11-07
Repository: `Delkay-byte/BloomCore-One`
Feature branch: `feat/maacash-momo-reconciliation-ui-fixes`
Pull request: [#17](https://github.com/Delkay-byte/BloomCore-One/pull/17)
Base commit (`origin/main` at branch point): `02e33a8`
Squash merge commit on `main`: `4ffb17089a3491a7d94fd5e36812b31f561a045f`

**Evidence labels used below**

- **Verified** — executed in this environment or read directly from the code.
- **Calculated** — produced by the application's own arithmetic during the simulation.
- **Observation** — a finding from inspecting the implementation.
- **Recommendation** — proposed follow-up, not implemented here.

---

## 1. Baseline inspected

| Item | Finding |
|---|---|
| Repository / remote | `Delkay-byte/BloomCore-One` |
| Production branch | `main` |
| MoMo daily account model | `DailyAccount` in `prisma/schema.prisma` |
| MoMo reconciliation code | `src/lib/actions/daily-account.actions.ts`, worker form, admin history/reports, correction screen |
| Susu withdrawal | `src/app/susu/admin/withdrawals/page.tsx` → `ReauthDialog` → `verifyPasswordAction` → `processWithdrawal` |
| Auth / password | `src/lib/actions/auth.actions.ts`, `src/lib/auth.ts` (bcryptjs, cost 12), session registry and per-tab proof |
| Design system | Tailwind v4, shared `card` / `btn` / `badge` / `banner` / `form-group` classes, `CediAmount`, `PageHeader`, `StatCard`, skeletons |
| Primary production | `https://maacash.onrender.com`, service `maacash`, ID `srv-dbnaciff3r2c7382tjgg`, Auto-Deploy **off** |
| Fallback production | `https://bloomcore-one.onrender.com`, service `bloomcore-one`, ID `srv-dbjalrk9v7es739ifkp0`, Auto-Deploy **on**, same database |
| Database migrations | None introduced by this change |

---

## 2. Approved MoMo field names

### 2.1 Mapping applied

| Persisted column | Old label | Approved label | UI state |
|---|---|---|---|
| `totalCashIn` | Money added to momo | **Customer deposit** | Visible |
| `totalCashOut` | Money paid from momo | **Cash out** | Visible |
| `totalCashReceived` | Cash received | **Cash in** | Visible |
| `totalCashPaid` | Cash paid out | — (retired) | Removed from every form and calculation |

Labels are centralised in `src/lib/momo-reconciliation.ts` (`MOMO_FIELD_LABELS`) and applied consistently in:

- MoMo agent end-of-day form (`src/app/worker/daily/[id]/page.tsx`)
- MoMo agent dashboard (`src/app/worker/(workspace)/dashboard/page.tsx`)
- Administrator history, filters and summaries (`src/app/admin/(workspace)/history/page.tsx`, `src/lib/actions/momo-history.actions.ts`)
- Administrator reports table and CSV export (`src/app/admin/(workspace)/reports/page.tsx`)
- Report detail and reconciliation review (`src/app/admin/(workspace)/reports/[id]/page.tsx`)
- Administrative correction screen (`src/app/admin/(workspace)/history/[id]/correct/CorrectionForm.tsx`)
- Business administrator dashboard money breakdown
- Validation/help text and the Playwright correction test

### 2.2 Accounting behaviour before and after

**Before (verified in code):**

```
expected MoMo balance = opening MoMo + totalCashIn  - totalCashOut
expected cash         = opening cash + totalCashReceived + commission
                        + otherIncome - totalCashPaid - expenses
```

`totalCashPaid` (Cash paid out) was a second, separate input for cash paid to customers, while `totalCashOut` (Money paid from MoMo) already recorded the same customer cash-out against the MoMo balance. The two fields therefore described one movement in two places.

**After (verified and unit-tested):**

```
expected MoMo balance = opening MoMo + Customer deposit - Cash out
expected cash         = opening cash + Cash in + commission + other income
                        - Cash out - expenses
```

`totalCashPaid` is not read anywhere. It is persisted as `0` on new drafts and corrections. The column is retained (no migration) so historical submitted rows keep their original stored values and variances.

**Why this does not lose or double-count a movement**

- Cash out is applied once to the MoMo balance and once to the cash balance. That is correct because a customer withdrawal reduces both the e-money float and the cash drawer.
- The retired field is not applied at all, so cash out cannot be deducted twice.
- The regression test `matches the legacy result when Cash paid out duplicated Cash out` proves that when the old duplicate field and Cash out carried the same amount, the new formula produces exactly the old cash expectation.

### 2.3 Historical records

- Existing submitted accounts are not rewritten. Their stored `calculatedMomoVariance` / `calculatedCashVariance` remain the numbers produced at submission.
- The report detail screen computes the "Expected" line with the current rules. **Observation:** for a legacy account where `totalCashPaid` was materially different from `totalCashOut`, the freshly computed expected line can differ from the stored variance. Such rows should be audited before any bulk recalculation. **Recommendation:** run a read-only reconciliation of legacy rows and, if the business wants one consistent series, correct them through the existing revision workflow rather than a silent database update.
- Correcting a legacy account creates an immutable `DailyAccountRevision` snapshot of the old values, including `totalCashPaid`, before applying the new rules.

### 2.4 Tests added

`tests/momo-reconciliation.test.ts` (8 tests, passing):

- exact approved labels;
- approved labels present and old labels absent from the agent form, administrator pages and history action;
- balanced day produces zero differences;
- Cash out counted exactly once on the cash side;
- equivalence with the legacy duplicate-field result;
- genuine −GH₵45 cash shortfall;
- float shortage kept separate from cash shortage.

---

## 3. Susu withdrawal password verification

### 3.1 Reported symptom

On the Susu withdrawal confirmation dialog ("Confirm your identity"), the administrator entered their valid password and received **"Incorrect password"**. The confirmation requirement itself was working and had to remain.

### 3.2 Root cause (verified from the code)

`verifyPasswordAction` (older implementation) resolved the account like this:

```ts
const adminUser = await getAdminSession();
const momoUser  = await getMomoSession();
const susuUser  = await getSusuSession();

if (adminUser)      context = { module: "admin", user: adminUser };
else if (momoUser)  context = { module: "momo",  user: momoUser };
else if (susuUser)  context = { module: "susu",  user: susuUser };
```

It then fetched `db.user` by that session's `userId` and compared the submitted password with **that** account's hash.

The browser can hold more than one module session (administrator, MoMo worker, Susu collector) and the per-tab transport attaches the credential for the request's surface. When the admin session was not the credential presented to the server action, the code silently fell through to a worker or collector session and verified the administrator's password against **another person's account**. A correct administrator password therefore failed with "Incorrect password". The code comment above the function already stated the intended rule ("refuse to fall through to worker/collector sessions"), but the implementation did the opposite.

A second, smaller defect was also verified: the confirmation flow applied `password.trim()` while the sign-in flow does not. A password with leading or trailing whitespace worked at sign-in and failed at confirmation.

**Honest boundary:** the production session state at the time of the screenshot could not be inspected from this environment, so the report does not claim to have reproduced that exact browser state. The identity-confusion path and the trim divergence are proven defects in the code, and both are eliminated and covered by regression tests.

### 3.3 Fix

In `src/lib/actions/auth.actions.ts`:

1. `verifyPasswordAction(password, options?: { module?: ModuleName })` now resolves **only** the named session. If it is absent, it returns "Your session has expired. Please sign in again." and never checks another account.
2. `ReauthDialog` accepts a `module` prop and passes it through. The Susu withdrawal screen and the administrator worker-password-reset screen pass `module="admin"`.
3. The submitted password is compared exactly as typed. Empty input is still rejected.
4. Successful and failed attempts are rate-limited per user (`auth:reauth`, `RATE_LIMITS.adminSensitive`: 30 per 10 minutes).
5. The audit event records only the module and user; no password or hash is logged.

### 3.4 Security properties preserved

- Password verification is still required before the UI proceeds.
- Correct password succeeds; incorrect password is still rejected.
- Role and tenant checks (`requireTenantAdminSusu`) are unchanged.
- MFA policy enforcement in the session layer is unchanged.
- Existing rate limiting on financial mutations remains.
- No plaintext storage, no password logging, no hash exposure.
- Withdrawal authorisation and audit logging are unchanged.

**Observation / recommendation:** step-up confirmation is currently a client-side gate around `processWithdrawal`; the withdrawal server action itself requires an authenticated administrator but not a one-time reauthentication proof. A caller holding a valid admin session could invoke the action without the dialog. **Recommendation:** bind a short-lived, single-use reauthentication token (issued by `verifyPasswordAction`) to `processWithdrawal`. This is a design change beyond the reported defect and was not made silently here.

### 3.5 Tests

`tests/reauth.test.ts` (6 tests, passing):

- correct administrator password succeeds and records the right administrator;
- incorrect password fails and records a failure audit event without the password;
- failed verification creates no withdrawal;
- with only a worker session attached, the worker's own password cannot authorise the admin action (the regression for the wrong-account check);
- a password with a trailing space succeeds exactly as it does at sign-in;
- a worker session cannot process a Susu withdrawal.

---

## 4. UI improvements by role

Scope was deliberately limited to hierarchy, wording, grouping and financial clarity. No business rule, permission or route changed.

### MoMo agent

- End-of-day totals are grouped as three explained movements (Customer deposit, Cash out, Cash in) in ordinary business language.
- Cash out is explained as reducing both the MoMo balance and cash, so the reconciliation review is understandable without accounting jargon.
- Review screen labels every line with the approved terms and states "Balanced", "Short" or "Over".
- Dashboard explains the day's routine and uses Balanced/Short/Over wording with the signed amount.
- Starting/ending balance helpers now say to count the drawer and check the MoMo balance.

### Susu collector

- Cash accountability keeps collected, handed in and still-to-hand-in as separate figures.
- The difference card is worded "Still to hand in", "Over-handed" or "Hand-in balances" instead of a bare "Difference".
- A one-line recap shows collected today, handed in and still to hand in.

### Customer

- Four clear cards: savings balance, available to withdraw, paid in this cycle, commission charged.
- An explicit notice shows remaining days and the daily contribution when days are outstanding.
- Existing withdrawal and payment history, cycle history and card information are retained.

### Business administrator

- MoMo dashboard now shows Customer deposit, Cash out, Cash in and the combined cash + MoMo position at close.
- Susu overview uses "Collected from customers", "Cash paid out to customers", "Commission earned" and "Collected but not yet handed in".
- Collector accountability shows whether the difference is still owed, over-handed or balanced.
- Reports and history use the approved terms; CSV headers match the screen.
- The correction screen explains that Cash out is counted once and Cash paid out is retired.

### Shared quality

- Existing design-system classes and components were reused (`card`, `btn`, `badge`, `banner`, `StatCard`, `CediAmount`, skeletons).
- Grids collapse to one column on small screens; no horizontal form rows were added.
- Empty states, loading skeletons, confirmation dialogs and action hierarchy were left intact.

---

## 5. Verification actually executed

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **Passed** (no output, exit 0) |
| Full test suite | `npm test` | **Passed** — 65 files, 648 tests |
| New tests | `npx vitest run tests/momo-reconciliation.test.ts tests/reauth.test.ts tests/momo-two-day-reconciliation.test.ts` | **Passed** — 15 tests |
| Lint | `npm run lint` | **Passed** — 0 errors, 82 pre-existing warnings |
| Production build | `npm run build` | **Passed** |
| Browser UI | `npm run test:e2e -- e2e/correction.spec.ts` | **Passed** — 2 tests in Chromium, including the new **Customer deposit** label |
| CI | GitHub Actions run `42415866829` on PR #17 | **Passed** (lint, typecheck, tests, build) |

Not executed: the complete Playwright suite (only the affected correction spec was run), a full mobile sweep of every affected page, and before/after screenshots. The UI was reviewed at desktop width through Playwright; responsive classes were inspected but not visually regression-tested at each breakpoint. No screenshot evidence is claimed.

---

## 6. Release record

| Item | Value |
|---|---|
| Pull request | [#17](https://github.com/Delkay-byte/BloomCore-One/pull/17) — merged (squash) |
| Merge commit | `4ffb17089a3491a7d94fd5e36812b31f561a045f` |
| CI | Run `42415866829` — success |
| Primary production | `https://maacash.onrender.com`, service `maacash`, `srv-dbnaciff3r2c7382tjgg` |
| Primary deploy ID | `dep-dbnphhrl550s73friljg` (triggered by API at commit `4ffb170`) |
| Primary Auto-Deploy | Unchanged: **off** |
| Fallback service | `https://bloomcore-one.onrender.com`, `srv-dbjalrk9v7es739ifkp0`, Auto-Deploy **on** |
| Fallback release | Auto-deployed the same commit: `dep-dbnpieivcj2c738mqbbg`, live |
| Database migration | None |

### 6.1 Deployment outcome (verified)

| Check | Observed result |
|---|---|
| Primary deploy status | `dep-dbnphhrl550s73friljg` → **live** at 2026-11-07T21:34:32Z, commit `4ffb170` |
| `GET https://maacash.onrender.com/api/health` | **200** — `{"status":"ok","env":"production","commit":"4ffb17089a3491a7d94fd5e36812b31f561a045f"}` |
| `GET https://maacash.onrender.com/api/health/ready` | **200** — `{"status":"ready","database":"ok","latencyMs":1784}` |
| `GET https://maacash.onrender.com/login` | **200** |
| Fallback auto-deploy | `dep-dbnpieivcj2c738mqbbg` → **live** at 2026-11-07T21:36:31Z, commit `4ffb170` |
| Fallback `GET /api/health` | **200** |
| Auto-Deploy configuration | Unchanged: `maacash` off, `bloomcore-one` on |
| Database connectivity | Healthy (readiness probe) |

**What was not verified on production directly:** no production account was signed into, so this report does not claim a hands-on production walkthrough of the authenticated MoMo form, existing account enumeration, MFA challenge or financial-record counts. The deployed commit is identical to the commit that passed CI, the Playwright label test and the full test suite; no schema or data migration ran, and the readiness probe confirmed database access. MoMA/MFA behaviour is therefore unchanged by construction, not re-tested in production.

---

## 7. Limitations and recommendations

1. **No staging environment was available in this workspace.** All automated verification ran locally against SQLite test databases. No production data was written by the implementation work.
2. **No production test account was created.** The two-day reconciliation investigation used an isolated test database and the real server actions; see the companion report.
3. **Legacy `totalCashPaid` edge case** described in §2.3 needs a read-only audit before any historical recalculation.
4. **Step-up is UI-gated**, not bound to the financial mutation by a one-time token (§3.4).
5. **MoMo model observation:** the application treats Customer deposit as increasing the MoMo float and Cash in as increasing physical cash. A real cash-in simultaneously moves both (cash +, float −). A balanced day is achievable only when the agent enters figures consistent with these definitions. This was documented rather than silently re-modelled.
6. **Summed difference can mask a shortage:** total difference is float variance + cash variance, so a float shortfall can be offset by a cash excess. See the companion investigation, which recommends separate statuses per balance.
7. **No before/after screenshots** were captured; evidence is the passing Playwright test, the source tests and the code diff.
8. **No authenticated production walkthrough.** Production health, readiness, deployed commit and the fallback release were verified; authenticated pages, MFA and existing-record counts were not enumerated in production because no production credentials were used.
9. **Fallback release note:** because `bloomcore-one` has Auto-Deploy on, merging to `main` automatically released the same commit there. Its configuration was not changed. Both services use the same production database and the release contained no migration.

---

## 8. Files changed

- `src/lib/momo-reconciliation.ts` (new)
- `src/lib/actions/daily-account.actions.ts`
- `src/lib/actions/momo-history.actions.ts`
- `src/lib/actions/auth.actions.ts`
- `src/components/ReauthDialog.tsx`
- `src/app/worker/daily/[id]/page.tsx`
- `src/app/worker/(workspace)/dashboard/page.tsx`
- `src/app/collector/(workspace)/dashboard/page.tsx`
- `src/app/customer/(portal)/dashboard/page.tsx`
- `src/app/admin/(workspace)/dashboard/page.tsx`
- `src/app/admin/(workspace)/history/page.tsx`
- `src/app/admin/(workspace)/history/[id]/correct/CorrectionForm.tsx`
- `src/app/admin/(workspace)/reports/page.tsx`
- `src/app/admin/(workspace)/reports/[id]/page.tsx`
- `src/app/admin/(workspace)/workers/[id]/page.tsx`
- `src/app/susu/admin/page.tsx`
- `src/app/susu/admin/withdrawals/page.tsx`
- `tests/momo-reconciliation.test.ts` (new)
- `tests/reauth.test.ts` (new)
- `tests/momo-two-day-reconciliation.test.ts` (new)
- `e2e/correction.spec.ts`
