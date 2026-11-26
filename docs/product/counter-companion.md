# Counter Companion

**Status:** RETIRED from the normal launch workflow. The component is no longer mounted
on the worker dashboard, has no navigation item and has no customer-facing route. Its pure
validation and accounting rules stay in `src/lib/counter-companion.ts` for reuse by the
planned agent-only Android Smart Counter. No financial records or audit history were deleted.

The policy below remains the written decision a future native shell must argue against;
it does not authorise reading SMS, call logs or USSD sessions.

Files:

- `src/lib/counter-companion.ts` — pure workflow and policy layer.
- `src/components/CounterCompanion.tsx` — the panel, mounted on the worker dashboard.
- `tests/counter-companion.test.ts` — 12 tests.

---

## 1. What it is for

An agent at a busy counter does not want a form with fourteen fields. They want to record
what just happened before the next customer arrives. The Companion reduces a transaction to
four choices — what happened, which network, how much, and the customer's confirmed number —
and parks it in the same capture queue the offline path already uses.

Because it reuses that queue, a Companion entry is not a second ledger. It is an ordinary
capture: it is sent to the business record when the connection returns, it is reviewed
where it conflicts, and it is matched when a provider statement is imported.

## 2. Feasibility: why the honest answer is "in-product, not native"

The tempting version of this feature reads MTN/Telecel SMS, or drives the USSD menu through
an AccessibilityService, so the agent does not have to type anything. It is rejected:

| Approach | Blocked by | Consequence |
| --- | --- | --- |
| Read incoming SMS for transaction confirmations | Google Play restricts `READ_SMS` to default-SMS-handler and backup/restore use cases. An agent app is neither. | Distribution removed, and customer message contents on our servers. |
| Read call logs | Same restriction (`READ_CALL_LOG`). | Same. |
| Drive the USSD menu via AccessibilityService | Would make MaaCash the operator of a financial transaction on a customer's behalf. | Wrong by policy, indefensible in a dispute, and possibly unauthorised. |
| Screen-scrape the MoMo app | Same as above, plus it breaks on every app update. | Unreliable *and* wrong. |
| Use a telco aggregator API | Procurement and a contract per network. | Not available yet; that is the "Coming soon" path, not a workaround. |

What is left is the part that is genuinely ours: make manual capture fast, safe and
provable, and match it later against the statement the business already downloads. That is
what shipped.

`COUNTER_PERMISSION_POLICY` in `src/lib/counter-companion.ts` encodes this: `required` is
empty, and the three refused permissions are listed with the reason, so a future native
shell has to argue against a written decision rather than quietly request SMS access.

## 3. Safety rules, and where they are enforced

| Rule | Enforcement |
| --- | --- |
| Never capture a MoMo PIN | There is no PIN field. `looksLikeSecret()` refuses a 4-digit value, a 5–6 digit value, or anything containing `pin`, `mpin`, `otp`, `password` or `secret` typed into the reference, with a message telling the agent to use the network's own confirmation reference instead. |
| Confirm the customer's number before saving | `customerNumberConfirmed` must be true for cash-in and cash-out. The panel requires a "I read the number back" tick. |
| Never display a full customer number back in a list | `maskCustomerNumber()` returns `+233244•••11`; the full value is not stored in the capture view. |
| Never claim the network confirmed a transaction | `providerConfirmed` is the literal `false`. Statuses are `captured | queued | sent | needs_review`, and a test asserts that no label contains "confirmed", "completed" or "paid". |
| Integer money only | `buildCounterCapture` converts to pesewa, refuses fractional pesewa and refuses zero/negative. |
| Never post money | The entry goes to the device capture queue; the server route posts nothing (`posted: false`). |

The confirmation line after a capture says exactly what happened:

> GH₵120.50 MTN for +233244•••11 recorded on this device. It is sent to your business
> record when you reconnect and matched when a statement is imported — the network has not
> confirmed it to MaaCash.

## 4. What the agent sees

1. What are you recording? (cash in / cash out / commission / expense)
2. Network (MTN / Telecel / AT Money)
3. Customer number + read-back confirmation (only for cash in/out)
4. Amount
5. Reference (optional) and evidence reference (optional)

Below the form: a count of entries still waiting to send, the five most recent captures with
their state, and a single permanent line: *"MaaCash never needs a MoMo PIN. Do not type one
here: the field refuses it. Nothing on this screen contacts a network on your behalf."*

## 5. Known limits

- **Cash in/out only touches the day's activity, not its opening and closing figures.** A
  Companion entry is sent as an activity capture with the day figures empty; the agent
  still completes the real daily account online. This is stated in the captured note, so a
  reviewer is never shown invented opening figures.
- **No offline PIN-free transaction initiation.** By design; see §2.
- **No automatic statement matching at capture time.** Matching happens on import, once,
  in the reconciliation path, so a capture can never be "confirmed" by a guess.
- **One network per entry.** A customer moving money across networks is two entries, which
  is also what the statement will show.
