# Export endpoint rate-limit remediation

Date: 25 November 2026. Release remains **HELD**. No production target used.

## 1. Verified pre-change state (`Verified in code`)

| Route | Guard | Scope | Cost before change | Limit before change |
| --- | --- | --- | --- | --- |
| `/api/zeli/analytics/export` | `getApiZeliAnalyticsContext()` (admin + live entitlement) | `ctx.tenantId` | unbounded series, branch rows and insights | none |
| `/api/association/export` | action-level `requireTenantAdmin()` | every query filtered by `ctx.tenantId` | full un-paginated `findMany`, includes contact details | none |
| `/api/audit` | `getApiTenantContext("admin")` + role check | `where.tenantId = ctx.tenantId`, max 100/page | bounded JSON | none |

## 2. Implemented design (`Verified in code`)

`src/lib/security/export-rate-limit.ts` uses the existing database-backed
`consumeRateLimit()` infrastructure. Bucket identifier is
`<authenticated actor id>|<server-resolved tenant id>`, hashed with the existing
keyed HMAC secret. No raw token, email, IP or client-controlled identifier is
stored, and a query parameter cannot switch buckets.

| Route | Sustained | Short burst | Rationale |
| --- | --- | --- | --- |
| Zeli analytics CSV | 30 / 10 min | 4 / 10 s | heavy aggregate build; legitimate ad-hoc review is a few per session |
| Association CSV | 20 / 10 min | 3 / 10 s | un-paginated member/contact data export |
| Audit JSON | 120 / 10 min | 12 / 10 s | already paginated at 100 rows, so a higher ceiling is appropriate |

The short burst bucket is database-backed across instances and bounds
concurrent expensive work without a process-local counter. A blocked request
returns `429` with a positive `Retry-After` and `Cache-Control: no-store`; no
counter value or policy detail is disclosed. Authorisation runs before any
quota is consumed on all three routes.

`src/lib/security/rate-limit.ts` was corrected so an atomic increment now
returns the caller's own count. Previously concurrent callers could all read
the same final count and over-block legitimate traffic. This only strengthens
fairness; the fail-closed behaviour on counter-store errors is unchanged.

## 3. Tests (`Verified in code`)

`tests/export-rate-limit.test.ts` covers unauthenticated-equivalent denial at
the route level (route guards unchanged), normal use, burst exhaustion,
sustained exhaustion, rolling window reset, tenant isolation, actor isolation,
concurrent requests and HMAC-only key storage. Result: **6/6 passed**.

Command: `npx vitest run tests/export-rate-limit.test.ts`.

Security-header tests for forged forwarding headers live in
`tests/security-hardening-round2.test.ts` and
`tests/security-hardening.test.ts`; both were updated for the new edge-proof
rule and pass.

## 4. Unverified / owner action

- Production traffic volumes are not available, so the ceilings are
  conservative defaults derived from operation cost, not invented benchmark
  figures. The owner may adjust them after observing real usage.
- Behaviour across multiple live Render instances is inferred from the shared
  database design and local tests; live multi-instance verification is
  `Unverified` and remains an owner action after release authorisation.
