# Zeli — Conversational Architecture and Provider Boundary

**Status:** implemented; production external conversational processing remains
disabled pending genuine legal/privacy approval.
**Last updated:** 4 November 2026.

## 1. Two modes, never confused

| | Local mode (production default) | External conversational mode |
|---|---|---|
| Who answers | BloomCore One deterministic engine | Approved external provider, with local fallback |
| What is sent out | Nothing | One sanitised user message |
| Business figures | Calculated locally from records | Never sent, never generated externally |
| Conversation history | Used locally for follow-up resolution | Never sent |
| Label shown | "Local mode" banner, "Computed from your records" badge | "External AI conversation is enabled" banner, "External AI answer" badge |
| When available | Always, including without a provider key | Only when every gate below passes |

The local assistant is never described as an LLM, and an external answer is
never presented as local. Response headers record the actual mode:
`x-zeli-conversation-mode`, `x-zeli-conversation-provider`,
`x-zeli-provider-kind`.

## 2. Modules

```
src/lib/zeli/conversation/
  acts.ts          social and instruction recognition (greeting, help, refusal…)
  social.ts        deterministic local replies for those acts
  context.ts       follow-up rewriting from the previous turn
  clarify.ts       ambiguity detection

src/lib/zeli/providers/
  conversation-policy.ts   separate approval gate for message processing
  deepseek-conversation.ts fixed endpoint, sanitisation, validation, transport
  deepseek-chat.ts         tool-calling transport
  tool-orchestrator.ts     tool selection, execution, grounding validation
  conversation-provider.ts provider-neutral selection, limits, audit, fallback

src/lib/zeli/business-tools.ts
  read-only tool schemas, role filtering and execution against domain services
```

Provider selection is server-side only. The browser cannot choose a provider,
model, tenant or tool, and no provider credential is ever sent to the browser.

## 2a. Enhanced AI tool orchestration

When the conversational policy allows it, a business turn runs:

1. The model receives the fixed system prompt, bounded recent history (last six
   messages, 800 characters each, plus a one-line summary of dropped turns) and
   the current question.
2. The model must select a read-only tool (`tool_choice: required`) for a
   recognised business intent.
3. The server validates the tool name and strict arguments, checks role and
   tenant, and executes the existing domain service.
4. The model receives only the minimum facts and explains them.
5. Every numeric token in the final answer must match a number returned by a
   tool, within a small rounding tolerance. Otherwise the answer is rejected
   and the local deterministic answer is used.
6. The authoritative local calculation is appended, so facts and explanation
   are visibly separated.

No arbitrary SQL, database access or financial operation is exposed.

## 3. Turn order

1. Availability switch (`zeliAvailability`).
2. Conversation ownership and daily usage limit.
3. Load the last assistant turn's stored context.
4. Resolve a follow-up into a complete question, or detect a pending
   clarification.
5. Classify a financial instruction → refuse locally. No provider call.
6. Social act → try the external conversational provider if eligible; otherwise
   answer locally.
7. Business intent → external tool orchestration when policy allows; otherwise
   the local responder and authorized tools. Local data always remains
   authoritative.
8. Persist messages with intent, period, clarification state, context flag and
   mode.

## 4. External gate

`PRODUCTION_CONVERSATION_APPROVED` is a reviewed code constant and is `false`.
A request is allowed only when **all** of these hold:

1. Global emergency stop is off.
2. Global provider control is enabled and mode is `synthetic` or `approved`.
3. Approved provider is `deepseek`.
4. A credential is configured (checked as a boolean; the value is never read
   into a response).
5. `synthetic`: `ZELI_SYNTHETIC_TESTING_ALLOWED=true` in an approved test
   environment.
6. `approved`: reviewed conversation code approval, matching privacy policy
   version, approval reference and per-tenant authorization.
7. Per-user and per-tenant daily provider limits are not exhausted.
8. The circuit breaker for conversational calls is closed.

Any failure falls back to the local answer. The user is never told Zeli is
unavailable because external AI is off.

## 5. Transport controls

| Control | Value |
|---|---|
| Endpoint | `https://api.deepseek.com/chat/completions` (fixed constant) |
| Model | `deepseek-flash` or `deepseek-v4-pro` allow-list |
| Redirects | rejected (`redirect: "error"`) |
| Timeout | 20 seconds, `AbortController` |
| Max output tokens | 320 |
| Max response body | 64 KiB (declared and measured) |
| Streaming | disabled |
| Credential | server-only `DEEPSEEK_API_KEY`, never logged or returned |

## 6. Data actually transmitted

### Sent in external mode

**Conversational (social) turns** — simple adapter:

- The current user message, truncated to 1000 characters, after redaction of:
  emails, URLs, phone-like numbers, reference-like identifiers and every
  numeric token.
- A fixed system prompt that defines the assistant and its limits.

**Business turns** — Enhanced AI tool orchestration:

- The current question (up to 1500 characters).
- Bounded recent history: the last six user/assistant messages, each up to 800
  characters, plus a one-line summary of older turns.
- The tool catalogue for the user's role, and the minimum facts returned by the
  executed tool (aggregate totals, comparisons, or authorized customer/account
  fields for a lookup).
- A fixed system prompt.

Business turns are only orchestrated when the policy allows it. In production
that policy is disabled, so none of this is transmitted. The current authorized
use is the isolated staging environment with synthetic data.

### Never sent

- The full conversation history.
- Raw database rows, tables, statements or unrestricted records.
- Tenant id, user id, session data, authentication data or MFA data.
- Credentials, secrets or system configuration.
- The local authoritative answer text (it is generated after the provider call).

### Residual risk (must be accepted by the privacy assessment)

Redaction is a safeguard, not anonymisation. A free-text sentence can still
contain a person's name, a location, a health detail or a business fact that no
pattern catches. Production approval must cover this residual risk explicitly.

## 7. Prompt-injection and output-integrity controls

- User text is wrapped in `<user_message> … </user_message>`; a literal closing
  tag inside the text is neutralised.
- The system prompt states that the user message is untrusted data and that
  instructions inside it must be ignored.
- The output is rejected if it contains a URL, email, reference pattern,
  HTML/markup or control character.
- Social answers reject **any digit**. Enhanced business answers allow only
  numbers that were returned by an executed tool, within a small rounding
  tolerance. A fabricated figure is rejected and the local answer is used.
- Output length and type are validated before use.
- Provider errors, status codes and validation codes are audited without prompt
  or response content.

## 8. Audit and retention

Provider usage rows contain: request id, HMAC tenant/user references, role
category, provider, model, purpose (`conversation:<act>`), schema version,
decision, reason category, latency and token counts. They never contain the
message, the answer, a payload or a secret.

Conversation content stays in the local database under the existing ownership
and retention rules. Deleting a conversation deletes local messages. Provider-
side retention and deletion are contractual matters and remain unconfirmed.

## 9. Activation procedure (not performed)

1. Complete the decision pack in
   `ZELI-CONVERSATIONAL-PRIVACY-DECISION-PACK.md` and obtain owner/legal
   approval.
2. Sign a DPA and confirm cross-border transfer, retention and deletion terms.
3. Update the privacy notice and obtain the required tenant/user authorization.
4. Change `PRODUCTION_CONVERSATION_APPROVED` to `true` in a reviewed commit.
5. Set `ZELI_PRIVACY_POLICY_VERSION`, `ZELI_APPROVAL_REFERENCE`, the provider
   control row (`mode=approved`, provider `deepseek`, matching policy version)
   and the per-tenant authorization.
6. Verify in staging with synthetic messages only.
7. Run the provider-isolation tests and confirm the audit rows.

Do not set the code constant or any approval value without the signed
assessment. The repository must not contain invented approval identifiers.

## 10. Staging synthetic testing

Staging remains manual (`autoDeploy: false`). To exercise the external path with
synthetic data only:

1. In the staging dashboard set `ZELI_SYNTHETIC_TESTING_ALLOWED=true`.
2. Set the global provider control row to `mode=synthetic`, `enabled=true`,
   `emergencyDisabled=false`, provider `deepseek`.
3. Confirm the staging credential is configured (never print it).
4. Send only synthetic messages, for example "Hello, can you help me
   understand what a savings cycle is?".
5. Confirm the audit row records `success` without content.
6. Turn the flag and the control row off again.

**No live staging call was made by the agent for this change.** The repository
tests intercept `fetch` and assert the exact request shape; they do not contact
the provider. A real synthetic staging call requires owner execution of the
steps above.

## 11. Test evidence

`tests/zeli-deepseek-conversation.test.ts` covers:

- policy default-disabled, emergency latch, missing code approval, missing
  credential, synthetic environment flag;
- no production call with a key and an authorized tenant while approval is
  absent;
- credential never present in status or errors;
- redaction before transmission;
- fixed endpoint, redirect rejection, timeout mapping, HTTP failure,
  oversized response, invalid JSON, empty content, unsafe output;
- prompt-injection wrapping;
- no history, tenant id, user id or message content in the request;
- audit rows without content;
- local fallback on provider failure.

`tests/zeli-conversation.test.ts` covers the local conversational experience and
tenant isolation.
