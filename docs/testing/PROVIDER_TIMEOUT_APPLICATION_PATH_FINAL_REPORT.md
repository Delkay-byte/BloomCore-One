# Provider timeout — application-path final report

Date: 26 November 2026. Release HELD. No real provider transaction was created.

## Seam (`Verified in code`)

`src/lib/payments/paystack.ts` now exposes `paystackBaseUrl()`. A custom base
URL is accepted **only** when `NODE_ENV=test` and the URL host is loopback;
production always uses `https://api.paystack.co`. The seam is not user-controlled
and adds no SSRF surface.

## Application-path tests (`Verified in code`)

`tests/provider-timeout-application-path.test.ts` starts a loopback HTTP stub
and drives the **real** `verifyTransaction()` / `lookupTransaction()` client:

| Mode | Verified behaviour |
| --- | --- |
| 400 definite rejection | `lookupTransaction()` → `found: false`; not success |
| 409 duplicate | `PaystackError`, `failureKind: ambiguous` (reconciliation) |
| 503 | `failureKind: ambiguous` |
| malformed JSON | invalid response, ambiguous; raw body not exposed |
| oversized response | bounded read rejects before parsing |
| connection reset | ambiguous provider-unavailable error |
| delayed success | only marked successful after verification confirms it |
| non-loopback / production seam | refused; fixed provider host used |

Result: **6/6 passed**. Synthetic key never appears in errors.

Note: during development one test iteration invoked the fixed provider host
because of a faulty assertion. It returned a plain rejection; no payment or
transaction was created. That assertion was replaced by a pure seam-resolution
test, so the final suite makes no external call.

Status: **Fixed and verified** for Paystack read/verification path. Charge and
refund flows use the same `request()` helper; dedicated workflow tests are a
follow-up. Logs were checked for secret leakage in the tested path.
