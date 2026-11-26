# Shared agent risk intelligence

**Status:** implemented, opt-in, governed, and **off by default**. There is no public
blacklist anywhere in this product, and there is no operation that could build one.

Files:

- `src/lib/risk-intelligence/policy.ts` — the rules, pure.
- `src/lib/risk-intelligence/hasher.ts` — server-only salted hashing of a subject.
- `src/lib/actions/risk-intelligence.actions.ts` — joining, leaving, contributing, querying.
- `src/components/RiskIntelligencePanel.tsx` — the console.
- `tests/risk-intelligence.test.ts` — 21 tests.
- Schema: `RiskIntelligenceConsent`, `AgentRiskSignal`, `RiskIntelligenceDisclosure`
  (migration `20261221_shared_risk_intelligence`).

---

## 1. The problem, stated honestly

A cashier who takes money and moves to the next shop is a real pattern in this market. The
next employer has no way to know, and the previous employer has no way to warn them without
risking defamation.

Every attempt to solve this with a list of names fails for the same three reasons: it
publishes unproven accusations, it cannot be corrected, and it follows people forever. So
this feature does the narrowest thing that could help and stops.

## 2. What it actually does

A business that joins can contribute a **signal** — "a day ended short and was never
explained", "a handover was never confirmed" — about **its own employee**, tied to **its own
closed record**. Another business that has joined can ask about **someone it already employs
or is hiring**, and receives either nothing, or a prompt:

> More than one business taking part has independently reported the same kind of problem.
> Review your own records before deciding anything.

That is all. No name is disclosed, no phone number, no note, no evidence file, no
contributing business, no score, and no flag on the person anywhere in the product.

## 3. The rules, and why each exists

| Rule | Why | Enforced in |
| --- | --- | --- |
| Opt-in only, per policy version | Nobody is enrolled by a default. A changed policy must be accepted again. | `joinRiskIntelligence` refuses a stale `acceptedPolicyVersion`. |
| "Receive only, share nothing" scope | A business can benefit without contributing, which makes joining a real choice. | `scope: query_only`; `validateRiskContribution` refuses contributions. |
| Withdrawal is immediate | Leaving must be a real exit, not a request. | `withdrawRiskIntelligence` marks the consent withdrawn **and** the business's signals withdrawn in one transaction. |
| Three distinct businesses minimum | One employer's complaint is not evidence about a person. | `RISK_INTELLIGENCE_MIN_CONTRIBUTORS = 3`, tested. |
| The caller's own signals never count | Otherwise a business could unlock disclosure with its own single report. | The cohort is built from `others` only. |
| Categories must agree | Three unrelated complaints must not merge into one accusation. | A category is disclosed only when ≥2 businesses reported *that* category. |
| Coarse bands, never counts | An exact contributor count in a small market identifies the contributors. | `bandFor()` → "3 to 5", "6 to 9", "10 or more". |
| No identity stored in the clear | The shared dataset must not be a directory of people, even if copied out. | `hashRiskSubject` HMAC-SHA256 over normalised name + phone, salted from `RISK_INTELLIGENCE_SALT`; tests assert the name and phone never appear in stored rows. |
| A missing salt is a hard failure | A default salt would let anyone recompute a phone number's hash. | `riskSubjectSalt()` throws; joining is refused when unconfigured. |
| Every disclosure is recorded | A shared product that cannot say who was shown what is not governed. | `RiskIntelligenceDisclosure` written inside the same transaction as the read; the log itself stores categories and bands, not contributors. |
| Signals expire | An old event must not follow someone indefinitely. | `RISK_INTELLIGENCE_DECAY_DAYS = 180`; expired signals are excluded from every query and a daily scan marks them `expired` without deleting rows. |
| Contribution needs a reason | A contributor must be able to justify and later review its own signal. | Minimum 10-character note, kept as `internalNote`, never disclosed. |
| A signal points at a closed record of your own | Stops a signal being built on a rumour or on another business's record. | `contributeRiskSignal` verifies the source row belongs to the caller's tenant. |
| No browsing, no searching by name | There is no endpoint that lists people or takes a name as input. | Queries take a `userId` the caller already employs. |

## 4. Why this is not a blacklist

- There is no list of flagged people anywhere, and no "risk score" field on a person.
- The only output is `verdict: "review_recommended" | "no_shared_signals"` plus
  `isBlacklist: false`, `disclosesIdentity: false`, `requiresHumanJudgement: true`.
- A query must name someone the business already has a record for, so it cannot be used to
  screen strangers.
- Nothing in the product blocks, rejects or publicly marks anybody.
- A test asserts the serialised result contains no contributing tenant id and no note.

## 5. Operational requirements before enabling

1. Set `RISK_INTELLIGENCE_SALT` to a long random value **on the server only**, and keep it
   stable: rotating it orphans every existing signal key (rows are kept; they stop matching).
2. Publish the policy text at `RISK_INTELLIGENCE_POLICY_VERSION`. If the text changes
   materially, bump the version — every business must re-accept.
3. Have the wording reviewed by a lawyer in the operating jurisdiction before launch. A
   signal about a named-in-private individual is still a reputational act.
4. Decide the data-retention position for `AgentRiskSignal` rows with the association, and
   record it with the other association decisions.
5. Schedule `expireStaleRiskSignals()` on the existing daily job path.

Until (1) is done, the console shows that shared intelligence is not configured and joining
is disabled — the product does not pretend to collect anything.
