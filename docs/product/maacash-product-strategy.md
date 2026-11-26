# MaaCash product strategy and competitive position

**Positioning:** MaaCash is the business operating and intelligence platform for mobile
money and Susu businesses. Not a wallet, not an aggregator, not a payment processor. The
customer's money stays in MTN, Telecel or AT money; MaaCash is where the owner finds out
whether the day made money, who was accountable, and what to fix.

This document records the strategy, the competitor research behind it, the UX principles
that follow from it, and the order the work was implemented in. It is a working document
for the product, not a marketing page.

---

## 1. Why this position holds

A mobile money agent has three problems, in this order:

1. **Trust in the day.** Cash and float must reconcile against what the networks say. A
   GHS 20 gap nobody can explain is a fight with an employee, and repeated gaps are how
   agent businesses die.
2. **Trust in people.** Staff handle cash, float, customer numbers and PIN-free
   transactions. The owner cannot watch every counter, and cannot be present at every
   handover.
3. **Trust in the numbers.** An owner with three branches cannot tell which one is
   actually profitable, which staff member is carrying a branch, or how much float a
   Saturday needs.

Every feature in this build maps to one of those three. A feature that maps to none of
them is not in scope, however easy it would be to sell.

### What MaaCash deliberately is not

| Not this | Why not |
| --- | --- |
| A wallet or an e-money issuer | Requires a Bank of Ghana licence and would put customer funds on our books. |
| A transaction initiator | Operating a MoMo transaction on a customer's behalf is neither Play-policy compliant nor honest about who did what. |
| A universal ledger | We record what a MoMo/Susu business needs, using that business's vocabulary, not double-entry accounting terms. |
| A public blacklist of agents | Defamatory, ungoverned and legally indefensible. See `shared-agent-risk-intelligence.md`. |
| An AI that decides | Zeli explains and drafts. Accepting a draft never closes a finding; AI never touches money. |

---

## 2. Competitor research

Researched as product patterns rather than as vendors to copy. Each row states what the
pattern gets right, where it stops, and what MaaCash does differently. Vendor behaviour
changes; these are the observations the design rests on.

| Competitor pattern | What it does well | Where it stops | What MaaCash does |
| --- | --- | --- | --- |
| **Cedipoint** | Polished agent-facing app; float and transaction capture in a familiar MoMo shape; strong onboarding for small agents. | Value is concentrated on capturing the transaction. accountability, reconciliation against provider statements, and multi-branch comparison are thin. | Capture is the *start*: every capture is followed by reconciliation, exception handling, and evidence with provenance states (`closed-loop-evidence.md`). |
| **M-Agent** | Broad agent network features, commissions and target tracking, good for agents who work inside a larger network. | Network-centric: the operator of the network sees the data, and a single agent's own books are secondary. | Owner-centric: the business owns its own data, exports it, and sees its own accountability chain. |
| **SmartAgent** | Simple daily summaries, low training burden, works on cheap phones. | Daily summary is a report, not a control. There is no evidence trail, no review state, and no way to challenge a figure. | Same low training burden, but each summary is backed by a reviewable record with an author and a time. |
| **Paximo** | Strong Susu/collector workflow with contributions and payout schedules; understands the collection route. | Susu-only. A business that also runs MoMo has to run a second system. | One workspace for both MoMo and Susu, with consolidated reporting across them. |

### The gap all four leave open

None of them answer the owner's real question after a bad day: *"what exactly happened,
who was responsible, what did we have at the time, and what happens next time?"* That
question needs reconciliation, exceptions with owners and SLAs, evidence with provenance,
accountability per employee, and a forecast. That is the product.

---

## 3. UX principles

These are enforced in code where they can be, and reviewed where they cannot.

1. **The number is the sentence.** An owner reads "GH₵1,240.00", not "amount" plus a
   table. Every figure is formatted once, in one place, integer pesewa underneath.
2. **Never use a word the owner would not use.** No "profit", "revenue", "cash income",
   "net cash flow" as a heading for a figure that is not profit, revenue or cash flow.
   `src/lib/reporting/dictionary.ts` exists so this is checkable, not aspirational.
3. **A finding is not a verdict.** Every anomaly screen says it in words, because the
   difference between "check this" and "this person stole" is the whole product.
4. **Stop the user at the moment of the mistake.** A number typed into the wrong field is
   caught when typed, not discovered at close. Offline captures are refused if the day
   does not exist, if the device was not enrolled, or if the payload changed on retry.
5. **Say what is not known.** "The network has not confirmed this" appears on every record
   that a network has not confirmed. A blank space would be read as a confirmation.
6. **One primary action per screen.** A counter agent under pressure gets one obvious
   button, not a toolbar.
7. **Work at the speed of a phone, on a bad connection.** Server components for the first
   paint, device capture for the offline path, no blocking spinner where a stored answer
   will do.
8. **Explain the refusal.** Every denial names the actual obstacle and who can clear it —
   sales, billing or platform — rather than "not authorised".
9. **Do not shout in colour.** Amber for attention, red for a real loss, never red for a
   missing optional field.
10. **Talk to the person who is worried.** Copy is written for an owner at 11pm reconciling
    a day, not for an auditor reading a spec.

---

## 4. Implementation order

Work was sequenced so that each phase leaves the system shippable and testable, and so
that nothing depends on an external contract that may never arrive.

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Foundations: tenant isolation, session model, integer-pesewa money, dual schema (SQLite + PostgreSQL), release gate script. | Done |
| 1 | Daily accountability: daily accounts, corrections, reversals, shifts, handovers, employee accountability. | Done |
| 2 | Reconciliation: provider statement import, row matching, exception cases with owners and SLAs, liquidity snapshots. | Done |
| 3 | Offline operations: device enrolment, offline requests, offline MoMo day capture, server revalidation, idempotency. | Done |
| 4 | Counter workflow: Counter Companion, guided capture, closed permission policy. | Done |
| 5 | Evidence: attachments, provenance states, dispute handling, Zeli explanation drafts. | Done |
| 6 | Intelligence: anomaly investigation, branch liquidity forecasting, shared risk intelligence (opt-in). | Done |
| 7 | Commercial: pricing catalogue, Zeli conversation entitlement, paid AI investigation add-on with automatic activation. | Done |

Anything requiring a live network integration (provider-confirmed transactions, live
float, WhatsApp/SMS delivery) is built to the seam and marked **Coming soon** in the
product, with the honest dependency named on the screen.

---

## 5. What the pricing says, and why

See `src/lib/pricing/catalogue.ts` for the catalogue itself. The principles:

- The price is a business value, not a per-transaction toll: a business whose float is
  short loses more in a day than a month of subscription.
- Annual pricing saves about 10%, stated exactly, computed from the catalogue rather than
  typed twice.
- Zeli conversation is included in every paid tier with a monthly allowance; the AI
  Investigation add-on is separate, because it costs us per investigation and it is only
  worth buying for a business that actually investigates.
- The add-on activates on a verified payment, never on a browser redirect.
- Existing customers keep their contracted amount; a price change produces a notice, not
  a charge.

---

## 6. Success measures

Not vanity metrics. Each one is a thing the product is supposed to change:

| Measure | Why it matters |
| --- | --- |
| Share of business days with a completed, reconciled close | The core habit the product exists to create. |
| Median time from a shortage to an explained exception | Whether the accountability loop actually closes. |
| Share of transactions with a provenance level above "declared" | Whether evidence capture is happening in real work. |
| Repeat shortages per employee after a correction | Whether accountability changes behaviour. |
| Branches whose opening float came from a forecast | Whether forecasting is used, not merely available. |
| Businesses that joined shared risk intelligence | Whether a governed, opt-in network is attractive at all. |

---

## 7. Related documents

- `counter-companion.md` — the frontline workflow and its permission policy.
- `offline-momo-operations.md` — capturing a day without a connection.
- `closed-loop-evidence.md` — provenance states and what they may claim.
- `shared-agent-risk-intelligence.md` — the opt-in governance model.
- `branch-liquidity-forecasting.md` — the forecast, its backtest and its limits.
