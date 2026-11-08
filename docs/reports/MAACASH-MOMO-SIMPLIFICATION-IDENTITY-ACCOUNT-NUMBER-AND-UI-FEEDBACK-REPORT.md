# MaaCash — MoMo Simplification, Dual-Role Identity, One Account Number and Global UI Feedback

**Repository:** `Delkay-byte/BloomCore-One`
**Release branch:** `feat/maacash-simplified-momo-account-number-feedback`
**Pull request:** #27
**Merge commit:** `980ffa0` (implementation commits `a78b86c`, `a90f07f`)
**Migration:** `20261109_momo_simplified_daily_account`
**Report date:** 2026-11-08

---

## A. MoMo daily accounting

### Approved form fields

**Start of Day**

1. Total Physical Cash
2. Total E-cash

**End of Day**

1. Total Physical Cash
2. Total E-cash
3. Expenses
4. Commission
5. Debts Collected

These are the only editable financial fields. Customer deposit, Cash in, Cash out, Airtime sold, Additional Cash Received and Additional MoMo Float Received are not rendered. The old database columns remain for historical readability.

### Formula implemented

```text
Expected closing accountability =
  opening physical cash
  + opening E-cash
  + debts collected
  + commission
  - expenses

Actual closing accountability =
  closing physical cash
  + closing E-cash

Difference = actual closing accountability - expected closing accountability
```

Implemented in `src/lib/momo-reconciliation.ts` using integer pesewas internally. `toPesewas` rounds each input to two decimals, all sums run on integers, and `fromPesewas` returns the final money value. Binary floating-point drift therefore cannot change a difference.

### Expenses

One editable **Expenses** total is the amount used. Optional itemised expense lines are preserved for the audit trail (`Expense` rows) and never replace the entered total. Expense input is validated as non-negative and bounded.

### Commission

Entered once from the provider statement. It increases expected accountability. No percentages, estimates or per-transaction commission are generated.

### Debts Collected

Money received from people who previously owed the agent. It is added once. It is separate from deposits, owner funding, commission and ordinary cash-in. No customer-by-customer debt ledger was added to the daily form.

### Positive, balanced and negative states

| Difference | Label | Colour |
|---|---|---|
| Zero | `BALANCED` | Green |
| Positive | `POSITIVE DIFFERENCE` | Green |
| Negative | `SHORTAGE — INVESTIGATION REQUIRED` | Red |

A shortage blocks submission until an explanation is entered. The counted cash and E-cash are never altered to force a balance. Positive differences remain green and invite an explanation without blocking submission.

### Draft compatibility

Drafts persist all current fields: opening cash, opening E-cash, closing cash, closing E-cash, Expenses, Commission and Debts Collected, plus the explanation and optional expense lines. Restore applies only keys present in the draft so a missing key cannot zero a server value. The save action returns a retryable error if the server does not answer within 20 seconds; the button always leaves its saving state.

### Historical records

Historical rows keep every legacy column and their stored `calculatedDifference` / `differenceStatus`. The read-only and administrator views resolve the stored difference and derive expected = actual − stored difference. They do not recalculate old records with the simplified formula.

### Mid-day funding limitation

No separate audited mid-day funding workflow exists in the current product. Additional funding was therefore removed from the closing form under the stakeholder decision, and the legacy columns remain read-only for history. This limitation is recorded here instead of inventing a new accounting category or silently counting the money in an unaudited field.

---

## B. Dual-role staff login

### Existing architecture

`User` already carried `momoEnabled`, `susuEnabled`, a single `passwordHash`, `tokenVersion` and an optional one-to-one `Collector` relation. `resolveStaffAuth` authenticates one user and re-checks the requested module capability on the server. Dual-role users receive a single-use workspace selection token.

### Change

A new server action `setStaffModuleCapability` in `src/lib/actions/staff.actions.ts` grants or removes MoMo or Susu capability on the same user:

- promotes an existing MoMo agent by setting `susuEnabled = true` and creating/activating a `Collector` row linked to the same `User.id`;
- preserves `passwordHash`, user id, tenant, MoMo assignments and location;
- increments `tokenVersion` so older sessions cannot keep a stale capability set;
- records `user.module_assignment_changed` in the audit log;
- disabling Susu marks the Collector inactive instead of deleting it, so assignments, contributions and remittances remain intact;
- disabling MoMo leaves Susu untouched;
- administrators cannot be given these staff capabilities through this action.

The Staff Directory shows module badges plus `+ MoMo` / `+ Susu` controls and an explicit confirmation before removing a module.

### Same-password and isolation evidence

`tests/maacash-improvements.test.ts` proves: one user identity, unchanged password hash, MoMo remains enabled after Susu is granted, Collector linked to the same user, Susu disabled without deleting the user or Collector history, and exactly one user row. Existing `tests/unified-login.test.ts` covers MoMo-only, Susu-only and dual-role capability isolation. `test:security` covers tab-session and tenant boundaries.

### Existing duplicate accounts

No automatic merge was introduced. Merging two existing accounts based on matching names or phones is unsafe. The supported path is the administrator-controlled capability action, which attaches the missing module to the chosen identity. Historical duplicate records are not deleted or rewritten.

---

## C. Customer Account Number

### Canonical identifier chosen

`Customer.customerId` is the single public **Account Number**. It is already:

- generated on the server;
- globally unique;
- printed on cards and receipts;
- used by the customer portal before this change.

`SusuAccount.accountId` remains an internal relationship/card reference and is no longer presented as a second customer-facing number.

### Legacy identifier treatment

No identifier was deleted. `SusuAccount.accountId` and internal database primary keys remain for joins, security checks, historical contributions and withdrawals. User-facing labels now say **Account Number** only; “Customer ID” and “Customer Number” were removed from the source.

### Generation and concurrency

Customer creation validates details, allocates `BIK-C-XXXXXX` on the server, and retries up to five times if a concurrent creation wins the unique constraint. The database unique constraint is the final arbiter. The successful response returns `accountNumber`, the customer and the Susu account.

### Creation summary

The administrator sees **Customer Account Created Successfully** with:

- Customer Full Name
- Account Number, visually prominent
- Phone Number
- Daily Contribution
- Assigned Collector (or Not assigned)
- Account Status

Actions: Copy Account Number, Copy Account Details, Print Account Summary. No password, hash, token or secret is displayed. No SMS or WhatsApp delivery is claimed.

### Admin display and search

- Customers list: one **Account Number** column.
- Customer detail: Account Number card, header and collector dialog.
- Contributions, withdrawals, history and reports: Account Number labels; internal `accountId` is not shown as a second number.
- CSV exports use the same Account Number.
- Search accepts full/partial Account Number, customer name and phone. Server-side tenant scoping remains in `getCustomers` and `searchCustomers`.

### Customer login behaviour

`resolveCustomerAuth` now accepts exactly two identifier forms:

1. canonical Account Number (`BIK-C-…`);
2. registered phone number, normalized with the existing Ghanaian phone utility.

Email is explicitly rejected. Account Number lookup is globally unique. Phone lookup considers only active, portal-enabled accounts with a password hash.

### Shared-phone handling

If one normalized phone resolves to more than one active portal account, no customer is chosen and no session is created. The customer sees:

> This phone number is linked to more than one customer account. Please sign in using your Account Number.

Account Number login remains unambiguous.

### Multiple Susu accounts

A customer may hold more than one internal Susu account. The public Account Number identifies the customer; each account keeps its own internal `accountId`, cycle and ledger. This avoids two real accounts presenting the same ambiguous public number.

---

## D. Global action feedback

### Reusable feedback system

- `useToast()` / `ToastProvider` — aria-live toast notifications.
- `Modal` — accessible dialog with Escape, focus entry/restoration, Tab focus trap, labelled title and contained scrolling.
- `ConfirmDialog` — consequential-action confirmation with loading state.
- `PromptDialog` — text reason entry with validation, loading and error display.
- `useConfirm()` — promise-based confirmation used by platform controls.
- `SuccessTick` — animated success tick.
- Existing per-action pending states and banners remain where they fit the page.

### Pending, success and failure behaviour

- Actions disable duplicate submission while pending and show labels such as Saving…, Creating…, Updating…, Submitting…, Signing out….
- Success is shown only after the server action returns success.
- Failures keep entered values, show a human message and offer retry where appropriate.
- Financial actions retain their existing idempotency keys and conditional updates.
- Customer status changes and staff module changes now show toast/banner feedback and cannot be double-clicked.

### Native dialog audit

`window.alert`, `window.confirm` and `window.prompt` were removed from application code. Remaining matches are comments describing the replacement. Replaced sites include:

- withdrawal, contribution and remittance reversal reasons;
- customer and staff sign-out confirmations;
- Zeli conversation rename and delete;
- Zeli agreement acceptance;
- platform Zeli entitlement changes, emergency stop, global availability and renewal cancellation;
- admin MFA reset and offline device revocation.

### Zeli agreement

The administrator opens **Zeli Usage Agreement**, reads the disclosure, actively ticks the acknowledgement, and chooses **Accept and Continue** or **Cancel**. Acceptance is submitted to the server, the modal stays open with an error if submission fails, and only a confirmed success closes it and shows an in-app success toast. The modal is keyboard accessible and focus-trapped.

---

## E. UI/UX skills

Installed skills inspected and invoked:

- `bloomcore-skill-router` — routing and smallest-set selection.
- `bloomcore-ui-toolkit` — skeletons, prefill, honest confirmation, draft preservation, human errors, component adoption.
- `web-design-guidelines` — labels, focus, async announcements, native dialog anti-patterns, long-content handling.
- `design-taste-frontend` — app-screen rules; no marketing direction draw was run because these are existing product screens inside a fixed design system.

Applied outcomes:

- existing MaaCash tokens, buttons, cards and `AppBrand` retained; no competing design system;
- distinct indigo Start of Day and emerald End of Day sections with text labels, not colour alone;
- values and status readable on a phone, with 360/390/768/1280 screenshots reviewed;
- accessible modals with focus trap and restoration;
- labelled money inputs, tabular figures and inline hints;
- no decorative animation beyond the existing success tick.

---

## F. Testing

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | 66 files, 669 tests passed |
| `npm run test:security` | 6 files, 51 tests passed |
| `npm run test:e2e` | 67 passed, 5 skipped |
| `npm run build` | Pass |
| `npm run lint` | 0 errors, 74 existing warnings |

### Financial tests

`tests/momo-reconciliation.test.ts` covers the approved labels, debts collected, commission, expenses, balanced/positive/shortage, missing values and pesewa arithmetic. `tests/maacash-improvements.test.ts` drives the real save/submit actions and verifies persisted `debtsCollected`, zero legacy transaction fields, shortage blocking and positive submission.

### Authentication and security tests

`tests/unified-login.test.ts`, `tests/maacash-improvements.test.ts` and `test:security` cover capability isolation, dual-role promotion, unchanged password hash, one identity, same-phone ambiguity, email rejection, disabled portal, tenant isolation, tab sessions and MFA-related paths.

### Browser tests

Playwright covers the new form, draft restore, positive/shortage/balanced submission, correction form, customer portal, admin reports, Zeli modal dialogs and platform controls. The new `e2e/maacash-improvements-evidence.spec.ts` asserts the approved form fields, customer-login labels and one Account Number, and captures evidence screenshots.

### Screenshots reviewed

`test-results/maacash-improvements/`:

- `momo-daily-editable-360/390/768/1280.png`
- `customer-login-360/390/768/1280.png`
- `customer-created-390/1280.png`
- `staff-dual-role-1280.png`
- `zeli-delete-modal-390.png`

The screenshots were opened and inspected. No horizontal page overflow was reported at the tested widths.

---

## G. Deployment

- PR: #27
- Merge commit: `980ffa0`
- Implementation commits: `a78b86c`, `a90f07f`
- Migration: `20261109_momo_simplified_daily_account`
- Production primary: `maacash` (`srv-dbnaciff3r2c7382tjgg`, Auto-Deploy OFF)
- Production fallback: `bloomcore-one` (`srv-dbjalrk9v7es739ifkp0`, Auto-Deploy ON)
- Staging template service: `bloomcore-one-staging` (`srv-dbl3vb3l550s73efh03g`, not deployed by this release)

### Migration sequence

1. Additive migration authored for PostgreSQL.
2. Applied with the production `DIRECT_URL` **before** application code reached `main`.
3. `prisma migrate diff --from-url <direct> --to-schema-datamodel prisma/schema-pg.prisma --exit-code` returned **No difference detected**.
4. Only `DailyAccount.debtsCollected` was added; no table, row or historical value was removed or rewritten.

### Deployment status

| Service | Deploy ID | Commit | Status |
|---|---|---|---|
| `maacash` (primary) | `dep-dbofboijnfac73enre80` | `980ffa0` | Live |
| `bloomcore-one` (fallback) | `dep-dbofdfcs728c73a5kd90` | `980ffa0` | Live |

The primary service was deployed manually because its Auto-Deploy is OFF. The fallback deployed from `main`. Both now run the same commit.

### Health verification (2026-11-08T22:28Z)

| Endpoint | Result |
|---|---|
| `https://maacash.onrender.com/api/health` | 200, `status: ok`, commit `980ffa0` |
| `https://maacash.onrender.com/api/health/ready` | 200, `status: ready`, `database: ok` |
| `https://bloomcore-one.onrender.com/api/health` | 200, `status: ok`, commit `980ffa0` |
| `https://bloomcore-one.onrender.com/api/health/ready` | 200, `status: ready`, `database: ok` |

The public production customer sign-in page was loaded at 390px and 1280px, and its screenshot was reviewed. It shows **Phone Number or Account Number**, the correct helper text and the Turnstile check. Production login, admin, worker and customer journeys were not executed with real production credentials; no production financial record was created or modified during verification.

---

## H. Limitations

- No separate audited mid-day funding workflow exists. Additional funding remains a documented historical field and is not part of the simplified closing form.
- Production end-to-end login and financial posting were not performed with live accounts. Verification used the isolated Playwright database and production health/readiness plus schema checks.
- “One Account Number” is customer-level by design. Multiple internal Susu accounts per customer keep their own internal `accountId`; only the customer Account Number is public.
- Existing duplicate MoMo/Susu user records are not merged automatically. An administrator must attach the missing capability to the chosen identity.
- Lint reports 74 pre-existing warnings (effect setState, unused test variables); no errors.
- Currency and some dates still use the project’s existing helpers rather than a full `Intl` migration; changing formatting globally was outside this change.

---

## Final acceptance

### MoMo

- [x] Start of Day has Total Physical Cash and Total E-cash only.
- [x] End of Day has Total Physical Cash, Total E-cash, Expenses, Commission and Debts Collected only.
- [x] Correct expected closing formula.
- [x] Correct actual closing formula.
- [x] No duplicate customer transaction counting.
- [x] Green `BALANCED` state.
- [x] Green `POSITIVE DIFFERENCE` state.
- [x] Red `SHORTAGE — INVESTIGATION REQUIRED` state.
- [x] Clear colour-coded sections with text labels.
- [x] Draft saving and restoring still works.

### Dual-role staff

- [x] One `User` identity for MoMo and Susu.
- [x] Same password works for both authorised workspaces.
- [x] Workspace selection works through the existing selection/switch flow.
- [x] Module permissions remain separate.
- [x] MFA, tab-session isolation and tenant isolation tests pass.

### Customer Account Number

- [x] One canonical customer-facing Account Number (`Customer.customerId`).
- [x] Generated by the server with collision retry.
- [x] Visible after customer creation.
- [x] Visible in the administrator customer list.
- [x] Visible in the customer profile and detail page.
- [x] Used in customer search and exports.
- [x] Used for customer login.
- [x] Phone login works.
- [x] Shared-phone ambiguity handled safely.
- [x] No duplicate public Customer ID or Customer Number displayed.

### Action feedback

- [x] Buttons show processing states.
- [x] Successful actions show confirmation after server success.
- [x] Failed actions show clear human errors and keep input.
- [x] Financial actions retain duplicate-submit protection.
- [x] Zeli agreement uses an in-app modal.
- [x] Logout uses an in-app confirmation.
- [x] No application-triggered browser-native alert/confirm/prompt remains.

### Quality and release

- [x] Installed OpenCode UI skills genuinely used.
- [x] Responsive browser tests pass at 360, 390, 768 and 1280.
- [x] Security tests pass.
- [x] Regression tests pass.
- [x] Migration applied safely and verified with an empty diff.
- [x] Production primary deployment verified healthy.
- [x] Existing data preserved; no table or record deleted or rewritten.
- [x] Fallback service healthy on the same commit.

## Final status

**MOMO SIMPLIFICATION, DUAL-ROLE LOGIN, CUSTOMER ACCOUNT NUMBER AND UI FEEDBACK — COMPLETE AND DEPLOYED**
