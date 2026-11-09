# MaaCash — Itemised Expenses, Net-Profit Reconciliation and Dual-Role Switching

**Date:** 2026-11-09
**Branch:** `feat/maacash-expenses-dual-role-switch`
**Database:** No migration. Existing financial records are preserved.

---

## A. MoMo expenses

- Removed the separate editable **Expenses** total.
- Added one **Expenses** section with repeatable rows: Description, Amount, Remove.
- `+ Add Expense` adds rows; the total is derived from the rows only.
- Blank rows are ignored. A row with only a description or only an amount is rejected.
- Amounts must be positive and use at most two decimal places.
- The server revalidates every row and sums them in integer pesewas. A browser-provided `totalExpenses` value is ignored.
- Submission recalculates the total from the persisted rows again.
- Drafts persist the rows and restore them. A legacy draft that carried only an old aggregate is restored as one editable line so no money is lost.
- The live summary shows the total and an expandable description/amount breakdown.
- The read-only account, administrator report and correction screen all show the breakdown.

## B. Accounting rule

```text
Net daily profit / increase = commission + debts collected - total expenses
Expected closing total      = opening total + net daily profit / increase
Actual closing total        = closing physical cash + closing E-cash
```

The displayed figures are:

- Opening total.
- `+ Commission`
- `+ Debts Collected`
- `− Total Expenses`
- `= Net Daily Profit / Increase`
- Expected closing total if all profit is retained.
- Actual closing total.
- Profit retained, and profit withdrawn or not retained.
- Accountability difference.

A shortage is reported only when the counted money is below the opening capital floor. A closing total equal to the opening total is balanced, even when the day earned a profit that was withdrawn. Withdrawn profit is never labelled as a loss. A genuine shortage still requires an explanation.

### Owner example

| Item | Amount |
|---|---:|
| Opening total (6,708 cash + 2,792 E-cash) | GH₵9,500 |
| Commission | +GH₵250 |
| Debts collected | +GH₵468 |
| Total expenses | −GH₵15 |
| **Net daily profit / increase** | **+GH₵703** |
| Expected closing if profit retained | GH₵10,203 |
| Actual closing (4,059 cash + 5,441 E-cash) | GH₵9,500 |
| Profit withdrawn / not retained | GH₵703 |
| **Status** | **Balanced, not a loss** |

A genuine shortage example: actual closing GH₵9,400 is GH₵100 below the GH₵9,500 capital floor. Status: **Shortage**.

### Root cause of the earlier GH₵703 report

The arithmetic was correct, but the difference was classified as a loss. The recorded profit was simply absent from the counted closing total. It is now shown separately as profit withdrawn / not retained. No formula sign was reversed, and commission and debts collected are not subtracted.

## C. Dual-role switching

- Root cause: a session minted for Susu could enrol a tab credential on the MoMo surface because the tab surface was inferred from the account's primary role and module list. The collector route then rejected the tab and returned the person to sign-in.
- Fix: every issued token now carries an explicit `module` claim. Tab enrolment, session validation, middleware and server actions honour that exact surface.
- A dual-role person uses one `User` identity, one password and one MFA assurance.
- In-app switch control is prominent at the top of both dashboards.
- Confirmation uses the existing accessible `Modal`, with **Stay Here** and **Yes, Switch**.
- Drafts are flushed before navigation.
- The server re-resolves the tenant and destination capability, requires an active Collector row for Susu, preserves `amr`, and rejects unauthorized destinations.
- Browser-supplied roles are never trusted.

## D. Verification

| Check | Result |
|---|---|
| Typecheck | Passed |
| Unit tests | 691 passed |
| Accounting tests | Passed, including zero movements, multiple expenses, net profit, positive surplus and genuine shortage |
| Authentication / MFA / session / role tests | Passed |
| Build | Passed |
| Lint | 0 errors, 74 pre-existing warnings |
| Playwright E2E | 76 passed, 5 skipped evidence-only tests |

Dual-role E2E covered: cancel, MoMo → Susu, Susu → MoMo, no password prompt, no authenticator prompt, no role-selection page, MoMo-only and Susu-only isolation, and Android-sized controls.

## Final status

`MAACASH EXPENSES AND DUAL-ROLE SWITCHING PASS`
