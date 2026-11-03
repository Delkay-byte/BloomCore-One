# Zeli — Provider Setup

**Status in this release:** HARD-OFF. External AI processing is disabled.

## Current behaviour

- `getZeliProvider()` always returns the internal deterministic provider.
- `ZELI_PROVIDER` is ignored for provider selection.
- The DeepSeek adapter is retained only as a future integration surface.
- `available()` always reports disabled; `generate()` throws before constructing
  a request or touching `fetch`.
- No key, approval flag, health check or background request can activate it.
- The platform provider panel has no activation toggle.

Owner-facing status:

> External AI processing is currently disabled. Zeli's private analytics and
> local intelligence features remain available.

## Environment variables

| Variable | Purpose in this release |
|---|---|
| `ZELI_PROVIDER` | Diagnostic only. `deepseek` is displayed as disabled. |
| `ZELI_DEEPSEEK_APPROVED` | Ignored. Cannot enable processing. |
| `DEEPSEEK_API_KEY` | Ignored. Never read for a request. Presence is shown only as a boolean. |
| `DEEPSEEK_MODEL` | Not used. |
| `DEEPSEEK_BASE_URL` | Not used. |
| `ZELI_GATEWAY_MIN_COHORT` | Optional gateway minimum; clamped to at least 5. |

Do not add any provider credential to staging or production during this phase.

## Future approval procedure (do not skip)

1. Complete a DPIA and purpose-specific privacy assessment.
2. Obtain written owner approval and any required data processing agreement.
3. Define the approved metrics, period granularity and minimum cohort.
4. Implement and test the gateway allow-list and audit.
5. Change `EXTERNAL_AI_PHASE` to `"approved"` in a reviewed commit.
6. Add the approval identifier and credential to the approved environment only.
7. Run provider-isolation tests with outbound HTTP interception.
8. Verify failure, timeout, retry and disable behaviour in staging.
9. Obtain independent security/privacy sign-off before production.

## Future integration constraints

- Only gateway-approved aggregate payloads may be sent.
- Never send names, phone numbers, emails, account numbers, staff/customer ids,
  payment/transaction references, precise location, raw rows, customer notes,
  documents, authentication data, MFA data or conversation history.
- A payload belongs to exactly one tenant.
- The provider cannot be selected by the browser.
- The internal engine must remain fully functional if the provider is absent.

## Local model option (evaluated, not deployed)

Ollama or an OpenAI-compatible local server can be trialled without paid GPU
resources, but:

- CPU inference latency is high for useful multi-metric explanations;
- memory requirements depend on model size;
- Render web instances are not suitable inference hosts;
- a separate inference service needs network isolation and access control;
- model licences must be reviewed;
- tenant isolation and prompt-injection handling still apply.

No paid infrastructure was provisioned. The application does not depend on a
local model.
