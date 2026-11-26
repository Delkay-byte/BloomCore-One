# MaaCash DeepSeek, Zeli and fraud-intelligence acceptance audit

**Date:** 19 November 2026  
**Scope:** local-only acceptance audit of the DeepSeek Team Testing integration, Zeli conversational and business-intelligence behaviour, and existing anomaly monitoring  
**Branch:** `feat/maacash-momag-readiness`  
**Production baseline:** `92d6d974e1e41d7b0586e823f9c000a0a7fe0925` (untouched)  
**Data:** synthetic E2E tenant and records only. No real customer or financial data was sent to DeepSeek.

## Outcome

The integration is **safe to keep as a gated Team Testing capability**. It is not approved for production conversation, real financial data, fraud decisions or autonomous action.

Three defects were found and fixed locally:

1. MaaCash's external-provider disclosure was being sent back as model history, so the model imitated it and users could see the notice twice.
2. A customer lookup containing a generic word such as “customer” widened the search and could return unrelated customers.
3. The current-month completeness insight counted future dates as missing trading days, overstating missing records.

The deterministic business-intelligence figures matched their source records exactly. Anomaly detection remains threshold-based; DeepSeek is **not** connected to fraud detection, anomaly scoring, transactions or account actions. External AI remains locked by code constants and requires a reviewed change, privacy approval and tenant authorisation.

---

## A. DeepSeek integration and key handling

### Configuration

| Item | Result |
| --- | --- |
| Expected key variable | `DEEPSEEK_API_KEY` |
| Key loaded locally | Yes. Present in `.env`; correct `sk-` token shape, 35 characters. Value not printed. |
| Model variable | `DEEPSEEK_MODEL`, set to `deepseek-flash` |
| Base-URL variable | `DEEPSEEK_BASE_URL` is set but **ignored** by the application |
| Git protection | `.gitignore:7 *.env` covers `.env`; `.gitignore:6 .env.*` covers `.env.local` |
| `.env` tracked by Git | No |
| Browser exposure | No `NEXT_PUBLIC_*` DeepSeek variable and no key in client bundles |
| Usage location | Server-only modules under `src/lib/zeli/` and server actions under `src/lib/actions/` |

`DEEPSEEK_BASE_URL` is a configuration discrepancy, not a working override. The provider calls fixed official endpoint constants in `deepseek-client.ts`, `deepseek-chat.ts` and `deepseek-conversation.ts`. The owner should remove the unused variable or document that only the fixed endpoint is supported. An arbitrary configurable URL should not be enabled without an allowlist and an explicit egress review.

### Gate state

External conversation is blocked unless all applicable gates are satisfied:

- `PRODUCTION_PROVIDER_APPROVED = false`
- `PRODUCTION_CONVERSATION_APPROVED = false`
- `TEAM_TESTING_APPROVED = true`, but still requires a platform-controlled mode, tenant authorisation and a tester grant
- The provider control was returned to `disabled` after testing

Team Testing is the only externally activatable mode. Its prompt uses a fictional business scenario and must not receive live MaaCash records.

### Live connectivity

A local Team Testing connection probe returned:

- `Connectivity OK`
- `922 ms`
- model `deepseek-flash`
- input 26 / output 1 tokens

A real conversational turn then returned a natural answer and displayed the banner:

`[TEAM TESTING · LIVE DEEPSEEK API · SYNTHETIC BUSINESS DATA]`

### Controls verified in source and tests

| Control | Implementation |
| --- | --- |
| Message bound | 1,000 characters |
| History bound | Last 6 messages, 800 characters each |
| Output bound | 1,600 characters / 320 tokens standard; 2,000 / 450 Team Testing |
| Response body bound | 64 KB conversation response; 256 KB chat transport |
| Timeout | 20 s standard conversation; 25 s Team Testing; 30 s chat transport |
| Retries | None for timeout or HTTP 429; one fetch per request |
| Circuit breaker | Opens after 4 failures; successful call closes it |
| Daily limits | 20 requests per user and 100 per tenant by default, configurable with hard caps of 500 and 2,000 |
| Audit | Hashed tenant/user references, decision, reason category, model, purpose, latency and token counts; no prompt, response or credential stored |
| Error disclosure | Invalid key returned a generic provider error; no key or provider response body was exposed |
| Financial dependency | Chat failure does not block dashboards, records, reporting or anomaly scans |

Invalid-key test result:

> “Team Testing could not reach the DeepSeek API for this turn. No deterministic answer was substituted. Check the provider status and try again.”

The provider usage row recorded `decision: error`, `reason: provider_status`. The rest of MaaCash remained usable.

### Disclosure handling

The external banner is appended by MaaCash, not the model. The audit found that previously returned assistant messages, including the banner, were being replayed as history. The model copied the pattern and produced the disclosure twice.

Fixed in `src/lib/zeli/providers/conversation-provider.ts` with `stripExternalDisclosure()`. A regression test asserts that the prior answer is sent but the MaaCash disclosure is not. Browser retest produced exactly one disclosure.

### Cost and latency observed

- 16 usage rows: 15 success, 1 controlled error
- 6,874 input tokens and 1,427 output tokens across successful calls
- Average latency 1,351 ms; minimum 850 ms; maximum 2,138 ms
- Typical turn approximately 250–800 input tokens and 34–200 output tokens
- No background AI processing and no retry loop

A currency cost is not reported because the repository has no provider price table. Token counts are available; a price table should be configuration, not hard-coded into business logic.

---

## B. Zeli conversational acceptance

### Method

Conversations were run through the local MaaCash UI, not directly against the model API. Eight external Team Testing turns covered:

1. general business questions
2. MaaCash features
3. MoMo operations and float reconciliation
4. Susu contributions and withdrawals
5. branches, employees and customers
6. summaries and financial reports
7. a follow-up that depended on the prior message
8. an out-of-scope question and a prompt-injection attempt

Team Testing uses only the fictional scenario. It cannot analyse live transactions, so these turns test conversational relevance, tone, boundaries and context, not live figures.

### Results

- Answers were relevant, concise and in a professional operational tone.
- The assistant retained the thread across follow-up turns.
- Currency was readable as `GH₵`, and dates and periods were understandable.
- The assistant refused live financial actions and clearly stated that it is read-only.
- Out-of-scope general knowledge was refused rather than answered with invented business context.
- Prompt injection did not disclose the system prompt, credentials or provider configuration.
- Answers did not fabricate live balances or claim access to records it did not have.
- With Team Testing active, every answer carried the synthetic-data disclosure.

### Local-mode conversations

With the provider disabled, Zeli answered from the authenticated tenant's records. Tested categories included:

- contributions and withdrawals
- remittances and variances
- expenses and cash flow
- branches, employees and collectors
- customer activity
- exceptions and missing records
- period comparisons
- greetings and unsupported questions
- follow-ups using the previous period
- financial instructions and refusal

Local answers use the structured sections **Key figures**, **What changed**, **How to read this**, **Recommended next step** and **Not established**. Machine tags such as `[CALCULATED FACT]` are not shown to users.

### Defect fixed: customer lookup over-match

`"Find customer E2E-C-001"` returned every customer because generic words were treated as search terms. The lookup now:

- gives an explicit business identifier precedence and searches only that identifier
- removes request words such as “find”, “show”, “customer”, “account”, “details” and “status”
- caps free-text terms at six

Files: `src/lib/zeli/tools.ts`, `tests/zeli.test.ts`. Browser retest returned only the requested synthetic customer.

### Honest limitations

- Team Testing cannot answer questions about real MaaCash records.
- Local answers are rule-based and cover the supported business questions; they are not open-domain general knowledge.
- The provider is not a financial system of record and cannot post, approve, reverse, refund or delete anything.

---

## C. Zeli business intelligence

### Deterministic source of truth

A synthetic tenant was seeded with known records. `buildAnalyticsSnapshot` produced the expected values before the browser test.

| Metric (this month) | Expected and observed |
| --- | --- |
| Contributions | GH₵500.00 from 2 records |
| Withdrawals | GH₵80.00 from 1 completed record |
| Commissions | GH₵0.00 |
| Remittances | GH₵470.00 |
| Remittance variance | GH₵30.00 from 1 record |
| Expenses | GH₵5.00 |
| Cash income | GH₵5.00 |
| Net cash flow | GH₵420.00 |
| Transaction count | 4 |
| Active accounts | 1 |
| New customers | 2 |
| Previous-period contributions | GH₵275.00 |
| Previous-period net cash flow | GH₵275.00 |
| Contributions change | +81.8% |
| Net cash flow change | +52.7% |
| Transaction-volume change | +300.0% |

Branch `E2E Accra Branch`: contributions GH₵500.00, withdrawals GH₵80.00, remittances GH₵470.00, expenses GH₵5.00, net cash flow GH₵415.00, 5 transactions.

Collector `E2E Collector`: contributions GH₵0.00, remittances GH₵470.00.

Exceptions: 1 pending withdrawal, 1 remittance discrepancy, 5 daily accounts awaiting review, 0 collectors without remittance, 8 draft/submitted daily accounts, 7 total open exceptions.

### Browser result

The local UI displayed the same figures:

- GH₵500.00, GH₵80.00, GH₵470.00, variance GH₵30.00, GH₵5.00
- net cash flow GH₵420.00
- +81.8%, +52.7%, +300.0%
- the same branch and collector totals
- the same exception counts

Weekly and today views were also checked against the same seeded data. The comparison and branch views retained their attribution caveats.

### Facts, interpretation and hypotheses

The composer labels statements as:

- `calculated_fact`
- `detected_pattern`
- `automated_interpretation`
- `suggested_action`
- `unverified_hypothesis`

Each insight carries a period, calculation, source, freshness, confidence and limitation. Zeli did not recalculate or replace a deterministic figure. In local mode it did not invent a cause for a movement; it reported the movement and asked for operational context.

### Defect fixed: future days counted as missing

For a current month, future dates were included in the completeness calculation. On 19 November a 30-day month reported “17 of 30 days” with no transactions, even though only 19 days had elapsed. This overstated missing activity.

Fixed in `src/lib/zeli/intelligence/insights.ts`:

- only elapsed dates are evaluated
- the wording is now “17 of 19 elapsed days”
- the calculation states “elapsed days”
- a fake-timer regression test proves future dates are excluded

The same pass corrected `This month` → `this month` in inline prose and fixed plural forms such as “1 completed records”, “1 remittance record(s)” and “1 withdrawal request(s)”.

---

## D. Existing fraud and anomaly monitoring

### What exists

Anomaly monitoring is **deterministic threshold detection**, not machine learning and not an AI fraud model. Findings are stored as `OperationalAnomaly` rows derived from named rules in `src/lib/anomaly-rules.ts`.

Tested rules include:

- daily cash shortage and repeated shortage
- large principal transaction
- repeated reversal
- transfer variance
- stale transfer
- shift variance
- unconfirmed handover
- expense spike against the branch median
- missing daily account
- aggregate/ledger disagreement

Each finding includes a rule key, severity, business date, measured value, threshold, detection time, affected worker/branch where applicable, and evidence. Re-running a scan upserts the same finding instead of duplicating it.

### Observed synthetic scan

Eight findings:

| Severity | Count | Examples |
| --- | --- | --- |
| High | 3 | GH₵750 shortage, GH₵25,000 large transaction, repeated shortages |
| Medium | 4 | two GH₵30 shortages, GH₵5,000 expense spike, aggregate/ledger disagreement |
| Low | 1 | missing daily account for a closed day |

The UI states:

> “Every finding comes from a named rule with a fixed threshold. There is no scoring model and no AI guess.”

### Review workflow

- A finding can be acknowledged with a note and later resolved.
- Acknowledgement records the acting user, note and timestamp.
- Audit action `anomaly.acknowledged` was written with the rule key and note.
- Tenant isolation, duplicate re-scan behaviour, clean-period no-findings behaviour and all rule thresholds are covered by `tests/anomaly-monitoring.test.ts`.
- Browser test acknowledged one finding; database state changed from 8 open to 7 open + 1 acknowledged, with no transaction or financial row changed.

### Detection limits

- Rules are fixed thresholds; they do not learn a tenant's normal pattern.
- Scans run on request. There is no scheduler, so detection is not continuous.
- Findings depend on operator-recorded data; no telco, aggregator or real-time provider balance is present.
- Evidence is structured plus free text; there is no document store for attachments.
- A finding is a prompt to check a record, not proof of wrongdoing, fraud or loss.
- Static thresholds can create false positives around legitimate large transactions, route sizes, opening days and seasonal activity.

These limitations are disclosed in the UI and should remain visible in any management report.

---

## E. AI-assisted fraud intelligence

### What is already safe

`src/lib/zeli/anomaly-detection.ts` provides an `AnomalyScoringProvider` interface and one implementation:

- `provider: "deterministic_rules"`
- `modelUsed: false`
- `externalModel: false`
- groups existing findings by employee, then branch, then unassigned
- fixed weights: high 42, medium 20, low 7
- +8 for each repeated finding for the same employee or branch, capped at 24
- total capped at 100; high band at 70, elevated at 35
- returns reasons, rule counts, methodology and limitations
- excludes resolved findings; keeps acknowledged findings until resolved
- read-only: it never creates, acknowledges or resolves a finding

The UI labels this “attention”, not probability or guilt, and explicitly states that no external model was used.

### What DeepSeek could add safely

With a reviewed adapter and minimised evidence, a model could:

- turn an existing finding set into a plain-language incident summary
- explain which rule produced each finding and what evidence supports it
- group related findings for a human reviewer
- suggest non-binding investigation steps
- draft a management briefing that links every statement to a finding ID

It must receive the minimum necessary anonymised evidence: rule keys, severities, dates, amounts, branch/employee pseudonyms and finding references. Names, phone numbers, customer identifiers, free-text notes and raw transaction rows should be removed unless a specific approved purpose requires them.

### What the model must never do

- create, edit, reverse or delete a transaction
- determine guilt, dishonesty or fraud
- suspend or restrict an account or employee
- approve or reject a withdrawal, transfer, adjustment or refund
- override a deterministic rule, severity or human decision
- invent evidence, a finding, a figure or a causal explanation
- act without a traceable finding ID and recorded human review

### Foundation versus work needed

| Capability | Status |
| --- | --- |
| Deterministic findings with evidence | Exists |
| Deterministic grouping and review order | Exists |
| Human acknowledge/resolve workflow and audit | Exists |
| Provider interface that discloses “no model” | Exists |
| AI-generated incident narrative | Not implemented |
| Minimised evidence schema for model input | Not implemented |
| Model output validation and finding-ID traceability | Not implemented |
| Prompt-injection and evidence-poisoning tests for an AI adapter | Not implemented |
| Human review queue for AI suggestions | Not implemented |
| False-positive evaluation and model acceptance criteria | Not implemented |
| DPIA, data-processing agreement and tenant approval | Not implemented |

### Recommendation

Do **not** connect DeepSeek to anomaly detection now. The current deterministic triage is auditable, cheap and sufficient for review ordering. A future AI adapter should be built behind the existing disabled interface, with a strict evidence schema, output validation, trace IDs and a human decision gate. It must remain unavailable in production until the missing controls above are reviewed and approved.

---

## F. Verification

### Automated checks

| Check | Result |
| --- | --- |
| Full Vitest suite | **127 files / 1,356 tests passed** |
| TypeScript | `tsc --noEmit` clean |
| ESLint | **0 errors**, 96 pre-existing warnings |
| Prisma SQLite schema | Valid |
| Prisma PostgreSQL schema | Valid |
| Secret scan | 0 hits in 983 tracked files and 0 in generated/test artifacts; key not printed |
| `.env` ignore | Confirmed by `git check-ignore -v` |
| Browser Zeli suite | 7 passed |
| Browser analytics suite | 5 passed |
| Mobile Zeli/history suite | 1 passed |
| Thinking indicator and auto title | Passed; title became “Collector Remittance Review” |
| Local BI figures | Matched deterministic source exactly |
| External connectivity | 922 ms, model `deepseek-flash` |
| Invalid-key failure | Safe generic error; no key or provider body leaked |

The mobile collector **offline** spec was not accepted as evidence in this audit: against the development-server harness the offline shell remained on “Loading content…” after reload. The Zeli mobile path passed. No offline code was changed, and this should be re-run against a production build before it is treated as a release gate.

### Tests added or updated

- `tests/zeli-team-testing.test.ts` — disclosure is not replayed as history
- `tests/zeli.test.ts` — customer-ID lookup returns one exact customer
- `tests/zeli-deepseek-conversation.test.ts` — timeout and HTTP 429 map to safe errors with one fetch
- `tests/zeli-provider-resilience.test.ts` — per-user daily limit and circuit breaker
- `tests/zeli-advanced-insights.test.ts` — elapsed-day completeness, plural wording
- `tests/zeli-conversation.test.ts` — human-readable period wording
- `e2e/zeli.spec.ts` — structured sections, exact New control, rename/delete dialog contract
- `e2e/analytics.spec.ts` — human-readable explanation labels
- `e2e/mobile.spec.ts` — history dialog instead of the retired mobile sidebar

### Safety state after the audit

- Provider control returned to `disabled`
- No push, pull request, merge or deployment
- No production environment variable changed
- No live Paystack, SMS or WhatsApp call
- No real customer data sent to DeepSeek
- No `.env`, key, local database or generated audit artifact committed
- Production remains at `92d6d974e1e41d7b0586e823f9c000a0a7fe0925`

---

## G. Recommended next steps

### Fix immediately

1. Remove `DEEPSEEK_BASE_URL` from local and deployment configuration, or document that the fixed official endpoint is intentional. Do not make it an unrestricted override.
2. Keep the provider `disabled` except during an explicitly authorised synthetic Team Testing session.
3. Keep the key in the server environment only; do not add a `NEXT_PUBLIC_*` variant.
4. Re-run the offline collector browser spec against a production build before using it as release evidence.

### Implement locally next

1. Add a disabled AI-triage adapter that accepts only a minimised evidence object and returns a narrative plus finding IDs. Keep `modelUsed` and `externalModel` truthful.
2. Add a schema for AI input that strips customer identifiers, phone numbers, free-text notes and raw rows.
3. Validate every model output against the supplied finding IDs; reject unsupported claims and unknown IDs.
4. Add prompt-injection and evidence-poisoning tests before any model adapter is enabled.
5. Add a human review queue for AI drafts, with approve/reject, reviewer identity, timestamp and audit row.
6. Add a configurable provider price table and per-tenant cost budget; keep token counts and latency visible.
7. Add a scheduled anomaly scan only after the operational ownership and alert-fatigue process are agreed.

### Requires external provider approval

1. Production conversation mode, with an approved purpose and tenant authorisation.
2. DPIA/privacy review and a data-processing agreement for any external model.
3. A reviewed evidence set and explicit prohibition on real customer data until approved.
4. Model evaluation for relevance, hallucination, refusal behaviour and bias.
5. Incident response for provider outage, data leakage, prompt injection and cost overrun.
6. A documented change to the `PRODUCTION_*` gates; these are code constants, not an `.env` switch.

### Later release

1. AI-assisted anomaly narrative and cross-branch pattern explanation, with traceable finding IDs.
2. Learned fraud detection only after labelled data, false-positive evaluation and human adjudication exist.
3. Automated management briefings generated from deterministic figures, never from model-recalculated numbers.
4. Continuous anomaly monitoring with a tested scheduler and on-call ownership.

---

## Standing limitations to repeat in the meeting

- All MoMo, transfer, shift, dispute and association data is operator-recorded. There is no telco or aggregator feed and no real-time provider balance.
- Anomaly monitoring is threshold-based. There is no AI or machine-learning fraud detection.
- Zeli's local answers are rule-based and cover supported business questions, not open-domain knowledge.
- Team Testing is synthetic-only and cannot analyse live transactions.
- External production AI is locked, not merely switched off in the UI.
- Messaging remains template-only and non-delivering; no real SMS or WhatsApp message was sent.
- Evidence is free text; there is no document-storage service.
- CSV exports cover loaded rows, use UTF-8 without a BOM, and share one escaping rule.
- PostgreSQL migrations are validation-only in this environment.
- No production deployment was made. Production remains at `92d6d974e1e41d7b0586e823f9c000a0a7fe0925`.
