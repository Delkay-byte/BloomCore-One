# Zeli — Advanced Reasoning

## Hybrid model

BloomCore One remains authoritative for:

- intent recognition;
- authorization and tenant isolation;
- date interpretation;
- record retrieval and entity resolution;
- financial and operational calculations;
- insight generation and evidence;
- response validation;
- final wording of numbers.

DeepSeek, when an approved state permits it, only adds qualitative explanation
for an already-computed aggregate insight.

## Local path

Every supported question works with no provider:

1. classify the intent locally;
2. resolve the tenant and role from the session;
3. build the reporting period;
4. aggregate authoritative records;
5. detect rule-based patterns;
6. compose a labelled answer;
7. return period, source, freshness and limitations.

## Provider path

1. use only the local snapshot;
2. build a typed insight package (bands, directions, categories);
3. check global policy, tenant authorization, purpose, limits and circuit;
4. validate the package with the gateway;
5. call the fixed DeepSeek endpoint;
6. validate the JSON and reject numeric/identifier claims;
7. append a clearly labelled external explanation;
8. keep local facts authoritative.

The raw user prompt is never forwarded. Conversation history is never sent.

## Supported intents

- period summary and comparison;
- contributions and withdrawals;
- remittances and variance;
- operational exceptions;
- branch comparison;
- chart explanation;
- why a metric changed;
- metric definition;
- customer/account lookup (authorized tool);
- daily-account status.

Unsupported requests get a limitation and supported alternatives, not an
invented answer.

## Failure behaviour

| Failure | User sees |
|---|---|
| Provider disabled/synthetic | Local answer |
| Missing key / policy denial | Local answer |
| Timeout/network/HTTP error | Local answer |
| Circuit open | Local answer |
| Gateway rejection | Local answer; decision audited |
| Invalid/fabricated output | Local answer; rejection audited |

No failure changes an entitlement, financial record or analytics figure.
