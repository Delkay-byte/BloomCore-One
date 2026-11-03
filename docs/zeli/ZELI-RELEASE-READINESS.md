# Zeli — Release Readiness

## Status

- **Functional readiness:** READY WITH LIMITATIONS — read-only assistant,
  mock provider, conversation persistence, role-aware context.
- **External-provider readiness:** BLOCKED — DeepSeek requires written DPA/
  privacy approval and a secret key. Adapter is built and tested with mocks.
- **Production release readiness:** NOT AUTHORIZED — no production deployment in
  this assignment.

## Available now

Read-only business summaries, customer lookup, collector/worker/customer
context, conversations, streaming transport, feedback, usage limit, provider
status.

## Disabled pending owner action

DeepSeek external processing. `ZELI_PROVIDER=deepseek` without
`ZELI_DEEPSEEK_APPROVED=true` or a key returns a clear unavailable message.

## Not implemented

Financial write actions, voice, uploads, external retrieval/vector store,
conversation export, per-tenant AI billing.

## Before release

1. Security PR merged and migration rehearsed.
2. Zeli DB migration rehearsed on a restored dataset.
3. Provider decision documented; mock default remains unless approved.
4. UI review on desktop/tablet/mobile.
5. Synthetic two-tenant test on staging.
6. Owner sign-off.
