# Provider failure and timeout verification

Date: 25 November 2026. Release remains **HELD**. No live provider call was made.

## 1. Exact unverified scenario

The previous scenario catalogue recorded 17 expected outcomes and one
unverified case: a provider timeout during an external operation. The relevant
integrations are Paystack (MoMo charge/refund), Resend (email), DeepSeek/Zeli
(AI insight) and the Cloudflare Turnstile site-verification call.

`Verified in code`: Paystack uses a fixed `https://api.paystack.co` base URL;
Resend and DeepSeek use fixed provider hosts. There is no injectable provider
endpoint, so a deterministic local timeout cannot be driven through the real
application code path without adding a test-only transport seam.

## 2. Deterministic local stub (`Verified in code`)

`scripts/local-load/provider-mocks.mjs` starts a loopback-only stub on
`127.0.0.1:5599` and can emit, per request:

- connect timeout / read timeout;
- connection reset;
- `429` with `Retry-After`;
- `5xx`;
- malformed JSON / body over the size bound;
- delayed success response (ambiguous outcome: action may have completed but
  the response was lost).

The stub never contacts a real provider and uses synthetic bodies only. It is
available for a future test-only transport seam.

## 3. Existing code behaviour reviewed (`Verified in code`)

- Paystack distinguishes definite rejection from ambiguous outcomes (409,
  timeout, malformed, 5xx) and records reconciliation-required state. It never
  treats `pay_offline` as paid and only marks a refund processed when Paystack
  confirms it. Responses are size-bounded and provider messages are sanitised.
- Resend treats missing configuration, `429`, `5xx` and timeouts as retryable
  without logging provider bodies.
- Turnstile fails closed on missing token, timeout, mismatch and replay, with
  exactly one safe retry after a transport failure.
- Risk/governance writes use tenant-scoped idempotency keys; no blind retry of
  a non-idempotent financial operation was added.

## 4. What remains unverified

End-to-end verification through the actual application transport for each
stubbed failure mode is **Unverified**: it requires a reviewed test-only
transport seam that permits a loopback endpoint only when `NODE_ENV=test` and
the URL is explicitly loopback. Adding that seam was not done in this pass to
avoid changing production provider trust boundaries without owner review.

Status: stub prepared; application-path verification remains an owner-approved
engineering follow-up. No duplicate financial record or false success was
observed in the local journeys that were executed.
