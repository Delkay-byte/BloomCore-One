# Branch liquidity forecasting

**Status:** implemented. Deterministic, backtested, explainable, and structurally incapable
of moving money.

Files:

- `src/lib/liquidity-forecast.ts` — the model, pure.
- `src/lib/actions/liquidity-forecast.actions.ts` — reads one branch's own history.
- `src/components/LiquidityForecastPanel.tsx` — the panel on `/admin/liquidity`.
- `tests/liquidity-forecast.test.ts` — 18 tests.

---

## 1. The question

Not "what will we earn?" — "how much float does this branch need on Saturday?" A branch that
runs out of float turns customers away, and the loss is larger than a month of subscription.
A branch that over-funds ties up cash the owner could use elsewhere.

## 2. The model

```
daily history (cash out, cash in, per business day)
   │
   ├─ normalise: de-duplicate days, drop malformed points, cap at 180 days
   ├─ describe: per-weekday grid + trimmed overall mean
   ├─ choose: rolling-origin backtest of three candidate methods
   │            same_weekday_median | weekday_adjusted_average | plain_average
   │          → lowest mean absolute percentage error wins
   ├─ band:  upper = prediction + empirical residual quantile (service level, default 90%)
   └─ output: expected out, expected in, net, upper band, suggested opening float
```

- **Money is integer pesewa.** Every output figure is an integer; nothing divides pesewa.
- **The suggested float is the upper band, not the mean.** A short day is the failure being
  prevented, so the suggestion deliberately errs high.
- **Determinism.** No randomness, no model file, no external call. The same history produces
  the same forecast, which is what makes a disputed number reproducible.

## 3. Why the method is chosen, not assumed

`backtestForecast` walks the branch's own history with a rolling origin: for each eligible
day it forecasts from *earlier* days only, then compares with what actually happened. Using
future days would flatter the model — the easiest way to be convincingly wrong.

Three candidates are scored on the same days:

| Method | What it is |
| --- | --- |
| `same_weekday_median` | Median of the same weekday. Robust to one wild day. |
| `weekday_adjusted_average` | Trimmed mean of the same weekday (middle 80%). |
| `plain_average` | Trimmed mean of all recent days. The honest fallback. |

The winner is chosen by mean absolute percentage error; the forecast reports the band
coverage that method actually achieved, not the coverage it hopes for. With fewer than
`MIN_DAYS_FOR_SEASONAL` (21) days, the model says a weekday pattern would be guesswork and
falls back to the plain average. With no history at all it returns zero and says so.

## 4. Robustness, deliberately

| Situation | Behaviour |
| --- | --- |
| One bulk withdrawal in the history | Trimmed mean keeps the middle 80%, so a single event does not set the float for a month. |
| A duplicated business day | De-duplicated by taking the larger figure once, so a repeated import cannot double-count. |
| Malformed points (bad date, fractional, negative) | Dropped; the forecast still returns integers. |
| 400 days of history | Capped at 180: older days describe a different business. |
| A branch with no history | Zero, with "no usable history" rather than a fabricated figure. |

## 5. Why it can never move money

- `autoTransfer` is the literal `false` and `requiresHumanAction` is `true`.
- There is no transfer field in the output at all — a test asserts `transferAmountMinor` and
  `transferToLocationId` are absent from the result object.
- The explanation always ends: *"This is a suggestion only. Nothing here transfers, requests
  or reserves float; a person decides."*
- The read action performs no writes.

## 6. What the panel shows

For each branch on `/admin/liquidity`: the suggested opening float for the target date, the
expected paid out and taken in, the method and sample size, the backtest error and band
coverage, and the reasoning as a short list. When the branch has no days recorded, it says
so and shows nothing invented.

## 7. Known limits

- **No seasonality beyond weekday** — no month effects, no payday spikes, no holidays. They
  need more history than a new deployment has.
- **No cross-branch pooling.** A new branch gets the plain average rather than borrowing a
  sister branch's pattern, which is deliberate: branches differ.
- **Cash in and cash out are forecast with the same method.** A branch whose inflow has a
  different shape would want them chosen separately; that is the next refinement.
- **Not a cash-flow statement.** It forecasts float movement for one branch-day, not profit.
