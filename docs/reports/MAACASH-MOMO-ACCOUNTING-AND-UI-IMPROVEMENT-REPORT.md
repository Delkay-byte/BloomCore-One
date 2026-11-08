# MaaCash — MoMo Combined Accountability Correction and UI Improvement Report

Date: 2026-11-08
Repository: `Delkay-byte/BloomCore-One`
Feature branch: `feat/momo-accounting-correction-ui`
Base commit (`origin/main` at branch point): `42afe42`
Pull request: pending
Production service: `maacash` (`https://maacash.onrender.com`)
Deployment status at time of writing: **not deployed**

**Evidence labels used below**

- **Verified** — executed in this environment or read directly from the code.
- **Calculated** — produced by the application's own arithmetic during tests.
- **Observation** — a finding from inspecting the implementation.
- **Limitation** — not executed, or executed only partially.
- **Recommendation** — proposed follow-up, not implemented here.

---

## 1. Problem corrected

The previous model reconciled physical cash and MoMo float as two independent balances:

```
expected MoMo balance = opening MoMo + Customer deposit - Cash out
expected cash         = opening cash + Cash in + commission + other income
                        - Cash out - expenses
```

That model had three accounting defects:

1. Customer deposits, cash out and airtime sales move value between the two pockets. They do not change the total business money. The old model counted them as income or expense on one side.
2. `Cash in` and `Cash paid out` duplicated `Customer deposit` and `Cash out`. The same movement was entered twice and could be counted twice.
3. A Missing or duplicated entry showed up as a "cash variance" and a "MoMo variance", which made one shortage look like two separate problems.

The corrected model reconciles **combined accountability**:

```
Expected closing accountability
  = opening cash
  + opening MoMo float
  + additional cash received
  + additional MoMo float received
  + commission earned
  - total business expenses

Actual closing accountability
  = closing cash
  + closing MoMo float

Difference = actual closing - expected closing
```

`Customer deposit (Cash in)`, `Cash out` and `Airtime sold` are still captured because they explain how money moved between cash and float. They are **not** added to or subtracted from accountability. They only drive the informational cash and float movement guides.

**Verified** in `src/lib/momo-reconciliation.ts` and locked by tests.

---

## 2. Approved labels and where they appear

| Persisted column | Approved label | Role |
|---|---|---|
| `totalCashIn` | `Customer deposit (Cash in)` | Cash-to-float movement, informational |
| `totalCashOut` | `Cash out` | Float-to-cash movement, informational |
| `totalAirtimeSold` | `Airtime sold` | Cash-to-float movement, informational |
| `additionalCashReceived` | `Additional cash received` | Increases accountability |
| `additionalMomoFloat` | `Additional MoMo float received` | Increases accountability |
| `commission` | `Commission earned` | Increases accountability once |
| Expense items | `Business expenses` | Reduces accountability once |
| `totalCashReceived` | Retired (`Cash in`) | Not read, not written on new saves |
| `totalCashPaid` | Retired (`Cash paid out`) | Not read, not written on new saves |
| `otherIncome` | Retired (`Other income`) | Not read, not written on new saves |

Labels and help text are centralised in `MOMO_FIELD_LABELS` and `MOMO_FIELD_HELP` in `src/lib/momo-reconciliation.ts`.

Applied in:

- Worker daily account form and worker dashboard
- Administrator dashboard
- Administrator reports list, report detail and CSV export
- Administrator history list, history summary and reconciliation records
- Administrative correction form and correction history
- Zeli `daily_account_summary` tool and cash-income analytics
- Marketing feature copy that described the old fields

---

## 3. Status rules

| Difference | Stored status | UI |
|---|---|---|
| `0` | `balanced` | Green `Balanced` |
| `> 0` | `positive` | Green `Positive difference` |
| `< 0` | `shortage` | Red `Shortage — Investigation Required` |

A negative difference blocks submission until the worker writes an explanation.

- The client stops the submit and shows the message: `This account has a shortage. Explain the shortage before submitting. Your figures stay unchanged.`
- The server action re-checks the shortage and returns the same rule, so a direct request cannot bypass it.
- The explanation is persisted in `reconciliationNote` and shown on admin screens.
- The submit path never changes opening, closing, cash or float figures.

**Verified** in `src/app/worker/daily/[id]/page.tsx`, `src/lib/actions/daily-account.actions.ts` and `tests/momo-two-day-reconciliation.test.ts`.

---

## 4. Data model and migration

Additive fields added to `DailyAccount` in both Prisma schemas:

| Column | Type | Default |
|---|---|---|
| `additionalCashReceived` | `Decimal` | `0` |
| `additionalMomoFloat` | `Decimal` | `0` |
| `totalAirtimeSold` | `Decimal` | `0` |
| `calculatedDifference` | `Decimal` | `0` |
| `differenceStatus` | `String` | `balanced` |

Migration: `prisma/migrations/20261108_momo_accounting_correction/migration.sql` (PostgreSQL, `ALTER TABLE ... ADD COLUMN` only).

Historical rows are never rewritten:

- Every original column remains.
- Original `calculatedMomoVariance` and `calculatedCashVariance` values remain readable.
- Old fields are not read by the new formula.
- New saves and corrections store `0` in the retired `totalCashReceived`, `totalCashPaid` and `otherIncome` columns.
- For new and corrected records, `calculatedMomoVariance` is stored as `0` and `calculatedCashVariance` stores the combined difference. Any older consumer that sums the two legacy columns therefore still sees the true total instead of a stale split.
- `resolveStoredDifference()` reads the modern difference first. It falls back to the legacy sum only when the modern value is `0` and the legacy columns disagree with `balanced`.

**Verified** in both schemas, the migration file and `src/lib/momo-reconciliation.ts`.

---

## 5. Worker experience

The MoMo daily screen is now one guided page with six numbered sections:

1. **Opening balances** — opening physical cash, opening MoMo float
2. **Additional money received** — additional cash, additional MoMo float
3. **Today's MoMo activities** — customer deposit (Cash in), cash out, airtime sold
4. **Commission and expenses** — commission earned plus itemised expenses
5. **Closing balances** — actual closing physical cash, actual closing MoMo float
6. **Reconciliation result** — live difference, status and shortage explanation

A sticky **Live accountability** sidebar shows opening money, additional funding, commission, expenses, expected closing, actual closing, difference, and the cash/float movement guides. On small screens it stacks below the form.

Other worker changes:

- Removed the duplicate `Cash in` and `Cash paid out` inputs.
- Commission is entered once.
- Expenses are entered as line items and reduce accountability once through their total.
- A saved state, draft restore banner, submit confirmation and success overlay preserve progress.
- The summary uses the same arithmetic function as the server, so the preview and the stored result cannot drift.

**Verified** in code and by typecheck/build. **Limitation:** the full interactive submit flow was not completed against a real session (see section 9).

---

## 6. Administrator experience

- **Dashboard** — combined difference per location, balanced count, shortage count, positive-difference count, airtime sold, additional funding, cash position and float position.
- **Reports list and detail** — combined expected closing, actual closing and difference; status label; shortage explanation.
- **CSV export** — new fields included; old duplicate fields removed from export rows.
- **History** — airtime, additional cash and additional float records replace the retired cash-in and other-income records; history summary now reports airtime, additional funding, total difference and shortage count.
- **Correction form** — captures the new fields, shows the combined difference, requires a reason as before, stores a full snapshot of the previous values, and never changes historical snapshots.
- **Worker detail** — recent accounts show the combined difference and status.

**Verified** in code and by typecheck/build.

---

## 7. Zeli and marketing

- `daily_account_summary` now returns `difference` and `differenceStatus` through `resolveStoredDifference()`, replacing the two legacy variance fields.
- Zeli analytics keeps `cashIncome` as `commission + otherIncome`. `otherIncome` is retired for new saves but still holds historical cash income, so historical reporting does not lose money that was genuinely recorded.
- Additional cash and additional float are deliberately **not** treated as income: they are owner funding, not earnings.
- Marketing feature copy and the workspace preview now describe customer deposits, cash out, airtime, commission, expenses and combined accountability.

**Verified** in code and by the Zeli analytics test.

---

## 8. Boundaries respected

| Requirement | Result |
|---|---|
| Susu formulas | Not changed. Susu files were not edited. |
| Authentication, MFA, roles | Not changed. |
| Historical records | Not rewritten; additive migration only. |
| Paystack LIVE credentials | Not read, changed or logged. |
| Production database during development | Not used. Tests used isolated SQLite `tests/test.db`; local dev used `prisma/dev.db`. |
| Real MoMo transactions | None created. |
| Tenant isolation | Existing guards retained on every read and write. |
| Visual language | Reused existing MaaCash/Tailwind components, colours, cards, `CediAmount`, focus styles and skeleton patterns. |

Skills loaded for the UI work: `bloomcore-skill-router`, `bloomcore-ui-toolkit`, `web-design-guidelines`, `design-taste-frontend`. The in-app browser skill was loaded for the visual check. No other design skill is claimed.

---

## 9. Verification

### 9.1 Automated checks

Run on 2026-11-08 in `BloomCore-One`:

| Command | Result |
|---|---|
| `npm run typecheck` | **Pass**, no errors |
| `npm test` | **Pass**, 65 test files, 652 tests |
| `npm run build` | **Pass**, production build completed |
| `npm run lint` | **Pass**, 0 errors, 81 warnings (all pre-existing; no new error) |

Test database: SQLite `tests/test.db`, populated with `npx prisma db push`. No production database was contacted.

Focused tests:

- `tests/momo-reconciliation.test.ts` — combined formula, status boundaries, labels, legacy resolution.
- `tests/momo-two-day-reconciliation.test.ts` — a balanced day and a shortage day end to end, including shortage submission blocking.
- `tests/momo.test.ts` — updated reconciliation expectations.
- `tests/zeli-analytics.test.ts` — historical income and tenant isolation unchanged.

### 9.2 Local visual check

- Local dev server started with the seeded SQLite database.
- Worker login succeeded in the in-app browser.
- Dashboard copy and the new accountability wording were checked visually.
- No browser console errors were observed on the pages loaded.

### 9.3 Limitations

- **Limitation:** the interactive daily form could not be completed in the browser. The client call to `/api/auth/me?module=momo` returned `401` even though the server-rendered session was present, so the dashboard could not obtain `locationId` for the `Start Daily Account` action, and direct navigation to `/worker/daily/[id]` redirected to login. The same API path was not re-tested against `main`, so this is not confirmed as pre-existing. It is recorded as an environment/session-provenance issue, not as a passing end-to-end UI test.
- **Limitation:** the Playwright suite was not run for this change.
- **Limitation:** no mobile breakpoint sweep and no before/after screenshots are claimed.
- **Limitation:** no production account, production database or real MoMo transaction was used.
- **Limitation:** deployment and live verification are recorded separately after the pull request and deployment complete.

### 9.4 Arithmetic examples

**Balanced day (verified by test):**

```
Opening cash                 500
Opening float                300
Additional cash                0
Additional float               0
Commission                    50
Expenses                      20
Expected closing             830
Closing cash                 530
Closing float                300
Difference                     0  -> Balanced
```

**Shortage day (verified by test):**

```
Opening cash                 500
Opening float                300
Commission                    50
Expenses                      20
Expected closing             830
Closing cash                 510
Closing float                300
Difference                   -20  -> Shortage — Investigation Required
```

Customer deposits, cash out and airtime change the cash/float split guides only. They do not change either difference.

---

## 10. Files changed

Core:

- `prisma/schema.prisma`, `prisma/schema-pg.prisma`
- `prisma/migrations/20261108_momo_accounting_correction/migration.sql`
- `src/lib/momo-reconciliation.ts`
- `src/lib/validations.ts`
- `src/lib/actions/daily-account.actions.ts`
- `src/lib/actions/momo-history.actions.ts`
- `src/lib/zeli/tools.ts`
- `src/lib/zeli/intelligence/metrics.ts`

UI:

- `src/app/worker/daily/[id]/page.tsx`
- `src/app/worker/(workspace)/dashboard/page.tsx`
- `src/app/admin/(workspace)/dashboard/page.tsx`
- `src/app/admin/(workspace)/reports/page.tsx`
- `src/app/admin/(workspace)/reports/[id]/page.tsx`
- `src/app/admin/(workspace)/history/page.tsx`
- `src/app/admin/(workspace)/history/[id]/correct/CorrectionForm.tsx`
- `src/app/admin/(workspace)/workers/[id]/page.tsx`
- `src/components/ui/SuccessTick.tsx`
- `src/app/globals.css`
- `src/app/(marketing)/features/page.tsx`
- `src/app/(marketing)/WorkspacePreview.tsx`

Tests:

- `tests/momo-reconciliation.test.ts`
- `tests/momo-two-day-reconciliation.test.ts`
- `tests/momo.test.ts`

---

## 11. Deployment

| Item | Status |
|---|---|
| Branch pushed | pending |
| Pull request | pending |
| CI (`Lint, typecheck, test, build`) | pending |
| MaaCash deploy (auto-deploy off) | pending |
| BloomCore shared service | not touched |
| Production health check | pending |
| Production database migration | pending (`prisma migrate deploy` through `scripts/prepare-deploy.mjs`) |

Deployment must run the additive migration before the new code serves traffic. The migration only adds columns with safe defaults, so old code remains compatible during the rollout. The shared BloomCore service reads the same database; the additive columns do not break its queries.

---

## 12. Final status

**COMPLETE — PENDING DEPLOYMENT**

Implementation, migration, tests, build and local checks are complete. Deployment, CI confirmation and live verification are not yet complete, so no production success is claimed.
