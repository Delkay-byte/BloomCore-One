# MaaCash — Two-Day MoMo Agent Reconciliation Investigation

Date: 2026-11-07
Environment: isolated SQLite test database (`tests/test.db`) via the real MaaCash server actions
Test identity: **TEST — MOMO RECONCILIATION — DO NOT USE FOR REAL TRANSACTIONS**
Reproducible test: `tests/momo-two-day-reconciliation.test.ts`

**Evidence labels:** **Verified** (executed/read), **Calculated** (produced by MaaCash's own arithmetic), **Observation**, **Recommendation**.

---

## 1. What was actually run, and what was not

**Verified — executed**

- A disposable tenant, location and MoMo agent were created in the dedicated test database with the unmistakable test identity above.
- Each day was opened with `createDailyAccount`, saved with `saveDailyAccount`, and closed with `submitDailyAccount` — the same server actions the application calls.
- Closing figures, stored variances and statuses were read back from the database.
- The test deleted its own tenant, location, user, daily accounts, expenses, revisions and audit rows and asserted that none remained.

**Not done**

- No staging deployment was available in this workspace.
- No production test tenant or agent was created, because an isolated production test account could not be guaranteed.
- No Paystack, mobile-money transfer, real cash, customer account or real withdrawal was used.
- The simulation drives the application's financial actions, not its browser UI. The UI was exercised separately by the Playwright correction test.

This is therefore a **genuine test of MaaCash's reconciliation calculations and persistence**, but not a production or browser-driven simulation. The report states that limitation rather than presenting the figures as production observations.

---

## 2. The accounting model MaaCash actually implements

**Verified from `src/lib/momo-reconciliation.ts` and `src/lib/actions/daily-account.actions.ts`:**

| Concept | Implementation |
|---|---|
| Opening cash | `openingCash` field, entered by the agent |
| Opening MoMo float | `openingMomoFloat` field, entered by the agent |
| Customer deposit | `totalCashIn`, approved label **Customer deposit** |
| Cash out | `totalCashOut`, approved label **Cash out** |
| Cash in | `totalCashReceived`, approved label **Cash in** |
| Commission / service charge | `commission`, entered by the agent |
| Other cash received | `otherIncome`, entered by the agent |
| Business expenses | Itemised `Expense` rows, summed into `totalExpenses` |
| Expected closing MoMo float | `openingMomoFloat + totalCashIn − totalCashOut` |
| Expected closing cash | `openingCash + totalCashReceived + commission + otherIncome − totalCashOut − totalExpenses` |
| MoMo difference | `closingMomoFloat − expectedMomoFloat` |
| Cash difference | `closingCash − expectedCash` |
| Total difference | MoMo difference + cash difference |
| Positive difference | Closing figure is higher than expected (over) |
| Negative difference | Closing figure is lower than expected (short) |
| Cash vs float shortage | Kept as two separate variances |

`totalCashPaid` ("Cash paid out") is retired and is not part of any calculation.

**Observation — the important modelling caveat.** MaaCash records daily **aggregates**, not individual MoMo customer transactions. There is no per-customer cash-in/cash-out ledger in the MoMo module; the agent enters the day's totals. The engine therefore compares *declared totals* with *counted closing balances*. It can detect that the drawer or float does not match the declared activity; it cannot identify which individual customer transaction was omitted.

**Observation — cash-in / customer-deposit semantics.** In a real MoMo shop, a customer deposit (cash-in) normally increases physical cash and decreases the agent's e-money float. MaaCash's implemented model puts Customer deposit on the float side and Cash in on the cash side. A fully balanced day therefore requires the agent to enter both figures consistently with these definitions. The investigation kept the implemented model unchanged and documents the ambiguity for the business rather than silently redefining it.

---

## 3. Test account

| Field | Value |
|---|---|
| Display name | `TEST — MOMO RECONCILIATION — DO NOT USE FOR REAL TRANSACTIONS` |
| Agent display name | `TEST — MOMO AGENT — DO NOT USE FOR REAL TRANSACTIONS` |
| Location | `... — SIMULATED SHOP` (`SIM-001`) |
| Tenant | Isolated test tenant, MoMo enabled, Susu disabled |
| Credentials | Generated inside the test, never logged, deleted with the account |

---

## 4. Day One — balanced

### 4.1 Activity recorded through MaaCash

| # | Activity | Amount (GH₵) |
|---|---|---:|
| 1 | Opening cash in drawer | 500.00 |
| 2 | Opening MoMo float | 1,000.00 |
| 3 | Customer deposit recorded | 600.00 |
| 4 | Cash out to customers | 450.00 |
| 5 | Cash in (physical cash received) | 600.00 |
| 6 | Commission earned | 15.00 |
| 7 | Other cash received | 0.00 |
| 8 | Business expenses | 0.00 |
| 9 | Actual closing MoMo float | 1,150.00 |
| 10 | Actual cash counted in drawer | 665.00 |

### 4.2 MaaCash's calculation

```
Expected closing float = 1,000.00 + 600.00 − 450.00 = 1,150.00
MoMo difference        = 1,150.00 − 1,150.00 = 0.00

Expected closing cash  = 500.00 + 600.00 + 15.00 + 0.00 − 450.00 − 0.00 = 665.00
Cash difference        = 665.00 − 665.00 = 0.00

Total difference       = 0.00
Status stored by MaaCash: submitted
```

### 4.3 Stored database result (verified)

| Field | Value |
|---|---:|
| Opening cash | 500.00 |
| Opening MoMo float | 1,000.00 |
| Customer deposit | 600.00 |
| Cash out | 450.00 |
| Cash in | 600.00 |
| Commission | 15.00 |
| Closing MoMo float | 1,150.00 |
| Closing cash | 665.00 |
| Retired `totalCashPaid` | 0.00 |
| MoMo variance | 0.00 |
| Cash variance | 0.00 |
| Status | submitted |

### 4.4 Why Day One balanced

The agent did three things correctly:

1. Recorded every movement in the day, not just the large ones: customer deposit, cash out, cash in and commission.
2. Made the opening MoMo float and the opening cash agree with the previous close (this was the first day).
3. Counted the actual closing cash and read the actual MoMo balance, then entered **those counted figures** rather than the expected ones.

Because the recorded movements and the counted closing balances described the same activity, both expectations were met exactly. Zero difference means "the counted drawer and float agree with the declared activity"; it does not mean the business made no money or no loss. Commission of GH₵15 is income recorded separately.

---

## 5. Day Two — deliberate operational shortfall

### 5.1 Opening balances

Day Two opened with Day One's **actual** closing balances: cash GH₵665.00, MoMo float GH₵1,150.00.

### 5.2 Activity recorded

| # | Activity | Amount (GH₵) |
|---|---|---:|
| 1 | Opening cash | 665.00 |
| 2 | Opening MoMo float | 1,150.00 |
| 3 | Customer deposit recorded | 400.00 |
| 4 | Cash out to customers | 520.00 |
| 5 | Cash in (physical cash received) | 400.00 |
| 6 | Commission earned | 12.00 |
| 7 | Other cash received | 0.00 |
| 8 | Business expenses | 0.00 |
| 9 | Actual closing MoMo float | 1,030.00 |
| 10 | Actual cash counted in drawer | 512.00 |

### 5.3 The controlled error introduced

The transactions were recorded correctly. At closing, the agent **counted GH₵45 less cash than the drawer should have contained**. This is a real operational error of the kind that happens when change is handed out without being recorded, a note is misplaced, or the count is simply wrong. No difference field was edited.

### 5.4 MaaCash's calculation

```
Expected closing float = 1,150.00 + 400.00 − 520.00 = 1,030.00
MoMo difference        = 1,030.00 − 1,030.00 = 0.00

Expected closing cash  = 665.00 + 400.00 + 12.00 + 0.00 − 520.00 − 0.00 = 557.00
Cash difference        = 512.00 − 557.00 = −45.00

Total difference       = 0.00 + (−45.00) = −45.00
Status stored by MaaCash: submitted, with a negative cash variance
```

### 5.5 Stored database result (verified)

| Field | Value |
|---|---:|
| Opening cash | 665.00 |
| Opening MoMo float | 1,150.00 |
| Customer deposit | 400.00 |
| Cash out | 520.00 |
| Cash in | 400.00 |
| Commission | 12.00 |
| Closing MoMo float | 1,030.00 |
| Closing cash | 512.00 |
| Retired `totalCashPaid` | 0.00 |
| MoMo variance | 0.00 |
| Cash variance | **−45.00** |
| Status | submitted |

### 5.6 Why Day Two produced a shortfall

- **Which balance was affected:** physical cash only. The MoMo float reconciled exactly.
- **How much:** GH₵45.00 was missing from the counted drawer.
- **How MaaCash detected it:** it recomputed expected cash from the declared movements (GH₵557.00) and compared it with the counted cash (GH₵512.00). The signed difference was −GH₵45.00, which renders as "Short" and "Check required".
- **Why it is negative:** the actual closing cash was lower than the amount the recorded activity required.
- **What the agent should have done:** counted the drawer before recording the closing figure, investigated the GH₵45 immediately (change given, float top-up, personal money mixed in, or a mis-count), and only then either corrected the recorded activity or reported the shortage to the administrator.

---

## 6. Side-by-side comparison

| Item | Day One — Balanced | Day Two — Shortfall |
|---|---:|---:|
| Opening cash | 500.00 | 665.00 |
| Opening MoMo float | 1,000.00 | 1,150.00 |
| Customer deposits | 600.00 | 400.00 |
| Cash-outs | 450.00 | 520.00 |
| Cash-in | 600.00 | 400.00 |
| Commissions/charges | 15.00 | 12.00 |
| Expected closing cash | 665.00 | 557.00 |
| Actual closing cash | 665.00 | 512.00 |
| Expected closing MoMo float | 1,150.00 | 1,030.00 |
| Actual closing MoMo float | 1,150.00 | 1,030.00 |
| Cash difference | 0.00 | **−45.00** |
| Float difference | 0.00 | 0.00 |
| Overall reconciliation difference | 0.00 | **−45.00** |
| Reconciliation status | Balanced | Short (cash) |

All figures are GH₵ and were read back from the records MaaCash wrote.

---

## 7. What the difference does and does not mean

A negative reconciliation difference is **not automatically a business loss or a reduction in profit**.

| Concept | What it means here | What MaaCash measures |
|---|---|---|
| Cash shortage | Physical cash counted is below the amount the recorded activity requires | `cashVariance < 0` — this simulation |
| Float shortage | The MoMo e-money balance is below the expected float | `momoVariance < 0` |
| Operational discrepancy | Timing, mis-posting, unrecorded movement, change error, mis-count | The two variances above |
| Business expense | Money deliberately spent on the business | `Expense` rows, subtracted from expected cash |
| Business loss | Revenue/cost outcome over a period | **Not calculated by the daily reconciliation** |
| Commission / service-charge income | Money earned from transactions | `commission` field, added to expected cash |

In this simulation the business did not "lose GH₵45 of profit". The agent's counted cash was GH₵45 below what the recorded activity required. Until the cause is found, it is an unexplained cash shortage — an accountability gap, not a profit-and-loss entry.

**Observation — masking risk.** MaaCash's "total difference" adds the float and cash variances. A float shortage of GH₵100 and a cash excess of GH₵100 produce a total of zero even though one balance is short. The application does keep the two variances separate, and the administrator screens show both; a future improvement should give each balance its own status rather than relying on the sum. **Recommendation.**

---

## 8. How a MoMo Agent Should Reconcile Their Account at the End of the Day

*A practical procedure based on the two simulations above.*

### Before opening

1. Count the cash in the drawer and write the figure down before any customer arrives.
2. Check the MoMo balance on the phone/app and write it down. Confirm it matches yesterday's closing float.
3. If either opening figure does not match yesterday's close, tell the administrator **before** trading. Do not "fix" it by adjusting today's figures.

### During the day — customer deposits (cash in at the shop)

4. Record every deposit as it happens, not from memory at closing.
5. Take the cash, count it in front of the customer, and confirm the amount that left your MoMo balance.
6. Never mix personal money with business cash. If you must add personal money, record it as "Other money received", not as a customer deposit.

### During the day — cash-outs (customer withdrawals)

7. Confirm the customer's details before paying.
8. Count the cash out loud, twice, and confirm the MoMo amount received.
9. Record the cash-out immediately. This single figure is the "Cash out" field; there is no second "cash paid out" entry.

### During the day — corrections and reversals

10. If you recorded a transaction wrongly, correct it the same day and keep the reference/receipt.
11. Never delete or overwrite a transaction silently. If a transaction is reversed, record the reversal and tell the administrator.
12. If a customer leaves without completing a transaction, reverse it before closing.

### At closing

13. Stop taking new transactions. Announce that the day is closed.
14. Print or open the MoMo statement and confirm the closing float. Do not use the balance you "expect" — use the balance shown.
15. Count the physical cash: notes and coins separately, then add them. Count twice. Ask a colleague to count if one is present.
16. Enter the counted closing cash and the confirmed closing float in MaaCash.
17. Compare the app's expected figures with your counted figures. Read both the MoMo difference and the cash difference — do not look only at the total.

### When the difference is zero

18. Submit the account. Keep the counted-cash note and the MoMo statement with the day's records.

### When there is a shortage

19. Do not submit a "plug" figure and do not borrow from tomorrow's opening cash.
20. Recount. Check change given, till slips, transfers to the owner, and whether personal money was used.
21. If the shortage remains, submit the true count, write what you checked, and report it to the administrator the same day. MaaCash records the negative difference and the administrator can investigate.
22. If the shortage was caused by an unrecorded business payment (transport, data, repairs), record it as an expense with a receipt before closing.

### When there is an excess

23. Recount. Check for a customer deposit recorded but not received, a cash-out not paid, or a float top-up recorded in the wrong place.
24. Do not treat an excess as profit. Report it; it usually belongs to a customer or the business's float.

### What to give the business administrator

25. Opening cash and float, closing cash and float, the day's Customer deposit / Cash out / Cash in totals, commission, itemised expenses, both differences, and a short explanation for any non-zero difference.

---

## 9. Findings and recommendations

**Verified findings**

1. MaaCash's reconciliation arithmetic is deterministic and correctly detects a cash shortfall caused by a lower closing count (−GH₵45 in this simulation).
2. Cash and float differences are stored separately.
3. Removing the duplicate "Cash paid out" field did not change the Day One or Day Two calculations.
4. A balanced day is achievable with consistent, complete daily totals.

**Observations**

5. The MoMo module holds daily aggregates, not a customer-level transaction ledger, so it cannot identify the specific missing transaction.
6. Customer deposit and Cash in are modelled on different sides of the books, which differs from the physical movement in a real MoMo shop.
7. The summed total difference can hide a float shortage behind a cash excess.
8. Commission is a manual daily figure; the application does not derive it from transaction volumes.

**Recommendations (not implemented here)**

9. Keep separate administrator statuses for cash and float: Balanced / Cash short / Float short / Over.
10. Add a transaction-level MoMo ledger (customer reference, type, amount, running float) so an agent can find a missing entry rather than only discovering a total mismatch.
11. Clarify with the business whether Customer deposit should also increase physical cash, or whether Cash in is the sole cash-side record. Do not change the model without business sign-off.
12. Add a closing checklist to the form (count twice, confirm statement, read both differences) and require a note when either difference is non-zero.
13. Audit legacy `totalCashPaid` rows before any historical recalculation.

---

## 10. Test account cleanup

**Verified results**

- Both daily accounts, their expenses, revisions and the test agent's audit rows were deleted.
- The test user, location and tenant were deleted.
- The test asserted that the daily accounts, user and tenant no longer exist.
- No real customer, employee, agent, tenant or financial record was read or written: the whole simulation ran in the dedicated SQLite test database.
- No production test account was ever created, so there is no production identity to deactivate.

**Why full deletion was safe here:** the records lived only in the disposable test database and were created by the test itself. In production, immutable ledger/audit rows must not be hard-deleted; the correct production cleanup would be to deactivate the test identity and mark its rows unmistakably as test activity. That situation did not arise because production was not used.

---

## 11. Bottom line

Day One balanced because the agent recorded every movement and entered the cash and float they actually counted. Day Two was short because the counted cash was GH₵45 lower than the recorded activity required; the MoMo float was unaffected. MaaCash correctly computed and displayed −GH₵45 against cash. The difference is an operational cash shortage, not a profit-and-loss loss, and the first thing an administrator should check is the cash count, the change given, and any unrecorded cash movement.
