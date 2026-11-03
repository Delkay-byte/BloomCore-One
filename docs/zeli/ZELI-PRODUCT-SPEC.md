# Zeli — Product Specification

**Product:** Zeli, the BloomCore One business intelligence and operations
assistant.
**Company:** BloomCore Technologies.
**Tagline:** One platform. Clearer control.
**Last updated:** 3 November 2026.

## Product surfaces

| Surface | Route | Audience | Status |
|---|---|---|---|
| Zeli Assistant (conversational) | `/zeli` | Tenant admins, workers, collectors, customers | Implemented, providerless |
| Zeli Business Intelligence | `/admin/zeli-analytics` | Entitled tenant owner/admin | Implemented |
| Entitlement denial/upgrade screen | `/admin/zeli-analytics/upgrade` | Tenant admin without a live entitlement | Implemented |
| Zeli control centre | `/platform/zeli` | Platform Super Admin only | Implemented |
| Analytics export | `/api/zeli/analytics/export` | Entitled tenant admin | Implemented |
| Correction screen | `/admin/history/[id]/correct` | Tenant admin with MoMo | Implemented (security closeout) |

## Core promise

Zeli delivers useful business intelligence without depending on an external
language model:

- authoritative financial totals come from BloomCore One domain tables;
- explanations come from deterministic templates and detected patterns;
- charts come from server-computed aggregates;
- the conversational workspace answers a defined set of intents from authorized
  records;
- every answer is labelled as calculated fact, detected pattern, automated
  interpretation, suggested action or unverified hypothesis;
- no request is sent to DeepSeek or any other external AI provider in this
  release.

## Zeli Assistant (`/zeli`)

Preserved capabilities:

- conversation creation, history, rename, delete;
- streaming response transport (one completed answer, not a simulated typing
  animation);
- stop, copy and feedback;
- server-resolved ownership and tenant scope;
- per-user daily request limit;
- source links;
- role-aware suggested prompts.

Supported intents for tenant administrators:

1. Summarise today's or the period's business activity.
2. Compare this month with last month, or week with week.
3. Summarise contributions and withdrawals.
4. Summarise remittance activity and variance.
5. Show outstanding operational exceptions.
6. Compare branch performance.
7. Explain why a metric changed (rule-based, no causal claim).
8. Explain how a reported metric is calculated.
9. Explain a financial chart.
10. Find an authorized customer or account (read-only tool).
11. Show daily-account status and variance.

Unsupported questions receive a limitation message listing the supported
intents. Zeli does not invent an answer.

Workers, collectors and customers keep their existing role-scoped summaries.
They cannot obtain tenant-wide analytics through the chat.

## Zeli Business Intelligence (`/admin/zeli-analytics`)

### Header and filters

- Business name and tenant code.
- Selected period and branch.
- Last successful refresh, auto-refresh interval and stale-data warning.
- Refresh action.
- CSV export of aggregate figures.

Server-validated periods: today, yesterday, this week, previous week, this month,
previous month, this quarter, and a bounded custom range (maximum 366 days, not
in the future).

### KPI cards

- Contributions and contribution count.
- Withdrawals (net) and completed count.
- Net cash flow.
- Open operational exceptions.
- Remittances and net variance.
- Expenses.
- Active accounts.
- Transaction volume and new customers.

Each financial card states the currency (GHS), period and calculation source in
the surrounding dashboard copy and reconciliation panel.

### Charts

- Contributions and withdrawals over time.
- Income versus expenses.
- Net cash-flow trend.
- Remittance trend.
- Daily transaction activity.
- Branch performance.
- Customer activity (new customers versus active accounts).

Every chart has a Zeli explanation action and an accessible text summary. Empty,
loading, stale and error states are explicit. No sample data is used in
production.

### Explanations and recommendations

Each explanation carries the period, source, freshness, limitations and the
statements above. Recommendations are safe, read-only next steps. Zeli never
executes a financial action automatically.

## Subscription and entitlement

The feature key is `zeli_analytics`. Access requires:

- an authenticated tenant administrator (`role = admin`), and
- a live entitlement (`status = active`, started, not expired), and
- an active, operable tenant.

Workers, collectors and customers are denied by default. Platform Super Admins
use the separate platform control centre.

There was no pre-existing billing/subscription subsystem in the repository.
Zeli Analytics therefore integrates with the existing tenant entitlement model
through one audited `ZeliEntitlement` table. No second billing architecture was
created. No price, plan or checkout was invented.

## Explicitly out of scope / not implemented

- Automatic add-on billing or payment-provider checkout.
- External AI processing, including DeepSeek.
- Autonomous financial posting, approval, reversal or permission changes.
- Self-hosted model deployment.
- Real-time streaming aggregation (aggregates refresh on demand with a short
  TTL).
