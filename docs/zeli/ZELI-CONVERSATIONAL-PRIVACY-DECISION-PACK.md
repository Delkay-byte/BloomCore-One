# Zeli — Conversational AI Privacy Decision Pack

**Status:** DRAFT FOR OWNER AND LEGAL REVIEW. **NO APPROVAL HAS BEEN GRANTED.**
**Date:** 4 November 2026.
**Related:** `ZELI-PRIVACY-ASSESSMENT.md` (aggregate explanation assessment),
`ZELI-CONVERSATIONAL-ARCHITECTURE.md`.

This pack covers a different processing activity from the existing aggregate
insight explanation. Here the user's own sentence is transmitted. It must be
assessed and approved separately. Nothing in this document is legal advice and
no approval reference exists yet.

---

## 1. Processing description

| Item | Description |
|---|---|
| Purpose | Answer greetings, general business concepts and conversational follow-ups with external language-model reasoning |
| Trigger | A user message that the local engine classifies as non-business conversation |
| Data subject | The signed-in user (tenant administrator or authorized role) |
| Data | One message sentence, truncated and redacted, plus a fixed system prompt |
| Recipient | DeepSeek API (`api.deepseek.com`), only if approved |
| Storage by provider | Unconfirmed; must be contractually established |
| Storage by BloomCore One | The conversation locally; provider audit rows without content |
| International transfer | Likely; must be assessed |
| Automated decision-making | None. No financial action, approval or eligibility decision |

## 2. Data-flow inventory

### Local mode (current production)

User message → server → local classifier → local responder → local database.
No outbound network request. This is the processing that is live today.

### External conversational mode (not enabled)

```
browser
  → BloomCore One server (authentication, tenant, limits)
  → local act classification
  → sanitisation: emails, URLs, phones, references and all numbers replaced
  → external provider  [one message + fixed system prompt]
  → output validation (no digits, links, markup or identifiers)
  → local database (answer + audit metadata, no prompt)
```

### Explicitly excluded

- Conversation history, prior turns and summaries.
- Customer, staff, collector or tenant names.
- Account, payment, transaction or reference identifiers.
- Financial records, balances, statements, report values and exact amounts.
- Tenant id, user id, session tokens, MFA data or authentication data.
- Analytics snapshots and tool outputs.

### Residual data that may remain in a sentence

Names, locations, health or family details, employment details, and free-text
business descriptions that no regex catches. This is the main reason the
assessment cannot be treated as low risk by default.

## 3. Decisions required

Each item needs an explicit answer and evidence. Do not record an answer that
has not been agreed.

| # | Decision | Owner/legal answer | Evidence reference |
|---|---|---|---|
| 1 | Lawful basis for external conversational processing (contract, legitimate interests, consent, other) | _to be completed_ | _to be completed_ |
| 2 | Whether tenant-level authorization is sufficient or each user must opt in | _to be completed_ | _to be completed_ |
| 3 | Controller / processor / sub-processor roles | _to be completed_ | _to be completed_ |
| 4 | DPA signed with DeepSeek, including confidentiality and security terms | _to be completed_ | _to be completed_ |
| 5 | Sub-processor list and notification mechanism | _to be completed_ | _to be completed_ |
| 6 | Cross-border transfer mechanism and destination confirmation | _to be completed_ | _to be completed_ |
| 7 | Provider retention period and deletion process, including backups | _to be completed_ | _to be completed_ |
| 8 | Whether provider training on submitted data is contractually excluded | _to be completed_ | _to be completed_ |
| 9 | DPIA completion and sign-off (this pack is an input, not the DPIA) | _to be completed_ | _to be completed_ |
| 10 | Privacy notice wording and version identifier | _to be completed_ | _to be completed_ |
| 11 | User-facing disclosure and consent mechanism | _to be completed_ | _to be completed_ |
| 12 | Re-identification risk of residual free text | _to be completed_ | _to be completed_ |
| 13 | Sensitive-data handling (health, biometric, political, religious, etc.) | _to be completed_ | _to be completed_ |
| 14 | Children or vulnerable data subjects | _to be completed_ | _to be completed_ |
| 15 | Data-subject request procedure covering provider-side data | _to be completed_ | _to be completed_ |
| 16 | Breach notification path involving the provider | _to be completed_ | _to be completed_ |
| 17 | Retention decision for local conversations (existing product default) | _to be completed_ | _to be completed_ |

## 4. Technical safeguards already implemented

- Separate policy gate with a reviewed code constant, default `false`.
- Emergency stop remains latched by default and overrides every setting.
- Approved mode also needs a privacy version, approval reference and tenant
  authorization.
- One fixed endpoint; redirects rejected; timeout, token cap and response-size
  bound.
- Redaction before transmission.
- No history, records, identifiers or tenant/user ids in the request.
- Any digit in the model output is rejected, so the model cannot introduce a
  financial figure.
- Output validation rejects links, emails, references, markup and control
  characters.
- Prompt-injection wrapper and explicit system-prompt instruction.
- Local fallback on any denial or failure.
- Audit rows contain decisions, categories, latency and tokens only.
- Credential is server-only and never logged, returned or displayed.

These safeguards reduce risk. They do not create a lawful basis, a DPA or an
approval.

## 5. Open risks

| Risk | Severity | Mitigation status |
|---|---|---|
| Residual personal data in free text | High | Partial (pattern redaction only) |
| Provider retention or training unknown | High | Unresolved; contractual |
| Cross-border transfer mechanism absent | High | Unresolved |
| Tenant-level consent may be insufficient | Medium | Unresolved |
| Users may not understand when external AI is used | Medium | Banner and per-message label implemented; notice wording still required |
| Prompt injection causing off-policy output | Medium | Wrapper, system rules and strict output validation; not a guarantee |
| Model returns business advice presented as fact | Medium | External answers are non-financial only; local facts remain authoritative |
| Provider outage | Low | Local fallback verified |

## 6. Decision record

Complete only after the assessment is signed. Until then the status is:

```
Approval status:       NOT GRANTED
Approval reference:    <none>
Privacy policy version:<none for conversational processing>
DPIA:                  not completed
DPA:                   not confirmed
Cross-border basis:    not confirmed
Production mode:       disabled
Production code gate:  false
```

## 7. What the owner is being asked to decide

1. Whether to process user conversational text externally at all.
2. If yes, on what lawful basis and with which user-facing disclosure.
3. Whether the residual free-text risk is acceptable with pattern redaction, or
   whether a stricter design is required (for example, no free text at all).
4. Whether to approve only non-financial conversation, as implemented, or to
   extend the scope later through a new assessment.

No production conversation may be transmitted until items 1–11 are answered and
the code gate is changed in a reviewed commit.
