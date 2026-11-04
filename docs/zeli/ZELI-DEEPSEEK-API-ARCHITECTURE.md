# Zeli — DeepSeek API Architecture

**Production state:** disabled. **Synthetic live verification:** PASSED on staging with a fixed synthetic package. Production processing remains locked.

## Official provider contract

Source: <https://api-docs.deepseek.com/>

| Item | Value |
|---|---|
| Endpoint | `POST https://api.deepseek.com/chat/completions` |
| Auth | `Authorization: Bearer <server-side key>` |
| Model | `deepseek-flash` (default) or `deepseek-v4-pro` |
| Response format | `json_object` |
| Thinking | `disabled` |
| Temperature | `0.2` |
| Max output | 700 tokens |
| Stream | `false` |
| Redirects | rejected |

The model identifier is allow-listed. Arbitrary base URLs and user-supplied
endpoints are impossible: the adapter has one constant.

## Request shape

Only a validated `InsightPackage` is sent:

- purpose;
- reporting granularity and comparison label;
- allow-listed metric names;
- direction and change band;
- cohort band;
- approved category names;
- schema version;
- optional synthetic marker.

No names, account numbers, exact values, dates, transaction rows, notes,
conversation history, tenant id or raw question.

## Response validation

The provider must return strict JSON:

```json
{
  "explanation": "...",
  "observed_pattern": "...",
  "interpretation": "...",
  "suggested_investigation": "...",
  "limitations": "..."
}
```

Validation rejects:

- extra properties;
- missing/short fields;
- any digit (amounts, percentages, dates, identifiers);
- emails, URLs, long opaque ids;
- fabricated citations or source names.

A rejected response is discarded and the local answer is returned. Provider
output is displayed under `[EXTERNAL EXPLANATION · VALIDATED · AGGREGATE-ONLY]`.
The authoritative local answer remains above/below it and cannot be changed.

## Three states

### Disabled

No request. No provider selection. Local engine only.

### Synthetic

- Control mode `synthetic`.
- `ZELI_SYNTHETIC_TESTING_ALLOWED=true`.
- Server key present.
- Only packages with `synthetic: true`.
- Fixed probe package contains no tenant data.
- Normal user requests remain local.

### Approved production

Requires all of:

1. `PRODUCTION_PROVIDER_APPROVED = true` in reviewed code.
2. Control mode `approved` and not emergency-disabled.
3. `DEEPSEEK_API_KEY` present server-side.
4. Privacy policy version equals the control record.
5. Non-empty approval reference.
6. Tenant authorization record enabled.
7. Gateway approval and cohort threshold.

Missing any one rejects the request. The current code constant is **false**.

## Failure handling

- Timeout: 25 seconds.
- Oversized response: rejected before parsing.
- Invalid JSON/content: rejected.
- Provider HTTP error: safe local fallback.
- Circuit opens after repeated failures.
- Failed request never breaks the analytics page.
- No retry for policy/gateway/schema rejection.
- No silent provider fallback to another vendor.

## Secrets

`DEEPSEEK_API_KEY` is read only in server modules. It is never returned to the
browser, embedded in HTML, logged, or included in errors. The platform shows
only whether a credential exists.

## Live verification status

A staging-only key was configured. The fixed synthetic probe returned success:
2002 ms, 257 input tokens, 190 output tokens, model `deepseek-flash`. Audit
recorded decision `success` without prompt or payload content. A normal tenant
chat during synthetic mode made no provider request. Emergency stop was applied,
the environment permission was returned to false, and the service redeployed;
provider usage did not increase afterwards.

Mocked integration tests additionally prove:

- fixed endpoint and model;
- synthetic-only package;
- no request when policy denies;
- output validation;
- timeout/error paths;
- no tenant identifiers in the body.

A live synthetic probe must be run by the owner from an approved environment
with `ZELI_SYNTHETIC_TESTING_ALLOWED=true` and synthetic mode enabled.
