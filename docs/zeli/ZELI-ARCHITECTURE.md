# Zeli — Architecture

**Last updated:** 3 November 2026.

## High-level layout

```
Browser
  ├─ /zeli                                  conversational workspace
  ├─ /admin/zeli-analytics                  entitled tenant analytics
  ├─ /admin/zeli-analytics/upgrade          denial screen
  ├─ /platform/zeli                         platform control centre
  └─ /api/zeli/analytics/export             aggregate CSV

Server
  ├─ src/lib/zeli/entitlements.ts           access matrix + guards
  ├─ src/lib/zeli/intelligence/
  │    ├─ period.ts                         UTC reporting windows
  │    ├─ metrics.ts                        authoritative aggregation + refresh
  │    ├─ insights.ts                       deterministic detectors
  │    ├─ compose.ts                        template response composition
  │    ├─ intents.ts                        intent classification
  │    └─ responder.ts                      providerless answers
  ├─ src/lib/zeli/gateway.ts                outbound privacy gateway (deny by default)
  ├─ src/lib/zeli/provider-policy.ts        hard-off external provider policy
  ├─ src/lib/zeli/service.ts                conversation turn orchestration
  ├─ src/lib/zeli/tools.ts                  existing read-only role tools
  └─ src/lib/actions/zeli-analytics.actions.ts
      src/lib/actions/zeli-platform.actions.ts
```

## Data flow — analytics

1. The page or action calls `requireZeliAnalyticsContext`.
2. The guard resolves the tenant from the session (`getTenantContext("admin")`),
   checks `role = admin`, then evaluates the entitlement.
3. `resolvePeriod` turns the approved filter into UTC half-open boundaries. A
   custom range is validated and bounded.
4. `buildAnalyticsSnapshot` refreshes or reads `ZeliAnalyticsDaily` buckets for
   the selected and preceding periods.
5. Source queries are always bounded by `tenantId` and the period. Reversed
   contributions, withdrawals and remittances are excluded.
6. Detectors produce insights; templates produce explanations.
7. The response includes period, source, freshness, calculation and limitations.

## Aggregate refresh

- Table: `ZeliAnalyticsDaily`, unique key `(tenantId, scope, businessDate)`.
- `scope` is `"all"` or a validated location id.
- Refresh is an upsert: duplicate processing cannot double-count.
- `ZeliAnalyticsRefresh` records success/failure, row count and duration.
- TTL is 60 seconds. The Refresh button forces a rebuild.
- If a rebuild fails, the last successful rows are served with a stale warning
  and a retry path.
- This is periodic/on-demand refresh, **not** real-time streaming.

## Data flow — conversational workspace

```
question
  → classifyIntent
  → if admin: buildAnalyticsSnapshot → compose/explain
  → if role tool question: read-only tool registry → deterministic formatter
  → if unsupported: limitation message
  → persist user + assistant messages (tenant/user scoped)
```

No provider selection is read from the environment. `getZeliProvider()` always
returns the internal deterministic provider. The DeepSeek adapter exists but is
inert.

## Data flow — future external provider (disabled)

```
allow-listed aggregate payload
  → evaluateOutboundPayload (strict schema, forbidden fields, identifiers)
  → small-group suppression
  → submitOutboundPayload
  → denied while EXTERNAL_AI_PHASE = "disabled"
  → decision audited without payload values
```

## Authorization boundaries

| Boundary | Authority |
|---|---|
| Tenant analytics | tenant admin session + live entitlement |
| Tenant navigation | server-resolved `/api/auth/me` value; rechecked by page/action |
| Platform control centre | separate platform cookie and `PlatformSuperAdmin` table |
| Conversation | `tenantId + userId` ownership on every read/write |
| Export | same entitlement guard before any query |
| Gateway | server-side only; no browser path |

## Database additions

- `ZeliEntitlement` — one row per tenant/feature.
- `ZeliEntitlementEvent` — append-only lifecycle history with reasons.
- `ZeliAnalyticsDaily` — tenant/scope/day aggregate.
- `ZeliAnalyticsRefresh` — freshness and failure bookkeeping.
- `ZeliProviderGatewayEvent` — privacy gateway decisions, no payload values.

Migration: `prisma/migrations/20261103_zeli_business_intelligence/migration.sql`.

## Calculation conventions

- Monetary values are rounded to two decimals at the API boundary.
- Period boundaries are UTC and half-open `[start, endExclusive)`.
- `netCashFlow = contributions + daily-account cash income − withdrawals − expenses`.
- `withdrawals` use `netAmount` from completed, non-reversed rows.
- Branch attribution follows the recording user's assigned location, or the
  collector's assigned location for collector collections.
- Active accounts are distinct accounts with at least one non-reversed
  contribution in the period.

## Local model evaluation (not deployed)

Ollama was evaluated as a future optional provider:

- small CPU-only models can run locally, but latency and quality are not
  sufficient for reliable financial explanation without evaluation;
- GPU hosting adds cost and operational burden; no paid GPU resource was
  provisioned;
- Render's standard web service is not an inference host;
- a separate inference service would need network isolation, authentication,
  tenant-aware prompts and the same outbound review;
- model licences must be reviewed before distribution.

The product therefore has no model dependency. A local model may be added later
behind the same gateway and a new approval.
