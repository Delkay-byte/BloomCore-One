# Zeli — Complete Product Specification

**Status:** Development complete for this milestone; production untouched.
**Last updated:** 4 November 2026.

## Product surfaces

| Surface | Route | Access |
|---|---|---|
| Zeli Assistant | `/zeli` | Existing tenant roles, provider-neutral |
| Zeli Business Intelligence | `/admin/zeli-analytics` | Tenant admin + live entitlement |
| Subscription checkout | `/admin/zeli-analytics/upgrade` | Tenant admin without a live entitlement |
| Checkout return | `/admin/zeli-analytics/checkout/callback` | Tenant admin; server-verified reference |
| Platform Zeli control | `/platform/zeli` | Platform Super Admin only |
| Paystack webhook | `/api/payments/paystack/webhook` | Paystack signature only |
| Analytics export | `/api/zeli/analytics/export` | Entitled tenant admin |

## Implemented capabilities

### Subscription commerce

- Owner-configured package catalogue: code, name, description, interval,
  price, currency, features, usage allowance, trial policy, optional provider
  plan code, status and public availability.
- Server-created checkout with the database price; client amounts are ignored.
- Paystack initialize + fixed approved endpoint.
- HMAC SHA-512 webhook verification and unique event ledger.
- Duplicate webhook and callback idempotency.
- Entitlement activation only from a verified payment event.
- Refund suspension, cancellation at period end, failed/pending states.
- Platform reconciliation.
- Optional owner-configured trial for a business that has never subscribed.
- Platform package management, subscription list and gross recorded value.

### Global external AI

- Disabled, synthetic and approved production states.
- Database control plus reviewed code approval constant.
- Emergency stop overrides every setting.
- Synthetic mode requires an environment permission and accepts only marked
  synthetic packages.
- Approved production remains locked without code approval, privacy version,
  approval reference and tenant authorization.
- Global switch is checked server-side before every request.

### DeepSeek integration

Two separate, separately gated uses:

**Aggregate explanation (implemented earlier).**

- Fixed official endpoint `https://api.deepseek.com/chat/completions`.
- `deepseek-flash` default (or `deepseek-v4-pro`).
- Server-only key, strict timeout, bounded response size and token cap.
- Redirects disabled.
- Aggregate-only insight package; no conversation or raw user text.
- JSON output validated; any number, date, identifier, URL or fabricated
  financial claim is rejected.
- Local authoritative facts inserted after validation.
- Provider failure never breaks the private analytics workspace.
- Per-user and per-tenant daily limits, circuit breaker, usage accounting.
- Audit stores decisions, categories, latency and tokens, never prompts/values.

**Conversational reasoning (new, disabled in production).**

- Separate policy and code gate (`PRODUCTION_CONVERSATION_APPROVED = false`).
- One sanitised user message only: no history, records, identifiers, tenant id
  or user id. Numbers, emails, phones and references are redacted first.
- Only non-financial messages may use it. Business figures are always answered
  locally.
- Output rejected if it contains any digit, link, email, reference or markup, so
  the model cannot introduce a financial figure.
- Fixed endpoint, redirect rejection, timeout, response-size bound and strict
  validation.
- Falls back to the local assistant on any failure.
- Requires a completed DPIA/privacy decision pack before activation.

### Conversational assistant (local)

- Greeting, help, identity, thanks and small talk.
- Deterministic follow-up resolution from the previous turn.
- One clarifying question for ambiguous requests, with the answer remembered.
- Financial-instruction refusal: Zeli is read-only.
- Income and expenses intent.
- Honest limitation for general knowledge in local mode.
- Role-aware capability lists and tool permissions.

### Advanced intelligence

- Existing financial, remittance, branch, customer and exception insights.
- New dormant-account, contribution-consistency, reporting-gap and collector
  workload insights.
- Recommendations carry title, explanation, evidence source, period,
  investigation, confidence, limitations and human-action flag.
- No fraud or misconduct conclusion.

### Safe workflows

- Read-only explanations, correction navigation, exception summaries and
  operational checklists.
- No autonomous financial posting, approval, reversal or permission change.

## Deliberate limitations

- Paystack recurring plans are optional; without a provider plan code renewal is
  a new checkout. Renewal is not silently charged by BloomCore.
- Trial policy is owner-configured and available only to a business with no prior
  subscription or entitlement.
- Revenue shown on the platform is gross recorded value, not settled provider
  revenue.
- Hosted staging is deployed and internally verified at
  `bloomcore-one-staging.onrender.com`; production deployment remains off.
- Production external AI and production deployment remain off.
